import { Router, type Request } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import * as authService from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { hasRecentAuth, markRecentAuth } from '../middleware/recentAuth.js';
import { logoutOtherDevices } from '../services/authSessionService.js';
import { authLimiter, loginAccountLimiter, registerLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';
import { isDisposableEmail } from '../services/emailValidation.js';
import { audit, auditAuthFailure } from '../services/audit/audit.js';
import { authUserId, getAuth } from '../middleware/authContext.js';
import { serverFeatures } from '../services/features.js';

const googleClient = new OAuth2Client();

const GOOGLE_EMAIL_UNVERIFIED_MESSAGE =
  'この Google アカウントのメールアドレスは Google で確認されていないため、ログインに使えません。' +
  'Google でメールアドレスの確認を済ませてから、もう一度お試しください。';

const router = Router();

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function markFreshLogin(req: Request): void {
  const now = Date.now();
  req.session.issuedAt = now;
  req.session.touchedAt = now;
  req.session.sudoAt = now;
  req.session.adminSeenAt = now;
}

const registerSchema = z.object({
  email: z
    .string()
    .email('有効なメールアドレスを入力してください')
    .refine((e) => !e.toLowerCase().endsWith('@removed.local'), {
      message: 'このドメインは使用できません',
    })
    .refine((e) => !isDisposableEmail(e), {
      message: '使い捨てメールアドレスは登録に使用できません。常用のメールアドレスをご利用ください。',
    }),
  password: z.string().min(8, 'パスワードは8文字以上必要です'),
  displayName: z.string().min(1).max(100).optional(),
  code: z.string().trim().max(64).optional(),
  setupCode: z.string().trim().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/register', authLimiter, registerLimiter, async (req, res, next) => {
  try {
    const { email, password, displayName, code, setupCode } = registerSchema.parse(req.body);
    const user = await authService.register(email, password, displayName, code, setupCode);

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    await audit('signup', { actor: { id: user.id, email: user.email, authMethod: 'password' } }, req);

    res.status(201).json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      features: serverFeatures(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await authService.login(email, password);

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'password' } }, req);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      features: serverFeatures(),
    });
  } catch (err) {
    auditAuthFailure('login.failure', 'password', err, req);
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  const userId = getAuth(req)?.userId;
  if (userId) void audit('logout', { actor: { id: userId, email: getAuth(req)?.email ?? null } }, req);
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(authUserId(req));
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      features: serverFeatures(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout-others', requireAuth, async (req, res, next) => {
  try {
    const result = await logoutOtherDevices(authUserId(req), req.sessionID);
    await audit('logout.others', { detail: result }, req);
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

const sudoSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  credential: z.string().min(1).max(4096).optional(),
});

router.get('/sudo', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(authUserId(req));
    res.json({ active: await hasRecentAuth(req), method: user?.passwordHash ? 'password' : 'google' });
  } catch (err) {
    next(err);
  }
});

router.post('/sudo', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { password, credential } = sudoSchema.parse(req.body);
    const userId = authUserId(req);
    const user = await authService.getUserById(userId);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    let ok = false;
    let method: 'password' | 'google' = 'password';
    if (password && user.passwordHash) {
      ok = await authService.verifyPassword(user, password);
    } else if (credential && user.googleId) {
      method = 'google';
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId) {
        const ticket = await googleClient
          .verifyIdToken({ idToken: credential, audience: clientId })
          .catch(() => null);
        const payload = ticket?.getPayload();
        ok = !!payload && payload.sub === user.googleId && authService.isGoogleEmailVerified(payload);
      }
    }
    if (!ok) {
      await audit('auth.sudo', { result: 'failure', detail: { method } }, req);
      res.status(401).json({ error: 'reauth_failed', message: method === 'google' ? 'Google アカウントを確認できませんでした' : 'パスワードが正しくありません' });
      return;
    }
    await markRecentAuth(req);
    await audit('auth.sudo', { detail: { method } }, req);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const forgotPasswordSchema = z.object({
  email: z.string().email('有効なメールアドレスを入力してください'),
});

router.post('/forgot-password', passwordResetLimiter, async (req, res, next) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    await authService.requestPasswordReset(email);
    await audit('password.reset', { actor: { email: email.trim().toLowerCase() }, detail: { stage: 'request' } }, req);
    res.json({ ok: true, message: 'リセットメールを送信しました' });
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'トークンが必要です'),
  newPassword: z.string().min(8, 'パスワードは8文字以上必要です'),
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const userId = await authService.resetPassword(token, newPassword);
    await audit('password.reset', { actor: { id: userId ?? null }, detail: { stage: 'complete' } }, req);
    res.json({ ok: true, message: 'パスワードをリセットしました' });
  } catch (err) {
    auditAuthFailure('password.reset', 'reset_token', err, req);
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '現在のパスワードを入力してください'),
  newPassword: z.string().min(8, '新しいパスワードは8文字以上必要です'),
});

router.post('/change-password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const userId = authUserId(req);
    await authService.changePassword(userId, currentPassword, newPassword);
    await audit('password.change', { actor: { id: userId } }, req);
    res.json({ ok: true, message: 'パスワードを変更しました' });
  } catch (err) {
    auditAuthFailure('password.change', 'password', err, req);
    next(err);
  }
});

const googleLoginSchema = z.object({
  credential: z.string().min(1, 'Google認証情報が必要です'),
  code: z.string().trim().max(64).optional(),
  setupCode: z.string().trim().max(64).optional(),
  confirmRegistration: z.boolean().optional(),
});

router.get('/google/client-id', (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  res.json({ clientId });
});

router.get('/signup-status', async (_req, res, next) => {
  try {
    res.json({ mode: (await authService.isAwaitingFirstAdmin()) ? 'first_admin' : 'invite_only' });
  } catch (err) {
    next(err);
  }
});

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { credential, confirmRegistration, code, setupCode } = googleLoginSchema.parse(req.body);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      res.status(500).json({ error: 'Google認証が設定されていません' });
      return;
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      res.status(401).json({ error: 'Google認証に失敗しました' });
      return;
    }
    if (!authService.isGoogleEmailVerified(payload)) {
      res.status(403).json({ error: GOOGLE_EMAIL_UNVERIFIED_MESSAGE, code: 'google_email_unverified' });
      return;
    }

    const existing = await authService.findExistingByGoogle(payload.sub, payload.email);

    if (!existing && !code && !(await authService.isAwaitingFirstAdmin())) {
      res.status(403).json({ error: authService.INVITE_REQUIRED_MESSAGE, code: 'invite_required' });
      return;
    }

    if (!existing && confirmRegistration !== true) {
      res.json({
        needsRegistration: true,
        email: payload.email,
        name: payload.name ?? null,
      });
      return;
    }

    const { user, created } = existing
      ? { user: existing, created: false }
      : await authService.findOrCreateByGoogle(
          payload.sub,
          payload.email,
          payload.name,
          code,
          setupCode,
        );

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    if (created) await audit('signup', { actor: { id: user.id, email: user.email, authMethod: 'google' } }, req);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'google' } }, req);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      created,
      features: serverFeatures(),
    });
  } catch (err) {
    auditAuthFailure('login.failure', 'google', err, req);
    next(err);
  }
});

export default router;
