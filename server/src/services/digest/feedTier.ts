import { isGoogleNewsUrl } from './gnews.js';

export type DigestFeedTier = 'none' | 'primary';

export const FEED_TIERS: readonly DigestFeedTier[] = ['none', 'primary'];

export const TIER_LABEL: Record<DigestFeedTier, string> = {
  none: '分類しない',
  primary: '一次情報',
};

export function normalizeTier(value: unknown): DigestFeedTier {
  return value === 'primary' ? 'primary' : 'none';
}

export function isFeedTier(value: unknown): value is DigestFeedTier {
  return typeof value === 'string' && (FEED_TIERS as readonly string[]).includes(value);
}

export function tierLabel(tier: string | null | undefined): string {
  return TIER_LABEL[normalizeTier(tier)];
}

export function siteHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

const OFFICIAL_SUFFIXES = ['.go.jp', '.lg.jp', '.gov'];

export function isOfficialGovernmentHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  const dotted = `.${h}`;
  if (OFFICIAL_SUFFIXES.some((s) => dotted.endsWith(s))) return true;
  if (/(^|\.)gov\.[a-z]{2}$/.test(h)) return true;
  if (/(^|\.)(pref|city|town|vill)\.[a-z0-9-]+(\.[a-z0-9-]+)?\.jp$/.test(h)) return true;
  return false;
}

export function articleSource(row: {
  feedTitle?: string | null;
  feedTier?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  url?: string | null;
}): { feedTitle: string | null; feedTier: DigestFeedTier; sourceSite: string | null } {
  const aggregated = Boolean(row.sourceUrl) || (row.url ? isGoogleNewsUrl(row.url) : false);
  const sourceSite = siteHost(row.sourceUrl) ?? (aggregated ? null : siteHost(row.url));
  const feedTier: DigestFeedTier = isOfficialGovernmentHost(sourceSite)
    ? 'primary'
    : aggregated ? 'none' : normalizeTier(row.feedTier);
  return {
    feedTitle: row.sourceName?.trim() || row.feedTitle || null,
    feedTier,
    sourceSite,
  };
}
