import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 24;

let current: string | null = null;

function generate(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return chars.join('').replace(/(.{4})(?!$)/g, '$1-');
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function issueSetupCode(log: (line: string) => void = (l) => console.log(l)): string {
  current = generate();
  log('[Setup] ==============================================================');
  log('[Setup] まだ管理者がいません。最初の管理者の登録には、次の初期設定コードが要ります。');
  log(`[Setup] 初期設定コード: ${current}`);
  log('[Setup] 登録画面の「初期設定コード」の欄に入れてください。一度使うと無効になります。');
  log('[Setup] ==============================================================');
  return current;
}

export function hasSetupCode(): boolean {
  return current !== null;
}

export function verifySetupCode(input: string | undefined | null): boolean {
  if (!current || !input) return false;
  const a = Buffer.from(normalize(input));
  const b = Buffer.from(normalize(current));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function consumeSetupCode(): void {
  current = null;
}

export function resetSetupCodeForTest(code: string | null = null): void {
  current = code;
}
