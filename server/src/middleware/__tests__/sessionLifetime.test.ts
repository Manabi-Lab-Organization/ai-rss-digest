import { describe, it, expect, afterEach } from 'vitest';
import { sessionInvalidReason } from '../sessionPolicy.js';
import { isWithinSudoWindow } from '../recentAuth.js';
import { webSessionIdleMs, webSessionAbsoluteMs, adminIdleMs, sudoWindowMs } from '../../config/sessionLifetime.js';

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('ブラウザでのログイン・管理画面・再確認の有効期間', () => {
  it('設定が無いときの長さを返す', () => {
    for (const k of ['WEB_SESSION_IDLE_MINUTES', 'WEB_SESSION_ABSOLUTE_MINUTES', 'ADMIN_SESSION_IDLE_MINUTES', 'SUDO_WINDOW_MINUTES']) delete process.env[k];
    expect(webSessionIdleMs()).toBe(60 * 60 * 1000);
    expect(webSessionAbsoluteMs()).toBe(12 * 60 * 60 * 1000);
    expect(adminIdleMs()).toBe(15 * 60 * 1000);
    expect(sudoWindowMs()).toBe(10 * 60 * 1000);
  });

  it('期限を過ぎたログインは無効と判定する', () => {
    const now = Date.now();
    const abs = 12 * 60 * 60 * 1000;
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - abs - 1 }, now, { absoluteMs: abs })).toBe('absolute_expired');
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - 1000 }, now, { absoluteMs: abs })).toBeNull();
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - 10 * abs }, now, { absoluteMs: 0 })).toBeNull();
  });

  it('本人の再確認は 10 分間だけ有効', () => {
    const now = Date.now();
    expect(isWithinSudoWindow(now - 9 * 60 * 1000, now)).toBe(true);
    expect(isWithinSudoWindow(now - 11 * 60 * 1000, now)).toBe(false);
    expect(isWithinSudoWindow(undefined, now)).toBe(false);
  });
});
