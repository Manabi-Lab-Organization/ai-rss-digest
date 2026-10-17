
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles, digestFeeds, digestResearch, users } from '../../db/schema.js';
import {
  cachedSystem,
  createMessage,
  messageText,
  getGenerateModel,
  type CreateMessageFn,
} from './anthropicClient.js';
import { fetchArticleText } from './fetchArticle.js';
import { sendDigestResearchEmail } from '../emailService.js';

export function getResearchModel(): string {
  return process.env.DIGEST_RESEARCH_MODEL || getGenerateModel();
}

const MAX_WEB_SEARCHES = 6;
const MAX_TOKENS = 4000;
const MIN_REPORT_CHARS = 200;

export interface ResearchArticleInput {
  title: string;
  url: string;
  feedTitle?: string | null;
  publishedAt?: string | null;
  summary?: string | null;
}

export function buildResearchPrompt(
  article: ResearchArticleInput,
  { fullText = '' }: { fullText?: string } = {},
): { system: string; user: string } {
  const system = `あなたは「AI RSS Digest」の調査記者です。読者（本紙の利用者。多忙なビジネスプロフェッショナルで、プロとして情報収集している）が紙面で「この記事を深く調べて」と依頼しました。
Web検索で事実関係・背景・関連報道を補強し、日本語の調査レポートを書いてください。

構成（この順の見出しで）:
【何が起きたか】【背景・経緯】【関連する動き・各所の反応】【多角的な視点】【読者の事業への示唆】【主な出典】
要件:
- ファクト中心。数字・固有名詞・日付を具体的に。推測や見解は「〜とみられる」等で事実と区別する
- 元記事の要約に留まらず、検索で得た新しい情報を必ず加える
- 全体で1000〜2000字。出典は【主な出典】にURL付きで列挙する
- 前置きや「レポートします」等のメタ発言は書かず、本文から始める`;

  const user = [
    `## 調査対象の記事`,
    `タイトル: ${article.title ?? ''}`,
    `出典: ${article.feedTitle ?? ''} ${article.url ?? ''}`,
    `公開日時: ${article.publishedAt ?? '不明'}`,
    article.summary ? `紙面での要約: ${article.summary.replaceAll('｜', ' / ')}` : null,
    fullText ? `\n## 元記事の本文（抜粋）\n${fullText.slice(0, 4000)}` : null,
    `\n上記についてWeb検索で調査し、レポートを書いてください。`,
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

export async function researchArticle(
  article: ResearchArticleInput,
  {
    fullText = '',
    createMessageFn = (body) => createMessage(body, { stage: 'research' }),
  }: { fullText?: string; createMessageFn?: CreateMessageFn } = {},
): Promise<string> {
  const { system, user } = buildResearchPrompt(article, { fullText });
  const res = await createMessageFn({
    model: getResearchModel(),
    max_tokens: MAX_TOKENS,
    system: cachedSystem(system),
    messages: [{ role: 'user', content: user }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
  });
  const report = messageText(res).trim();
  if (report.length < MIN_REPORT_CHARS) {
    throw new Error(`レポートが短すぎます（${report.length}字）`);
  }
  return report;
}

export function articleHeadline(summary: string | null | undefined, title: string): string {
  return (summary ?? '').split('｜')[0].trim() || title;
}

export interface RunResearchResult {
  articleId: number;
  reportLength: number;
}

export async function runResearch(
  userId: number,
  articleId: number,
  { createMessageFn }: { createMessageFn?: CreateMessageFn } = {},
): Promise<RunResearchResult> {
  const [article] = await db
    .select({
      id: digestArticles.id,
      title: digestArticles.title,
      url: digestArticles.url,
      publishedAt: digestArticles.publishedAt,
      summary: digestArticles.summary,
      summaryRaw: digestArticles.summaryRaw,
      content: digestArticles.content,
      feedTitle: digestFeeds.title,
    })
    .from(digestArticles)
    .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
    .where(and(eq(digestArticles.id, articleId), eq(digestArticles.userId, userId)));
  if (!article) throw new Error(`記事が見つかりません（articleId=${articleId}）`);

  await db
    .insert(digestResearch)
    .values({ userId, articleId, status: 'running' })
    .onConflictDoUpdate({
      target: [digestResearch.userId, digestResearch.articleId],
      set: { status: 'running', report: null, completedAt: null, visualStatus: null, visualHtml: null },
    });

  try {
    const fullText =
      (await fetchArticleText(article.url)) ?? article.content ?? article.summaryRaw ?? '';

    const report = await researchArticle(
      {
        title: article.title,
        url: article.url,
        feedTitle: article.feedTitle,
        publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
        summary: article.summary,
      },
      { fullText, createMessageFn },
    );

    const [doneRow] = await db
      .update(digestResearch)
      .set({ status: 'done', report, completedAt: new Date() })
      .where(and(eq(digestResearch.userId, userId), eq(digestResearch.articleId, articleId)))
      .returning({ id: digestResearch.id });

    try {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (user?.email && !user.email.startsWith('deleted+')) {
        await sendDigestResearchEmail({
          to: user.email,
          headline: articleHeadline(article.summary, article.title),
          report,
          articleUrl: article.url,
          researchId: doneRow?.id,
          visualPending: true,
        });
      }
    } catch (err) {
      console.error('[Digest:research] メール通知に失敗しました（レポートは保存済み）:', err);
    }

    if (doneRow?.id != null) {
      try {
        const { runResearchVisual } = await import('./researchVisual.js');
        await runResearchVisual(userId, doneRow.id, { createMessageFn });
      } catch (err) {
        console.error('[Digest:research] ビジュアル版の生成に失敗（レポートは完成済み）:', String((err as Error).message || err).slice(0, 200));
      }
    }

    return { articleId, reportLength: report.length };
  } catch (err) {
    await db
      .update(digestResearch)
      .set({ status: 'failed', completedAt: null })
      .where(and(eq(digestResearch.userId, userId), eq(digestResearch.articleId, articleId)))
      .catch(() => {});
    throw err;
  }
}
