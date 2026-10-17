import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import { maskEmail, getClientIp, normalizeIp, sanitizeDetail, tokenLast4 } from '../logSafety.js';
import { buildAuditRecord, audit, auditAuthFailure, __setAuditWriterForTest, AUDIT_APP_NAME, type AuditRecord } from '../audit.js';
import { runWithAuditContext } from '../requestContext.js';
import { buildAccessLogLine } from '../accessLog.js';
import { objectKeyForDay, auditEnvName, candidateDays, toJsonLines, r2ConfigFromEnv, retentionDaysFromEnv } from '../auditExport.js';
import { rateLimitHitHandler } from '../../../middleware/rateLimit.js';

function fakeReq(over: Partial<Record<string, unknown>> = {}): Request {
  return {
    headers: { 'user-agent': 'UA/1.0', ...(over.headers as object) },
    socket: { remoteAddress: '10.0.0.9' },
    app: { get: (k: string) => (k === 'trust proxy' ? over.trustProxy ?? 1 : undefined) },
    session: over.session,
    requestId: over.requestId ?? 'req-123',
    method: 'POST',
    baseUrl: '/api/auth',
    path: '/login',
    originalUrl: over.originalUrl ?? '/api/auth/login',
    body: over.body,
  } as unknown as Request;
}

afterEach(() => {
  __setAuditWriterForTest(null);
  vi.restoreAllMocks();
});

describe('maskEmail', () => {
  it('@ より前は最初の1文字だけを見せる', () => {
    expect(maskEmail('hanako@example.co.jp')).toBe('h***@example.co.jp');
  });
  it('メールアドレスでない値は決まった文字に置き換える', () => {
    expect(maskEmail(undefined)).toBe('[no-email]');
    expect(maskEmail('abc')).toBe('[no-email]');
  });
});

describe('接続元の IP の求め方', () => {
  it('trust proxy が有効なら X-Forwarded-For の最後の値を使う', () => {
    const req = fakeReq({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
    expect(getClientIp(req)).toBe('203.0.113.7');
  });
  it('trust proxy が無効ならヘッダは使わず、接続の値を使う', () => {
    const req = fakeReq({ trustProxy: false, headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(getClientIp(req)).toBe('10.0.0.9');
  });
  it('IPv6 の形の IPv4 を元に戻し、IP でない値は null にする', () => {
    expect(normalizeIp('::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(normalizeIp('not-an-ip')).toBeNull();
  });

  it('trust proxy を 1 にした Express の req.ip と、自前の求め方が同じ値になる', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ reqIp: req.ip, ours: getClientIp(req) }));
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' } });
      const body = (await r.json()) as { reqIp: string; ours: string };
      expect(body.reqIp).toBe('203.0.113.7');
      expect(body.ours).toBe('203.0.113.7');
    } finally {
      server.close();
    }
  });
});

describe('記録に残す値を隠す', () => {
  it('秘密の値らしいキーは隠し、長い文は短くする', () => {
    const out = sanitizeDetail({ password: 'x', token: 'y', apiKey: 'z', tokenLast4: 'abcd', note: 'a'.repeat(1000), nested: { refreshToken: 'r' } }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.tokenLast4).toBe('abcd');
    expect(String(out.note).length).toBeLessThan(120);
    expect((out.nested as Record<string, unknown>).refreshToken).toBe('[REDACTED]');
  });
  it('トークンは最後の4文字だけを残す', () => {
    expect(tokenLast4('0123456789abcdef')).toBe('cdef');
    expect(tokenLast4('short')).toBeNull();
  });
});

describe('buildAuditRecord', () => {
  it('リクエストから利用者・IP・ブラウザの情報・リクエストの ID を取り出す', () => {
    const req = fakeReq({ session: { userId: 7, email: 'suzuki@example.jp' }, headers: { 'x-forwarded-for': '203.0.113.7' } });
    const rec = buildAuditRecord('digest.feed_delete', { target: { type: 'digest_feed', id: 99 } }, req);
    expect(rec).toMatchObject({
      app: AUDIT_APP_NAME, event: 'digest.feed_delete', result: 'success',
      actorId: '7', actorEmail: 'suzuki@example.jp', actorRole: 'user',
      targetType: 'digest_feed', targetId: '99', ip: '203.0.113.7', userAgent: 'UA/1.0', requestId: 'req-123',
    });
  });
  it('リクエストが無くても、処理の文脈から利用者を取り出す', () => {
    const rec = runWithAuditContext({ channel: 'job', actorId: 42 }, () => buildAuditRecord('llm.call', {}));
    expect(rec.actorId).toBe('42');
    expect(rec.ip).toBeNull();
  });
  it('文脈もリクエストも無ければ system とする', () => {
    const rec = buildAuditRecord('account.delete', {});
    expect(rec.actorRole).toBe('system');
    expect(rec.actorId).toBeNull();
  });
});

describe('audit()', () => {
  it('書き込みに失敗しても、ふだんは例外を投げない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    __setAuditWriterForTest(async () => { throw new Error('write failed'); });
    await expect(audit('logout', {}, fakeReq())).resolves.toBeUndefined();
  });
  it('strict を付けたときは、書き込みの失敗を例外にする', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    __setAuditWriterForTest(async () => { throw new Error('write failed'); });
    await expect(audit('admin.role_change', { strict: true }, fakeReq())).rejects.toThrow('write failed');
  });
  it('画面に出す控えにはメールアドレスを含めない', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    __setAuditWriterForTest(async () => {});
    await audit('login.success', { actor: { id: 1, email: 'tanaka@example.com' } }, fakeReq());
    expect(logs.join('\n')).not.toContain('tanaka@example.com');
    expect(logs.join('\n')).toContain('login.success');
  });
});

