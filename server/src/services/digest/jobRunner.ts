
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const running = new Map<string, Promise<number | null>>();

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

const MAX_CONCURRENT = Math.max(1, Number(process.env.DIGEST_MAX_CONCURRENT_JOBS || 3));
const MAX_PER_USER = Math.max(1, Number(process.env.DIGEST_MAX_JOBS_PER_USER || 2));

let active = 0;
const activeByUser = new Map<string, number>();
const queue: Array<{ userKey: string; start: () => void }> = [];

function pump(): void {
  for (let i = 0; i < queue.length && active < MAX_CONCURRENT; ) {
    const item = queue[i];
    if ((activeByUser.get(item.userKey) ?? 0) >= MAX_PER_USER) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    item.start();
  }
}

export function runDigestJob(stage: string, args: string[] = [], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number | null> {
  const key = `${stage}:${args.join(',')}`;
  const existing = running.get(key);
  if (existing) return existing;

  const userKey = args[0] ?? 'system';

  const isTs = import.meta.url.endsWith('.ts');
  const entry = resolve(__dir, isTs ? 'jobEntry.ts' : 'jobEntry.js');
  const cmd = isTs ? 'npx' : process.execPath;
  const cmdArgs = isTs ? ['tsx', entry, stage, ...args] : [entry, stage, ...args];

  const promise = new Promise<number | null>((resolveP) => {
    const finish = (result: number | null) => {
      running.delete(key);
      active--;
      const n = (activeByUser.get(userKey) ?? 1) - 1;
      if (n <= 0) activeByUser.delete(userKey);
      else activeByUser.set(userKey, n);
      resolveP(result);
      pump();
    };

    const start = () => {
      active++;
      activeByUser.set(userKey, (activeByUser.get(userKey) ?? 0) + 1);
      console.log(`[Digest] job start: ${stage} ${args.join(' ')} (同時実行 ${active}/${MAX_CONCURRENT})`);
      const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
      const timer = setTimeout(() => {
        console.error(`[Digest] job timeout (${Math.round(timeoutMs / 60000)}min): ${stage}`);
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        console.log(`[Digest] job end: ${stage} (exit ${code})`);
        finish(code);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`[Digest] job spawn error: ${stage}`, err);
        finish(null);
      });
    };

    if (active < MAX_CONCURRENT && (activeByUser.get(userKey) ?? 0) < MAX_PER_USER) {
      start();
    } else {
      queue.push({ userKey, start });
      console.log(`[Digest] job queued: ${stage} ${args.join(' ')} (待ち ${queue.length}件)`);
    }
  });
  running.set(key, promise);
  return promise;
}

export function digestJobStats(): { active: number; queued: number; max: number } {
  return { active, queued: queue.length, max: MAX_CONCURRENT };
}
