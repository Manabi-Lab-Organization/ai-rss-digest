
import { safeFetch, type LookupFn, readTextLimited } from './safeFetch.js';
import { isGoogleNewsUrl } from './gnews.js';
import { USER_AGENT } from './userAgent.js';
import { isAllowedByRobots, ROBOTS_DISALLOWED_REASON } from './robots.js';

const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;

const MAX_CHARS = 6000;

export function extractText(html: string): string {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const article = h.match(/<article[\s\S]*?<\/article>/i)?.[0]
    ?? h.match(/<main[\s\S]*?<\/main>/i)?.[0];
  if (article && article.length > 800) h = article;
  h = h.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  const text = h
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
  return text.slice(0, MAX_CHARS);
}

export interface FetchTextResult {
  text: string | null;
  reason?: string;
}

export const GOOGLE_NEWS_SKIPPED_REASON = 'Googleニュースの記事ページは取得しない';

export type RobotsCheck = (url: string) => Promise<boolean>;

class RobotsDisallowedError extends Error {}

export async function fetchArticleTextDetailed(
  url: string,
  {
    fetchFn,
    lookupFn,
    robotsCheck = (u: string) => isAllowedByRobots(u, { fetchFn, lookupFn }),
  }: { fetchFn?: typeof fetch; lookupFn?: LookupFn; robotsCheck?: RobotsCheck } = {},
): Promise<FetchTextResult> {
  if (isGoogleNewsUrl(url)) return { text: null, reason: GOOGLE_NEWS_SKIPPED_REASON };
  try {
    const res = await safeFetch(
      url,
      {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(12000),
      },
      {
        fetchFn,
        lookupFn,
        beforeRequest: async (u) => {
          if (!(await robotsCheck(u))) throw new RobotsDisallowedError();
        },
      },
    );
    if (!res.ok) return { text: null, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return { text: null, reason: `HTML以外（${type.split(';')[0].trim() || '種類不明'}）` };
    const text = extractText(await readTextLimited(res, MAX_ARTICLE_BYTES));
    if (text.length < 300) return { text: null, reason: `本文を抽出できず（${text.length}字）` };
    return { text };
  } catch (err) {
    if (err instanceof RobotsDisallowedError) return { text: null, reason: ROBOTS_DISALLOWED_REASON };
    const e = err as Error;
    if (e?.name === 'TimeoutError' || /timeout|aborted/i.test(String(e?.message))) {
      return { text: null, reason: '時間切れ（12秒）' };
    }
    return { text: null, reason: String(e?.message || err).slice(0, 80) };
  }
}

export async function fetchArticleText(
  url: string,
  opts: { fetchFn?: typeof fetch; lookupFn?: LookupFn; robotsCheck?: RobotsCheck } = {},
): Promise<string | null> {
  return (await fetchArticleTextDetailed(url, opts)).text;
}

export interface EnrichFailure {
  title: string;
  url: string;
  reason: string;
}

export interface EnrichResult {
  attempted: number;
  succeeded: number;
  failed: number;
  failures: EnrichFailure[];
}

export interface EnrichableRep {
  rep: { url?: string | null; content?: string | null; title?: string | null };
}

export async function enrichWithFullText(
  reps: EnrichableRep[],
  {
    concurrency = 5,
    onProgress,
    fetchTextFn = (url: string) => fetchArticleTextDetailed(url),
  }: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    fetchTextFn?: (url: string) => Promise<string | null | FetchTextResult>;
  } = {},
): Promise<EnrichResult> {
  const targets = reps.filter((r) => ((r.rep.content ?? '').length < 800) && r.rep.url && !isGoogleNewsUrl(r.rep.url));
  let done = 0;
  let succeeded = 0;
  const failures: EnrichFailure[] = [];
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      let r: EnrichableRep | undefined;
      while ((r = queue.shift())) {
        const raw = await fetchTextFn(r.rep.url!);
        const result: FetchTextResult = typeof raw === 'string' || raw === null
          ? { text: raw, ...(raw === null ? { reason: '理由不明' } : {}) }
          : raw;
        if (result.text) {
          r.rep.content = result.text;
          succeeded++;
        } else {
          failures.push({ title: r.rep.title ?? '', url: r.rep.url!, reason: result.reason ?? '理由不明' });
        }
        onProgress?.(++done, targets.length);
      }
    }),
  );
  return { attempted: targets.length, succeeded, failed: targets.length - succeeded, failures };
}

export function formatEnrichFailures(failures: EnrichFailure[]): string[] {
  if (failures.length === 0) return [];
  const counts = new Map<string, number>();
  for (const f of failures) {
    const key = f.reason.replace(/（\d+字）$/, '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' / ');
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '?'; } };
  return [
    `[Digest:edition]   本文が取れなかった理由: ${breakdown}`,
    ...failures.map((f) => `[Digest:edition]   本文取れず: 「${f.title.slice(0, 30)}」（${host(f.url)}）— ${f.reason}`),
  ];
}
