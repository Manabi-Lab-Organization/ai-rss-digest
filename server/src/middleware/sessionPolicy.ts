import type { Request, Response, NextFunction } from 'express';
import { webSessionAbsoluteMs, sessionRefreshIntervalMs } from '../config/sessionLifetime.js';

type SessionLike = {
  userId?: number;
  issuedAt?: number;
  touchedAt?: number;
};

export function sessionInvalidReason(
  s: SessionLike,
  now: number,
  opts: { absoluteMs: number },
): 'absolute_expired' | null {
  if (opts.absoluteMs > 0 && s.issuedAt && now - s.issuedAt > opts.absoluteMs) return 'absolute_expired';
  return null;
}

export async function checkSessionPolicy(req: Request): Promise<void> {
  const s = req.session as (typeof req.session & SessionLike) | undefined;
  if (!s?.userId) return;
  const now = Date.now();
  if (!s.issuedAt) s.issuedAt = now;
  const reason = sessionInvalidReason(s, now, { absoluteMs: webSessionAbsoluteMs() });
  if (reason) {
    await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
    return;
  }
  if (!s.touchedAt || now - s.touchedAt >= sessionRefreshIntervalMs()) {
    s.touchedAt = now;
  }
}

export async function sessionPolicyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await checkSessionPolicy(req);
  } catch (err) {
    console.error('[sessionPolicy] check failed:', err instanceof Error ? err.message : String(err));
    if (req.path.startsWith('/api/')) {
      res.status(503).json({ error: 'ログインの状態を確かめられませんでした。少し待ってからもう一度お試しください' });
      return;
    }
  }
  next();
}
