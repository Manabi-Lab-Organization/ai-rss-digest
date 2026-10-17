
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestProfiles, digestFeeds, digestEditions } from '../../db/schema.js';
import { runDigestJob } from './jobRunner.js';

const TICK_INTERVAL_MS = 60_000;
const POLL_MINUTE = 7;
const DEFAULT_DELIVERY_HOUR = 6;
export const REVIEW_DOW = 0;
export const REVIEW_HOUR = 17;
const STORAGE_HOUR = 4;
export const SUGGEST_DOM = 1;
export const SUGGEST_DOW = 0;
export const SUGGEST_HOUR = 18;

let timer: NodeJS.Timeout | null = null;
let lastPollKey = '';
let lastEditionKey = '';
let lastReviewKey = '';
let lastStorageKey = '';
let lastSuggestKey = '';
const lastSuggestKeyByUser = new Map<number, string>();

function jstNow(): {
  hour: number; minute: number; dow: number; dom: number; date: string; key: string; monthKey: string;
} {
  const jst = new Date(Date.now() + 9 * 3600_000);
  return {
    dom: jst.getUTCDate(),
    monthKey: jst.toISOString().slice(0, 7),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
    dow: jst.getUTCDay(),
    date: jst.toISOString().slice(0, 10),
    key: `${jst.toISOString().slice(0, 10)}T${jst.getUTCHours()}`,
  };
}

export function normalizeSuggestFrequency(raw: string | undefined): 'off' | 'monthly' | 'weekly' {
  return raw === 'off' || raw === 'weekly' ? raw : 'monthly';
}

export function sourceSuggestDue(freq: 'off' | 'monthly' | 'weekly', dom: number, dow: number): boolean {
  if (freq === 'off') return false;
  return freq === 'weekly' ? dow === SUGGEST_DOW : dom === SUGGEST_DOM;
}

export function frequencyMatches(frequency: string | undefined, dow: number): boolean {
  if (frequency === 'weekly3') return dow === 1 || dow === 3 || dow === 5;
  if (frequency === 'weekly1') return dow === 1;
  return true;
}

async function runDueEditions(hour: number, dow: number, date: string): Promise<void> {
  const profiles = await db.select().from(digestProfiles);
  for (const p of profiles) {
    const settings = (p.settings ?? {}) as { deliveryHour?: number; frequency?: string };
    const deliveryHour = Number.isInteger(settings.deliveryHour) ? settings.deliveryHour! : DEFAULT_DELIVERY_HOUR;
    if (deliveryHour !== hour) continue;
    if (!frequencyMatches(settings.frequency, dow)) continue;

    const [{ count: feedCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(digestFeeds)
      .where(and(eq(digestFeeds.userId, p.userId), eq(digestFeeds.status, 'active')));
    if (feedCount === 0) continue;

    const [existing] = await db
      .select({ id: digestEditions.id })
      .from(digestEditions)
      .where(and(
        eq(digestEditions.userId, p.userId),
        eq(digestEditions.editionDate, date),
        eq(digestEditions.isFirstIssue, false),
      ))
      .limit(1);
    if (existing) continue;

    void runDigestJob('edition', [String(p.userId)], 30 * 60_000);
  }
}

async function runDueProfileReviews(): Promise<void> {
  const profiles = await db.select({ userId: digestProfiles.userId }).from(digestProfiles);
  for (const p of profiles) {
    const [{ count: feedCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(digestFeeds)
      .where(and(eq(digestFeeds.userId, p.userId), eq(digestFeeds.status, 'active')));
    if (feedCount === 0) continue;
    void runDigestJob('profile-review', [String(p.userId)], 10 * 60_000);
  }
}

async function runDueSourceSuggestions(dom: number, dow: number, date: string, monthKey: string): Promise<void> {
  const profiles = await db
    .select({ userId: digestProfiles.userId, settings: digestProfiles.settings })
    .from(digestProfiles);
  for (const p of profiles) {
    const settings = (p.settings ?? {}) as { sourceSuggestFrequency?: string };
    const freq = normalizeSuggestFrequency(settings.sourceSuggestFrequency);
    if (!sourceSuggestDue(freq, dom, dow)) continue;
    const runKey = freq === 'weekly' ? date : monthKey;
    if (lastSuggestKeyByUser.get(p.userId) === runKey) continue;
    lastSuggestKeyByUser.set(p.userId, runKey);
    void runDigestJob('source-suggest', [String(p.userId)], 10 * 60_000);
  }
}

async function tick(): Promise<void> {
  const { hour, minute, dow, dom, date, key, monthKey } = jstNow();
  if (minute >= POLL_MINUTE && lastPollKey !== key) {
    lastPollKey = key;
    void runDigestJob('poll');
  }
  if (lastEditionKey !== key) {
    lastEditionKey = key;
    await runDueEditions(hour, dow, date);
  }
  if (dow === REVIEW_DOW && hour === REVIEW_HOUR && lastReviewKey !== key) {
    lastReviewKey = key;
    await runDueProfileReviews();
  }
  if (hour === STORAGE_HOUR && lastStorageKey !== key) {
    lastStorageKey = key;
    void runDigestJob('storage', [], 10 * 60_000);
  }
  if (hour >= SUGGEST_HOUR && lastSuggestKey !== key) {
    lastSuggestKey = key;
    await runDueSourceSuggestions(dom, dow, date, monthKey);
  }
}

export function startDigestScheduler(): void {
  if (process.env.DIGEST_SCHEDULER_ENABLED === 'false') {
    console.log('[Digest] scheduler disabled (DIGEST_SCHEDULER_ENABLED=false)');
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[Digest] scheduler tick error:', err));
  }, TICK_INTERVAL_MS);
  console.log('[Digest] scheduler started');
}

export function stopDigestScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
