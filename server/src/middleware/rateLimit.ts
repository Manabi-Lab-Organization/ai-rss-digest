import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler, type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { auditLater } from '../services/audit/audit.js';
import { getClientIp } from '../services/audit/logSafety.js';
import { getAuth } from './authContext.js';

const isProd = process.env.NODE_ENV === 'production';

const HIT_DEDUPE_MS = 60_000;
const recentHits = new Map<string, { at: number; suppressed: number }>();

export function rateLimitHitHandler(limiter: string) {
  return (req: Request, res: Response, _next: NextFunction, options: Options): void => {
    const ip = getClientIp(req);
    const key = `${limiter}|${ip ?? '?'}`;
    const now = Date.now();
    const prev = recentHits.get(key);
    if (prev && now - prev.at < HIT_DEDUPE_MS) {
      prev.suppressed += 1;
    } else {
      if (recentHits.size > 10_000) recentHits.clear();
      recentHits.set(key, { at: now, suppressed: 0 });
      auditLater('rate_limit.hit', {
        result: 'denied',
        detail: {
          limiter,
          method: req.method,
          path: req.baseUrl + req.path,
          suppressedSinceLast: prev?.suppressed ?? 0,
        },
      }, req);
    }
    res.status(options.statusCode).send(options.message);
  };
}

export const authLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('auth'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 5 : 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  },
});

export const loginAccountLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('login_account'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `account:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: {
    error: 'このアカウントへのログインの失敗が続いたため、しばらく受け付けません。時間をおいてお試しください。',
  },
});

export const registerLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('register'),
  windowMs: 60 * 60 * 1000,
  max: isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: '登録の試行が多すぎます。しばらくしてから再度お試しください。',
  },
});

export type RateLimitKeyRequest = {
  ip?: string;
  session?: { userId?: number };
};

export function digestAiRateLimitKey(req: RateLimitKeyRequest): string {
  const userId = getAuth(req as Request)?.userId;
  if (userId) return `u:${userId}`;
  return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
}

export const digestAiLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('digestAi'),
  windowMs: 10 * 60 * 1000,
  max: isProd ? 60 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => digestAiRateLimitKey(req as RateLimitKeyRequest),
  message: {
    error: 'AI処理の依頼が短時間に集中しています。10分ほど待ってから再度お試しください。',
  },
});

function aiFeatureLimiter(windowMinutes: number, maxInProd: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: isProd ? maxInProd : maxInProd * 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => digestAiRateLimitKey(req as RateLimitKeyRequest),
    message: {
      error: `AI処理の依頼が短時間に集中しています。${windowMinutes}分ほど待ってから再度お試しください。`,
    },
  });
}

export const feedWriteLimiter = aiFeatureLimiter(10, 30);

export const passwordResetLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('passwordReset'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 3 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  },
});
