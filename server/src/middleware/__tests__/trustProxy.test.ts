import { describe, it, expect } from 'vitest';
import { trustProxySetting } from '../../config/trustProxy.js';

describe('trustProxySetting：プロキシを信頼する設定の解釈', () => {
  it('値が無いときは、本番モードなら 1、それ以外なら信頼しない', () => {
    expect(trustProxySetting(undefined, true)).toBe(1);
    expect(trustProxySetting(undefined, false)).toBe(false);
  });
  it('"false" と "0" は信頼しない設定として読む', () => {
    expect(trustProxySetting('false', true)).toBe(false);
    expect(trustProxySetting('0', true)).toBe(false);
  });
  it('数値は信頼する段数に変換し、それ以外の文字列は加工せずに返す', () => {
    expect(trustProxySetting('2', true)).toBe(2);
    expect(trustProxySetting('true', true)).toBe(true);
    expect(trustProxySetting('loopback', true)).toBe('loopback');
  });
});
