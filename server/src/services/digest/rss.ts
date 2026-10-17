
import Parser from 'rss-parser';
import { readTextLimited, safeFetch, type LookupFn } from './safeFetch.js';

const MAX_FEED_BYTES = 5 * 1024 * 1024;
import { isHttpUrl } from './urlSafety.js';
import { USER_AGENT } from './userAgent.js';

const parser = new Parser({ timeout: 20000, customFields: { item: [['source', 'source', { keepArray: true }]] } });

export interface FetchedFeedItem {
  title: string;
  url: string;
  publishedAt: string | null;
  summaryRaw: string | null;
  content: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
}

export function parseRssSource(raw: unknown): { sourceName: string | null; sourceUrl: string | null } {
  if (Array.isArray(raw)) return parseRssSource(raw[0]);
  if (typeof raw === 'string') return { sourceName: raw.trim() || null, sourceUrl: null };
  if (!raw || typeof raw !== 'object') return { sourceName: null, sourceUrl: null };
  const r = raw as { _?: unknown; $?: { url?: unknown } };
  const name = typeof r._ === 'string' ? r._.trim() : '';
  const url = typeof r.$?.url === 'string' ? r.$.url.trim() : '';
  return { sourceName: name || null, sourceUrl: url && isHttpUrl(url) ? url : null };
}

export interface FetchFeedResult {
  notModified?: boolean;
  items?: FetchedFeedItem[];
  feedTitle?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export async function fetchFeed(
  xmlUrl: string,
  {
    etag,
    lastModified,
    fetchFn,
    lookupFn,
  }: {
    etag?: string | null;
    lastModified?: string | null;
    fetchFn?: typeof fetch;
    lookupFn?: LookupFn;
  } = {},
): Promise<FetchFeedResult> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const res = await safeFetch(xmlUrl, { headers, signal: AbortSignal.timeout(20000) }, { fetchFn, lookupFn });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const feed = await parser.parseString(await readTextLimited(res, MAX_FEED_BYTES));
  const items: FetchedFeedItem[] = (feed.items || [])
    .map((it) => ({
      title: (it.title || '').trim(),
      url: (it.link || it.guid || '') as string,
      publishedAt: it.isoDate || null,
      summaryRaw: (it.contentSnippet || '').slice(0, 2000) || null,
      content: ((it as unknown as Record<string, unknown>)['content:encoded'] as string) || it.content || null,
      ...parseRssSource((it as unknown as Record<string, unknown>).source),
    }))
    .filter((it) => isHttpUrl(it.url));

  return {
    items,
    feedTitle: (feed.title || '').trim() || null,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}
