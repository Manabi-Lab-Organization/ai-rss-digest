import { describe, it, expect } from 'vitest';
import { callerName } from '../callerName.js';

async function captureBeforeAwait(): Promise<string> {
  const caller = callerName(2);
  await new Promise((r) => setTimeout(r, 0));
  return caller;
}

async function captureAfterAwait(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0));
  return callerName(2);
}

async function outerCallerEarly(): Promise<string> {
  return captureBeforeAwait();
}

async function outerCallerLate(): Promise<string> {
  return captureAfterAwait();
}

describe('callerName', () => {
  it('await より前に呼べば、async 関数でも呼び出し元の名前が返る', async () => {
    expect(await outerCallerEarly()).toBe('outerCallerEarly');
  });

  it('await より後に呼ぶと、呼び出し元の名前は返らない', async () => {
    expect(await outerCallerLate()).not.toBe('outerCallerLate');
  });

  it('framesUp に 1 を渡すと、callerName を呼んだ関数の名前が返る', () => {
    function selfName(): string { return callerName(1); }
    expect(selfName()).toBe('selfName');
  });
});
