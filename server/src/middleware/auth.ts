import { Request, Response, NextFunction } from 'express';
import { getAuth } from './authContext.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  if (auth?.userId) {
    res.locals.auth = auth;
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}
