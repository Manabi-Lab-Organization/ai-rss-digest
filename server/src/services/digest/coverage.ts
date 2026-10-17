import { and, asc, eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles, digestEditions, digestFeeds } from '../../db/schema.js';
import { DEFAULT_SECTIONS } from './generate.js';

export const AI_SECTIONS = ['テクノロジー・AI'];

export const AI_PATTERN =
  /\bAI\b|人工知能|\bLLM\b|大規模言語モデル|ChatGPT|\bGPT-?\d|\bClaude\b|\bGemini\b|OpenAI|Anthropic|機械学習|生成モデル|基盤モデル/;

export function mentionsAi(text: string | null | undefined): boolean {
  return AI_PATTERN.test(String(text ?? ''));
}

export const DEFAULT_COVERAGE_DAYS = 30;

export interface CoverageRow {
  id: number;
  editionId: number;
  editionDate: string;
  section: string | null;
  summary: string | null;
  title: string;
  feedTitle: string | null;
}

export interface CoverageStats {
  days: number;
  editions: number;
  articles: number;
  sections: Array<{ section: string; count: number; share: number }>;
  ai: {
    sectionCount: number;
    sectionShare: number;
    generalTotal: number;
    generalAiCount: number;
    generalAiShare: number;
  };
  feeds: Array<{ feedTitle: string; count: number; share: number }>;
}

const headlineOf = (row: CoverageRow): string =>
  String(row.summary ?? '').split('｜')[0].trim() || row.title.trim() || '(見出しなし)';
const leadOf = (row: CoverageRow): string => String(row.summary ?? '').split('｜')[1] ?? '';
const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 100) : 0);

export function summarizeCoverage(
  rows: CoverageRow[],
  {
    days = DEFAULT_COVERAGE_DAYS,
    sections: sectionOrder = DEFAULT_SECTIONS,
  }: {
    days?: number;
    sections?: string[];
  } = {},
): CoverageStats {
  const articles = rows.length;
  const editions = new Set(rows.map((r) => r.editionId)).size;

  const bySection = new Map<string, number>();
  for (const r of rows) {
    const key = r.section ?? '(面なし)';
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  const sections = [...sectionOrder, ...[...bySection.keys()].filter((s) => !sectionOrder.includes(s))]
    .filter((s) => bySection.has(s))
    .map((section) => ({ section, count: bySection.get(section)!, share: pct(bySection.get(section)!, articles) }));

  const isAiSection = (r: CoverageRow) => AI_SECTIONS.includes(r.section ?? '');
  const aiSectionCount = rows.filter(isAiSection).length;
  const general = rows.filter((r) => !isAiSection(r));
  const generalAi = general.filter((r) => mentionsAi(`${headlineOf(r)} ${leadOf(r)}`));
  const ai = {
    sectionCount: aiSectionCount,
    sectionShare: pct(aiSectionCount, articles),
    generalTotal: general.length,
    generalAiCount: generalAi.length,
    generalAiShare: pct(generalAi.length, general.length),
  };

  const byFeed = new Map<string, number>();
  for (const r of rows) {
    const key = (r.feedTitle ?? '').trim() || '(出典不明)';
    byFeed.set(key, (byFeed.get(key) ?? 0) + 1);
  }
  const feeds = [...byFeed.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([feedTitle, count]) => ({ feedTitle, count, share: pct(count, articles) }));

  return {
    days,
    editions,
    articles,
    sections,
    ai,
    feeds,
  };
}

export function formatCoverageFacts(stats: CoverageStats, { today }: { today?: string } = {}): string {
  const { days, editions, articles, sections, ai, feeds } = stats;
  if (!articles) return `紙面の実績: 直近${days}日に掲載記事がありません（集計対象なし）`;
  const dateNote = today ? `・集計日 ${today}` : '';
  const lines = [
    `紙面の実績（直近${days}日・${editions}号・掲載${articles}本${dateNote}）`,
    `■ 面ごとの本数: ${sections.map((s) => `${s.section} ${s.count}本(${s.share}%)`).join(' / ')}`,
    `■ AI面（${AI_SECTIONS.join('＋')}）の比率: ${ai.sectionShare}%（${ai.sectionCount}本）`,
    `■ AI面以外の記事のうち、見出し・リードがAIに触れるもの: ${ai.generalAiShare}%（${ai.generalAiCount}本/${ai.generalTotal}本）※語句の機械判定なので目安`,
    `■ 出典の偏り（上位）: ${feeds.map((f) => `${f.feedTitle} ${f.share}%`).join(' / ')}`,
  ];
  return lines.join('\n');
}

export function coverageFactsBlock(coverageText: string | null | undefined): string[] {
  const facts = String(coverageText ?? '').trim();
  return facts ? ['<coverage_facts>', facts, '</coverage_facts>', ''] : [];
}

export async function loadCoverageRows(
  userId: number,
  { days = DEFAULT_COVERAGE_DAYS }: { days?: number } = {},
): Promise<CoverageRow[]> {
  const since = new Date(Date.now() - Math.max(1, Math.floor(days)) * 24 * 3600_000);
  const rows = await db
    .select({
      id: digestArticles.id,
      editionId: digestEditions.id,
      editionDate: digestEditions.editionDate,
      section: digestArticles.section,
      summary: digestArticles.summary,
      title: digestArticles.title,
      feedTitle: digestFeeds.title,
    })
    .from(digestArticles)
    .innerJoin(digestEditions, eq(digestArticles.editionId, digestEditions.id))
    .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
    .where(and(
      eq(digestArticles.userId, userId),
      eq(digestArticles.included, true),
      eq(digestEditions.status, 'done'),
      gte(digestEditions.createdAt, since),
    ))
    .orderBy(asc(digestEditions.createdAt), asc(digestEditions.id), asc(digestArticles.id));
  return rows;
}

const jstToday = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export async function coverageFactsForUser(
  userId: number,
  { days = DEFAULT_COVERAGE_DAYS }: { days?: number } = {},
): Promise<string> {
  const rows = await loadCoverageRows(userId, { days });
  return formatCoverageFacts(summarizeCoverage(rows, { days }), { today: jstToday() });
}

export async function coverageFactsForUserSafe(
  userId: number,
  opts: { days?: number } = {},
): Promise<string> {
  try {
    return await coverageFactsForUser(userId, opts);
  } catch (err) {
    console.error(`[Digest:coverage] user=${userId} 紙面の実績の集計に失敗（実績なしで続行）:`, err);
    return '';
  }
}
