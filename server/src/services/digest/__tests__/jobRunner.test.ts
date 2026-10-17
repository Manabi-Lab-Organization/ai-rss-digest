import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawned: Array<{ args: string[]; child: EventEmitter & { kill: () => void } }> = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as EventEmitter & { kill: () => void };
    spawned.push({ args, child });
    return child;
  },
}));

process.env.DIGEST_MAX_CONCURRENT_JOBS = '2';
process.env.DIGEST_MAX_JOBS_PER_USER = '2';

const { runDigestJob, digestJobStats } = await import('../jobRunner.js');

function finish(index: number, code = 0): void {
  spawned[index].child.emit('exit', code);
}

describe('runDigestJob の同時に動かす数の制限', () => {
  beforeEach(() => {
    spawned.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('上限を超えた分は順番待ちになり、空きができたら動き出す', async () => {
    const p1 = runDigestJob('research', ['1', '10']);
    const p2 = runDigestJob('research', ['2', '20']);
    const p3 = runDigestJob('research', ['3', '30']);

    expect(spawned).toHaveLength(2);
    expect(digestJobStats()).toMatchObject({ active: 2, queued: 1, max: 2 });

    finish(0);
    await p1;
    expect(spawned).toHaveLength(3);
    expect(digestJobStats()).toMatchObject({ active: 2, queued: 0 });

    finish(1);
    finish(2);
    await Promise.all([p2, p3]);
    expect(digestJobStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('一人が続けて頼んだ分は一人あたりの上限で待たされ、別の人の分が先に動ける', async () => {
    const a = runDigestJob('research', ['7', '1']);
    const b = runDigestJob('research', ['7', '2']);
    const c = runDigestJob('research', ['7', '3']);
    expect(spawned).toHaveLength(2);

    const d = runDigestJob('research', ['8', '1']);
    expect(spawned).toHaveLength(2);

    finish(0);
    await a;
    expect(spawned).toHaveLength(3);
    expect(spawned[2].args.join(' ')).toContain('7 3');

    finish(1);
    await b;
    expect(spawned).toHaveLength(4);
    expect(spawned[3].args.join(' ')).toContain('8 1');

    finish(2);
    finish(3);
    await Promise.all([c, d]);
    expect(digestJobStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('同じ処理と引数の依頼が重なったら同じ Promise を返し、プロセスは一つだけ動かす', async () => {
    const p1 = runDigestJob('podcast', ['5', '99']);
    const p2 = runDigestJob('podcast', ['5', '99']);
    expect(p1).toBe(p2);
    expect(spawned).toHaveLength(1);
    finish(0, 0);
    expect(await p1).toBe(0);
  });

  it('起動に失敗しても、使っていた枠を空ける', async () => {
    const p1 = runDigestJob('edition', ['1']);
    const p2 = runDigestJob('edition', ['2']);
    const p3 = runDigestJob('edition', ['3']);
    expect(digestJobStats()).toMatchObject({ active: 2, queued: 1 });

    spawned[0].child.emit('error', new Error('spawn failed'));
    expect(await p1).toBeNull();
    expect(spawned).toHaveLength(3);

    finish(1);
    finish(2);
    await Promise.all([p2, p3]);
    expect(digestJobStats()).toMatchObject({ active: 0, queued: 0 });
  });
});
