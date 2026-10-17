
import crypto from 'node:crypto';
import { and, eq, isNull, max, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestFeeds, digestArticles } from '../../db/schema.js';
import { fetchFeed } from './rss.js';
import { nextLastPublishedAt } from './feedHealth.js';
import { isGoogleNewsUrl } from './gnews.js';

const CONCURRENCY = 8;
const GNEWS_DELAY_MS = Number(process.env.DIGEST_GNEWS_DELAY_MS || 2500);
const GNEWS_RETRY_DELAY_MS = 8000;

type FeedRow = typeof digestFeeds.$inferSelect;

async function latestFromArticles(feed: FeedRow): Promise<Date | null> {
  const [row] = await db
    .select({ latest: max(digestArticles.publishedAt) })
    .from(digestArticles)
    .where(eq(digestArticles.feedId, feed.id));
  return nextLastPublishedAt(feed.lastPublishedAt, row?.latest ?? null);
}

export async function isSameGoogleNewsArticle(
  item: { url: string; title: string; sourceName: string | null },
  alreadyCollected: (title: string, sourceName: string | null) => Promise<boolean>,
): Promise<boolean> {
  if (!isGoogleNewsUrl(item.url) || !item.title.trim()) return false;
  return alreadyCollected(item.title.trim(), item.sourceName);
}

export function formatSameArticle(n: number): string {
  return n > 0 ? ` / URLが変わっただけの集め済み記事${n}件（保存せず）` : '';
}

export interface PollFeedResult {
  feedId: number;
  feed: string;
  newCount: number;
  itemCount?: number;
  reattached?: number;
  sameArticle?: number;
  notModified?: boolean;
  error?: string;
}

export interface PollSummary {
  feedCount: number;
  sameArticle: number;
  added: number;
  errors: PollFeedResult[];
  results: PollFeedResult[];
}

export function articleUrlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function pollOne(feed: FeedRow): Promise<PollFeedResult> {
  try {
    let etag = feed.etag;
    let lastModified = feed.lastModified;
    if (etag || lastModified) {
      const [attached] = await db.select({ id: digestArticles.id })
        .from(digestArticles)
        .where(eq(digestArticles.feedId, feed.id))
        .limit(1);
      if (!attached) {
        etag = null;
        lastModified = null;
      }
    }
    const result = await fetchFeed(feed.xmlUrl, { etag, lastModified });
    if (result.notModified) {
      const healed = await latestFromArticles(feed);
      await db.update(digestFeeds)
        .set({
          lastFetchedAt: new Date(),
          ...(healed ? { lastPublishedAt: healed } : {}),
          lastError: null,
          errorCount: 0,
        })
        .where(eq(digestFeeds.id, feed.id));
      return { feedId: feed.id, feed: feed.title, newCount: 0, notModified: true };
    }

    let newCount = 0;
    let reattached = 0;
    let sameArticle = 0;
    for (const it of result.items ?? []) {
      const urlHash = articleUrlHash(it.url);
      const [exists] = await db.select({ id: digestArticles.id, feedId: digestArticles.feedId })
        .from(digestArticles)
        .where(and(eq(digestArticles.userId, feed.userId), eq(digestArticles.urlHash, urlHash)))
        .limit(1);
      if (exists) {
        if (exists.feedId == null) {
          await db.update(digestArticles)
            .set({ feedId: feed.id })
            .where(eq(digestArticles.id, exists.id));
          reattached++;
        }
        continue;
      }

      const same = await isSameGoogleNewsArticle(it, async (title, sourceName) => {
        const [hit] = await db.select({ id: digestArticles.id })
          .from(digestArticles)
          .where(and(
            eq(digestArticles.userId, feed.userId),
            eq(digestArticles.title, title),
            sourceName == null ? isNull(digestArticles.sourceName) : eq(digestArticles.sourceName, sourceName),
          ))
          .limit(1);
        return Boolean(hit);
      });
      if (same) {
        sameArticle++;
        continue;
      }
      const inserted = await db.insert(digestArticles)
        .values({
          userId: feed.userId,
          feedId: feed.id,
          urlHash,
          title: it.title,
          url: it.url,
          publishedAt: toDate(it.publishedAt),
          summaryRaw: it.summaryRaw,
          content: it.content,
          sourceName: it.sourceName,
          sourceUrl: it.sourceUrl,
        })
        .onConflictDoNothing()
        .returning({ id: digestArticles.id });
      newCount += inserted.length;
    }

    const nextPublished = await latestFromArticles(feed);

    await db.update(digestFeeds)
      .set({
        etag: result.etag ?? null,
        lastModified: result.lastModified ?? null,
        lastFetchedAt: new Date(),
        ...(nextPublished ? { lastPublishedAt: nextPublished } : {}),
        lastError: null,
        errorCount: 0,
      })
      .where(eq(digestFeeds.id, feed.id));
    return { feedId: feed.id, feed: feed.title, newCount, itemCount: (result.items ?? []).length, reattached, sameArticle };
  } catch (err) {
    const message = String((err as Error).message || err).slice(0, 300);
    await db.update(digestFeeds)
      .set({
        lastFetchedAt: new Date(),
        lastError: message,
        errorCount: sql`${digestFeeds.errorCount} + 1`,
      })
      .where(eq(digestFeeds.id, feed.id));
    return { feedId: feed.id, feed: feed.title, newCount: 0, error: message };
  }
}

export async function pollFeeds(opts: { userId?: number } = {}): Promise<PollSummary> {
  const where = opts.userId != null
    ? and(ne(digestFeeds.status, 'paused'), eq(digestFeeds.userId, opts.userId))
    : ne(digestFeeds.status, 'paused');
  const feeds = await db.select().from(digestFeeds).where(where);

  const gnewsFeeds = feeds.filter((f) => f.kind === 'gnews' || isGoogleNewsUrl(f.xmlUrl));
  const gnewsIds = new Set(gnewsFeeds.map((f) => f.id));
  const queue = feeds.filter((f) => !gnewsIds.has(f.id));
  const results: PollFeedResult[] = [];

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const normalWork = Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      let feed: FeedRow | undefined;
      while ((feed = queue.shift())) results.push(await pollOne(feed));
    }),
  );
  const gnewsWork = (async () => {
    for (let i = 0; i < gnewsFeeds.length; i++) {
      if (i > 0) await sleep(GNEWS_DELAY_MS);
      let result = await pollOne(gnewsFeeds[i]);
      if (result.error?.includes('503')) {
        await sleep(GNEWS_RETRY_DELAY_MS);
        result = await pollOne(gnewsFeeds[i]);
      }
      results.push(result);
    }
  })();
  await Promise.all([normalWork, gnewsWork]);

  const added = results.reduce((n, r) => n + r.newCount, 0);
  const errors = results.filter((r) => r.error);
  const sameArticle = results.reduce((n, r) => n + (r.sameArticle ?? 0), 0);
  return { feedCount: feeds.length, sameArticle, added, errors, results };
}
