

const STALE_FEED_DAYS = 21;
const STALE_FEED_MAX_DAYS = 120;
const STALE_GAP_MULTIPLIER = 3;

export type FeedHealthWarning =
  | 'stale'
  | 'no-hits';

export function feedStaleThresholdDays(articleCount: number, spanDays: number | null): number {
  if (articleCount < 4 || spanDays == null || spanDays <= 0) return STALE_FEED_DAYS;
  const avgGapDays = spanDays / (articleCount - 1);
  const scaled = Math.ceil(avgGapDays * STALE_GAP_MULTIPLIER);
  return Math.min(Math.max(STALE_FEED_DAYS, scaled), STALE_FEED_MAX_DAYS);
}

export function feedHealthWarning(
  f: {
    status: string;
    kind: string;
    lastPublishedAt: Date | null;
    createdAt: Date;
    articleCount: number;
    spanDays: number | null;
  },
  now: number = Date.now(),
): FeedHealthWarning | null {
  if (f.status === 'paused') return null;
  const basis = f.lastPublishedAt ?? f.createdAt;
  const silentDays = (now - basis.getTime()) / (24 * 3600_000);
  if (silentDays <= feedStaleThresholdDays(f.articleCount, f.spanDays)) return null;
  return f.kind === 'gnews' ? 'no-hits' : 'stale';
}

export function nextLastPublishedAt(existing: Date | null, candidate: Date | null): Date | null {
  if (candidate === null) return existing;
  if (existing === null) return candidate;
  return candidate > existing ? candidate : existing;
}

export function latestPublishedAt(isoDates: Array<string | null | undefined>): Date | null {
  let max: Date | null = null;
  for (const iso of isoDates) {
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    if (max === null || d > max) max = d;
  }
  return max;
}