describe('auditAuthFailure', () => {
  it('入力されたメールを小文字にして失敗の理由と一緒に残し、パスワードは残さない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    const err = Object.assign(new Error('x'), { name: 'UnauthorizedError', statusCode: 401, publicMessage: 'bad' });
    auditAuthFailure('login.failure', 'password', err, fakeReq({ body: { email: 'Sato@Example.com', password: 'sample-pass-9' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ event: 'login.failure', result: 'failure', actorEmail: 'sato@example.com', authMethod: 'password' });
    expect(JSON.stringify(written[0])).not.toContain('sample-pass-9');
  });
  it('入力の形が正しくないだけのエラーは記録しない', async () => {
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    auditAuthFailure('login.failure', 'password', Object.assign(new Error('x'), { name: 'ZodError' }), fakeReq());
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(0);
  });
});

describe('rate_limit.hit', () => {
  it('回数の上限に達したことを記録し、同じ接続元からは1分に1件だけにする', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const written: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { written.push(r); });
    const handler = rateLimitHitHandler('test');
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() } as unknown as Response;
    const req = fakeReq({ headers: { 'x-forwarded-for': '198.51.100.44' } });
    const options = { statusCode: 429, message: { error: 'too many' } } as never;
    handler(req, res, () => {}, options);
    handler(req, res, () => {}, options);
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ event: 'rate_limit.hit', result: 'denied', ip: '198.51.100.44' });
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('アクセスの記録', () => {
  it('? 以降を外して記録する', () => {
    const req = fakeReq({ originalUrl: '/reset-password?token=zzz456', session: { userId: 3 } });
    (req as unknown as { method: string }).method = 'GET';
    const res = { statusCode: 200 } as Response;
    const line = buildAccessLogLine(req, res, 0n, 5_000_000n);
    expect(line).toMatchObject({ type: 'access', method: 'GET', path: '/reset-password', status: 200, durationMs: 5, userId: 3, requestId: 'req-123' });
    expect(JSON.stringify(line)).not.toContain('zzz456');
  });
});

describe('記録の書き出し', () => {
  it('保存先の名前は audit、アプリ名、環境名、年、月、日の順で作る', () => {
    expect(objectKeyForDay('2054-09-27', 'sample-app', 'production')).toBe('audit/sample-app/production/2054/09/27.jsonl.gz');
  });
  it('環境が違えば、同じ日でも保存先の名前が別になる', () => {
    const prod = objectKeyForDay('2054-10-05', 'sample-app', auditEnvName({ AUDIT_R2_ENV: 'production' }));
    const dev = objectKeyForDay('2054-10-05', 'sample-app', auditEnvName({ AUDIT_R2_ENV: 'dev' }));
    expect(prod).not.toBe(dev);
  });
  it('環境名は AUDIT_R2_ENV で決め、無ければ local にし、使えない文字はハイフンにする', () => {
    expect(auditEnvName({ AUDIT_R2_ENV: 'Production' })).toBe('production');
    expect(auditEnvName({ AUDIT_R2_ENV: 'feature 7/test' })).toBe('feature-7-test');
    expect(auditEnvName({})).toBe('local');
  });
  it('書き出す日は、いちばん古い記録の日から前の日まで（UTC で数え、当日は入れない）', () => {
    const now = new Date('2054-09-27T01:00:00Z');
    expect(candidateDays(now, new Date('2054-09-25T23:59:00Z'))).toEqual(['2054-09-25', '2054-09-26']);
    expect(candidateDays(now, null)).toEqual(['2054-09-26']);
  });
  it('さかのぼる日数に上限は無い', () => {
    const days = candidateDays(new Date('2054-09-27T00:00:00Z'), new Date('2053-09-27T00:00:00Z'));
    expect(days[0]).toBe('2053-09-27');
    expect(days[days.length - 1]).toBe('2054-09-26');
    expect(days).toHaveLength(365);
  });
  it('1行に1件ずつ JSON で書き、時刻は ISO 8601 の形にする', () => {
    const out = toJsonLines([{ id: 1, ts: new Date('2054-09-26T00:00:00Z'), event: 'logout' }, { id: 2, ts: new Date('2054-09-26T00:00:01Z'), event: 'signup' }]);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, ts: '2054-09-26T00:00:00.000Z', event: 'logout' });
  });
  it('必要な環境変数が一つでも無ければ書き出しを使わない', () => {
    expect(r2ConfigFromEnv({ AUDIT_R2_ACCOUNT_ID: 'a', AUDIT_R2_ACCESS_KEY_ID: 'b', AUDIT_R2_SECRET_ACCESS_KEY: 'c' })).toBeNull();
    expect(r2ConfigFromEnv({ AUDIT_R2_ACCOUNT_ID: 'a', AUDIT_R2_ACCESS_KEY_ID: 'b', AUDIT_R2_SECRET_ACCESS_KEY: 'c', AUDIT_R2_BUCKET: 'd' })).toMatchObject({ bucket: 'd' });
  });
  it('DB に残す日数は指定が無ければ400日で、1年より短い値は受け付けない', () => {
    expect(retentionDaysFromEnv({})).toBe(400);
    expect(retentionDaysFromEnv({ AUDIT_DB_RETENTION_DAYS: '30' })).toBe(400);
    expect(retentionDaysFromEnv({ AUDIT_DB_RETENTION_DAYS: '1095' })).toBe(1095);
  });
});
