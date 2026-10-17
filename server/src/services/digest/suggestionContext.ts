
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles } from '../../db/schema.js';

const CONTEXT_WINDOW_DAYS = 30;
const MAX_ARTICLE_RATINGS = 100;

export interface SuggestionContextInput {
  articleRatings: Array<{ rating: number; headline: string }>;
}

export interface SuggestionContext extends SuggestionContextInput {
  text: string;
  signalCount: number;
}

const mark = (rating: number) => (rating > 0 ? '👍' : '👎');

export function formatSuggestionContext(input: SuggestionContextInput): string {
  if (input.articleRatings.length === 0) return '';
  return [
    '## ダイジェスト紙面の記事への評価（👍=この種の内容に関心が強い / 👎=関心が薄い）',
    ...input.articleRatings.map((r) => `- ${mark(r.rating)} ${r.headline}`),
  ].join('\n');
}

export async function collectSuggestionContext(userId: number): Promise<SuggestionContext> {
  const since = new Date(Date.now() - CONTEXT_WINDOW_DAYS * 24 * 3600_000);
  const ratedArticles = await db
    .select({
      rating: digestArticles.humanRating,
      title: digestArticles.title,
      summary: digestArticles.summary,
    })
    .from(digestArticles)
    .where(and(
      eq(digestArticles.userId, userId),
      isNotNull(digestArticles.humanRating),
      sql`${digestArticles.humanRating} != 0`,
      gte(digestArticles.fetchedAt, since),
    ))
    .orderBy(desc(digestArticles.id))
    .limit(MAX_ARTICLE_RATINGS);

  const input: SuggestionContextInput = {
    articleRatings: ratedArticles.map((r) => ({
      rating: r.rating ?? 0,
      headline: (r.summary ?? '').split('｜')[0].trim() || r.title,
    })),
  };
  return { ...input, text: formatSuggestionContext(input), signalCount: input.articleRatings.length };
}
