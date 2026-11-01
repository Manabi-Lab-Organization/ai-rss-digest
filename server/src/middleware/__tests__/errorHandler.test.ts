import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { z } from 'zod';
import { errorHandler } from '../errorHandler.js';

function run(err: Error) {
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), json } as unknown as Response;
  const req = { path: '/x', method: 'POST', body: {} } as unknown as Request;
  errorHandler(err, req, res, vi.fn() as unknown as NextFunction);
  return { res, json };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorHandler', () => {
  it('入力の検査に失敗したら 400 で最初の問題を返す', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = z.object({ name: z.string().min(1, '名前が必要です') }).safeParse({ name: '' });
    if (parsed.success) throw new Error('検査に通ってしまった');
    const { res, json } = run(parsed.error);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(json.mock.calls[0][0].error).toBe('名前が必要です');
  });

  it('クエリの失敗のパラメータをログと応答に出さない', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new DrizzleQueryError('update users', ['secret-value'], new Error('pg error'));
    const { res, json } = run(err);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret-value');
    expect(JSON.stringify(log.mock.calls)).toContain('pg error');
  });
});
