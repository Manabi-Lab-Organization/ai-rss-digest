import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { deleteUserAccount } from '../services/accountDeletionService.js';
import { audit } from '../services/audit/audit.js';
import { authUserId } from '../middleware/authContext.js';
import { requireRecentAuth } from '../middleware/recentAuth.js';

const router = Router();

const updateProfileSchema = z.object({ displayName: z.string().min(1).max(100) });
router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { displayName } = updateProfileSchema.parse(req.body);
    const trimmed = displayName.trim();
    if (!trimmed) {
      res.status(400).json({ error: '表示名を入力してください' });
      return;
    }
    await db
      .update(users)
      .set({ displayName: trimmed, updatedAt: new Date() })
      .where(eq(users.id, userId));
    if (req.session?.userId) req.session.displayName = trimmed;
    res.json({ ok: true, displayName: trimmed });
  } catch (err) {
    next(err);
  }
});

const deleteAccountSchema = z.object({ confirm: z.string() });
router.delete('/account', requireAuth, requireRecentAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { confirm } = deleteAccountSchema.parse(req.body);

    const [me] = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, userId));
    if (!me) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (me.role === 'admin') {
      res.status(403).json({ error: 'admin_self_delete', message: '管理者アカウントはこの画面から退会できません' });
      return;
    }

    if (confirm.trim() !== me.email) {
      res.status(400).json({ error: 'confirm_mismatch', message: '確認用メールアドレスが一致しません' });
      return;
    }

    await deleteUserAccount(userId);
    await audit('account.delete', { actor: { id: userId, email: me.email }, target: { type: 'user', id: userId }, detail: { mode: 'immediate' } }, req);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.json({ ok: true, deleted: true });
    });
  } catch (err) {
    next(err);
  }
});

export default router;
