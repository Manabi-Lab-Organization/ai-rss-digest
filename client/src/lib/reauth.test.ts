import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithReauth, setReauthHandler } from './reauth';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchWithReauth：本人確認が必要な操作の送信', () => {
  afterEach(() => {
    setReauthHandler(null);
    vi.unstubAllGlobals();
  });

  it('403 で reauth_required が返ったら確認の処理を呼び、成功すれば1回だけ送り直す', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(403, { code: 'reauth_required', message: 'x' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn(async () => true);
    setReauthHandler(handler);
    const res = await fetchWithReauth('/api/user/account', { method: 'DELETE' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('確認がキャンセルされたら送り直さず、403 の応答を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(403, { code: 'reauth_required' }));
    vi.stubGlobal('fetch', fetchMock);
    setReauthHandler(async () => false);
    const res = await fetchWithReauth('/api/user/account', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
  });

  it('reauth_required ではない 403 なら確認の処理を呼ばない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { error: 'Forbidden' })));
    const handler = vi.fn(async () => true);
    setReauthHandler(handler);
    const res = await fetchWithReauth('/api/admin/users');
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
