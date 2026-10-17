import { describe, it, expect } from 'vitest';
import { digestAiRateLimitKey } from '../rateLimit.js';

describe('digestAiRateLimitKey：回数制限に使う鍵', () => {
  it('ログインしていればユーザー ID を鍵にする', () => {
    expect(digestAiRateLimitKey({ session: { userId: 42 }, ip: '203.0.113.5' })).toBe('u:42');
  });

  it('IPv6 は先頭 /64 が同じなら同じ鍵になる', () => {
    const a = digestAiRateLimitKey({ ip: '2001:db8:abcd:1234:0000:0000:0000:0001' });
    const b = digestAiRateLimitKey({ ip: '2001:db8:abcd:1234:ffff:ffff:ffff:ffff' });
    expect(a).toBe(b);
  });

  it('IPv6 は先頭 /64 が違えば別の鍵になる', () => {
    const a = digestAiRateLimitKey({ ip: '2001:db8:abcd:1234::1' });
    const b = digestAiRateLimitKey({ ip: '2001:db8:abcd:5678::1' });
    expect(a).not.toBe(b);
  });

  it('IPv4 はアドレスそのものを鍵にする', () => {
    expect(digestAiRateLimitKey({ ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(digestAiRateLimitKey({ ip: '203.0.113.6' })).toBe('ip:203.0.113.6');
  });

  it('IP が無ければ共通の鍵を使う', () => {
    expect(digestAiRateLimitKey({})).toBe('ip:unknown');
  });

  it('ユーザー ID が 0 または無いときは IP を鍵にする', () => {
    expect(digestAiRateLimitKey({ session: { userId: 0 }, ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(digestAiRateLimitKey({ session: {}, ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
  });
});
