import { describe, it, expect } from 'vitest';
import { isTransientMailError } from '../../emailService.js';

describe('isTransientMailError：メール送信の失敗をやり直すべきか', () => {
  it('ステータスが無い通信エラーはやり直す', () => {
    expect(isTransientMailError({
      name: 'application_error', statusCode: null,
      message: 'Network request did not complete.',
    })).toBe(true);
    expect(isTransientMailError({ message: 'timeout' })).toBe(true);
  });

  it('408・429・5xx はやり直す', () => {
    for (const statusCode of [408, 429, 500, 502, 503, 529]) {
      expect(isTransientMailError({ statusCode })).toBe(true);
    }
  });

  it('上記以外の 4xx はやり直さない', () => {
    for (const statusCode of [400, 401, 403, 404, 422]) {
      expect(isTransientMailError({ statusCode })).toBe(false);
    }
  });

  it('エラーが渡されなければ false', () => {
    expect(isTransientMailError(null)).toBe(false);
    expect(isTransientMailError(undefined)).toBe(false);
  });
});
