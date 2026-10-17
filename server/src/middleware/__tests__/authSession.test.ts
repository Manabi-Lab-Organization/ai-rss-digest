import { describe, it, expect, vi, beforeEach } from 'vitest';

const executed: string[] = [];
vi.mock('../../db/index.js', () => ({
  db: {
    execute: vi.fn(async (q: any) => {
      executed.push(JSON.stringify(q?.queryChunks ?? q));
      return { rowCount: 2 };
    }),
  },
}));
const audits: Array<{ event: string; opts: any }> = [];
vi.mock('../../services/audit/audit.js', () => ({
  audit: vi.fn(async (event: string, opts: any) => { audits.push({ event, opts }); }),
}));

import { invalidateAllUserAccess, logoutOtherDevices } from '../../services/authSessionService.js';

describe('ログイン状態の取り消し', () => {
  beforeEach(() => { executed.length = 0; audits.length = 0; });

  it('invalidateAllUserAccess はその人のセッションをすべて消し、理由を操作の記録に書く', async () => {
    await invalidateAllUserAccess(42, 'password.change');
    const a = audits.find((x) => x.event === 'session.revoke');
    expect(a?.opts.detail).toMatchObject({ reason: 'password.change', scope: 'all', deletedSessions: 2 });
    expect(executed.some((q) => q.includes('DELETE FROM session'))).toBe(true);
  });

  it('logoutOtherDevices は今のセッションを消す対象から外し、消した件数を返す', async () => {
    const r = await logoutOtherDevices(42, 'sid-1');
    expect(r).toEqual({ deletedSessions: 2 });
    expect(executed.some((q) => q.includes('sid-1'))).toBe(true);
  });
});
