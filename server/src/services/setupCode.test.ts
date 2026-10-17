import { describe, it, expect, beforeEach } from 'vitest';
import { consumeSetupCode, hasSetupCode, issueSetupCode, resetSetupCodeForTest, verifySetupCode } from './setupCode.js';

beforeEach(() => resetSetupCodeForTest(null));

describe('初期設定コード', () => {
  it('作ったコードをログにだけ出し、推測しにくい長さにする', () => {
    const lines: string[] = [];
    const code = issueSetupCode((l) => lines.push(l));
    expect(code.replace(/-/g, '')).toMatch(/^[A-Z2-9]{24}$/);
    expect(lines.some((l) => l.includes(code))).toBe(true);
  });

  it('作るたびに違うコードになる', () => {
    const a = issueSetupCode(() => {});
    const b = issueSetupCode(() => {});
    expect(a).not.toBe(b);
    expect(verifySetupCode(a)).toBe(false);
    expect(verifySetupCode(b)).toBe(true);
  });

  it('作られていなければ、どのコードも通さない', () => {
    expect(hasSetupCode()).toBe(false);
    expect(verifySetupCode('')).toBe(false);
    expect(verifySetupCode(undefined)).toBe(false);
  });

  it('使ったあとは通さない', () => {
    const code = issueSetupCode(() => {});
    consumeSetupCode();
    expect(verifySetupCode(code)).toBe(false);
  });
});
