import type { Request, Response, NextFunction } from 'express';
import { getAuth } from './authContext.js';
import { sudoWindowMs } from '../config/sessionLifetime.js';

export const REAUTH_REQUIRED_MESSAGE = '続行するには、もう一度パスワード（または Google）で本人確認してください';

export function isWithinSudoWindow(sudoAt: number | null | undefined, now: number = Date.now(), windowMs: number = sudoWindowMs()): boolean {
  return typeof sudoAt === 'number' && sudoAt > 0 && now - sudoAt <= windowMs;
}

export function hasRecentAuth(req: Request): boolean {
  if (!getAuth(req)) return false;
  return isWithinSudoWindow(req.session?.sudoAt);
}

export function markRecentAuth(req: Request): void {
  if (!getAuth(req)) return;
  req.session.sudoAt = Date.now();
  req.session.adminSeenAt = Date.now();
}

export function sendReauthRequired(res: Response): void {
  res.status(403).json({ error: 'reauth_required', code: 'reauth_required', message: REAUTH_REQUIRED_MESSAGE });
}

export function requireRecentAuth(req: Request, res: Response, next: NextFunction): void {
  if (hasRecentAuth(req)) {
    next();
    return;
  }
  sendReauthRequired(res);
}
