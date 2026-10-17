import { describe, it, expect, vi } from 'vitest';
import { sessionPolicyMiddleware } from '../sessionPolicy.js';

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('sessionPolicyMiddleware', () => {
  it('期限内のログインはそのまま次へ進める', async () => {
    const req: any = { path: '/api/digest/editions', session: { userId: 1, issuedAt: Date.now() } };
    const res = makeRes();
    const next = vi.fn();
    await sessionPolicyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.session.userId).toBe(1);
  });

  it('期限を過ぎたログインは作り直してから次へ進める', async () => {
    const regenerate = vi.fn((cb: () => void) => cb());
    const req: any = { path: '/api/digest/editions', session: { userId: 1, issuedAt: 1, regenerate } };
    const res = makeRes();
    const next = vi.fn();
    await sessionPolicyMiddleware(req, res, next);
    expect(regenerate).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('ログインしていないリクエストは確認せずに次へ進める', async () => {
    const req: any = { path: '/api/auth/login', session: {} };
    const res = makeRes();
    const next = vi.fn();
    await sessionPolicyMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
