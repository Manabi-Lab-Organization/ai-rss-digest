
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles, digestFeeds, digestFeedback, digestProfiles, digestEditorialProposals, users } from '../../db/schema.js';
import {
  createMessage,
  messageText,
  getGenerateModel,
  type CreateMessageFn,
} from './anthropicClient.js';
import { DEFAULT_EDITORIAL_PROFILE } from './editorialProfile.js';
import { coverageFactsBlock, coverageFactsForUserSafe } from './coverage.js';
import { sendDigestProfileReviewEmail } from '../emailService.js';

const MAX_TOKENS = 8000;
export const REVIEW_THRESHOLD = 10;
const FALLBACK_WINDOW_DAYS = 14;
const MAX_RATED = 200;
const MAX_OPINIONS = 50;

export function shouldRunReview(signalCount: number, threshold = REVIEW_THRESHOLD): boolean {
  return signalCount >= threshold;
}

export interface RatedSignal {
  rating: number;
  headline: string;
  section: string | null;
  included: boolean;
  sourceTitle: string | null;
  reason?: string | null;
}

export interface OpinionSignal {
  createdAt: string;
  comment: string;
}

export function buildReviewPrompt(
  profileText: string,
  rated: RatedSignal[],
  opinions: OpinionSignal[],
  coverageText?: string | null,
): { system: string; user: string } {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const facts = coverageFactsBlock(coverageText);
  const system = [
    'あなたは「AI RSS Digest」の編集委員です。読者が紙面に付けた👍👎評価と自由記述の意見を分析し、',
    '編集方針プロファイルの改定版を作成してください。',
    '',
    '<editorial_profile>',
    profileText.trim(),
    '</editorial_profile>',
    '',
    ...facts,
    '制約（厳守）:',
    '- 👍は「この選定・この種の記事を増やしたい」、👎は「不要・今後拾わない」のシグナル',
    '- 「本編」の評価は採用判断への評価、「非採用」の評価は取りこぼし（👍=拾うべきだった）への評価',
    '- **理由が書かれている評価は最優先で扱う**。読者が自分の言葉で述べた判断根拠であり、👍👎だけの',
    '  評価より確度が高い。理由が示す観点は、1件しかなくても方針へ反映してよい',
    '- ただし理由は個別の記事について書かれている。記事名・企業名をそのまま方針に書き写すのではなく、',
    '  次号以降に再現できる判断ルールへ翻訳する（例:「海外の話ばかりで国内の制度の変更が抜けている」→',
    '  「国内の制度改正の重みを一段上げる」）',
    '- 理由の無い評価は、同じ傾向が複数件そろって初めてシグナルとみなす',
    '- 少数の評価から過剰に一般化しない。確度の低い変更は今回は見送る（現行のまま残す）',
    ...(facts.length
      ? ['- <coverage_facts> は紙面全体の実測値。評価の無い記事に現れる偏り（面の比率・AI偏重・出典の偏り）は'
        + 'ここから読み取り、「変更点」の要約で数字を引用する。数字に無いことは断定しない']
      : []),
    '- プロファイルの構造（トピックの重み・信頼度ティア・新規性・既知性・良い/悪い選定の例）は保ち、変更は最小限の差分に留める',
    '',
    '出力形式（厳守）:',
    '- この出力は読者の承認後に**そのまま**編集方針プロファイルとして保存される。改定後のプロファイル全文をmarkdownで出力すること',
    '- 前置き・後書き・コードフェンスは書かない。1行目からプロファイル本文を始める',
    `- 冒頭に「# 変更点(${today}): 〜」のコメント行（1〜5行）で今回の変更概要を要約する。`,
    '  変更が無い場合は「# 変更点: 今回は変更なし」と1行書き、以降は現行プロファイルをそのまま出力する',
  ].join('\n');

  const ratedLine = (r: RatedSignal) => {
    const mark = r.rating > 0 ? '👍' : '👎';
    const where = r.included ? '本編' : '非採用';
    const reason = r.reason ? `\n    理由（読者本人の記述）: ${r.reason}` : '';
    return `- ${mark} [${where}/${r.section ?? '?'}] ${r.headline}（${r.sourceTitle ?? '出典不明'}）${reason}`;
  };
  const withReason = rated.filter((r) => r.reason).length;
  const user = [
    `評価一覧（${rated.length}件、新しい順${withReason > 0 ? `。うち${withReason}件は読者が理由を書いている` : ''}）:`,
    ...(rated.length ? rated.map(ratedLine) : ['（なし）']),
    '',
    `読者の意見（${opinions.length}件、新しい順）:`,
    ...(opinions.length ? opinions.map((o) => `- [${o.createdAt}] ${o.comment}`) : ['（なし）']),
  ].join('\n');

  return { system, user };
}

export async function reviewProfile(
  { profileText, rated, opinions, coverageText }: {
    profileText: string;
    rated: RatedSignal[];
    opinions: OpinionSignal[];
    coverageText?: string | null;
  },
  { createMessageFn = (body) => createMessage(body, { stage: 'profile-review' }) }: { createMessageFn?: CreateMessageFn } = {},
): Promise<string> {
  const { system, user } = buildReviewPrompt(profileText, rated, opinions, coverageText);
  const response = await createMessageFn({
    model: getGenerateModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const proposal = messageText(response).trim();
  if (proposal.length < 100) throw new Error(`改定案が短すぎます（${proposal.length}字）`);
  return proposal;
}

export interface ReviewSignals {
  ratedCount: number;
  opinionCount: number;
  total: number;
  since: Date;
  lastReviewAt: Date | null;
}

export async function countReviewSignals(userId: number): Promise<ReviewSignals> {
  const [profile] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
  const lastReviewAt = profile?.lastReviewAt ?? null;
  const since = lastReviewAt ?? new Date(Date.now() - FALLBACK_WINDOW_DAYS * 24 * 3600_000);

  const [{ count: ratedCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(digestArticles)
    .where(and(
      eq(digestArticles.userId, userId),
      isNotNull(digestArticles.humanRating),
      gte(digestArticles.fetchedAt, since),
    ));
  const [{ count: opinionCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(digestFeedback)
    .where(and(
      eq(digestFeedback.userId, userId),
      gte(digestFeedback.createdAt, since),
      isNull(digestFeedback.articleId),
    ));

  return { ratedCount, opinionCount, total: ratedCount + opinionCount, since, lastReviewAt };
}

export type ProfileReviewResult =
  | { status: 'skipped'; signals: number; threshold: number }
  | { status: 'proposed'; proposalId: number; signals: number };

export async function runProfileReview(
  userId: number,
  { createMessageFn }: { createMessageFn?: CreateMessageFn } = {},
): Promise<ProfileReviewResult> {
  const signals = await countReviewSignals(userId);
  if (!shouldRunReview(signals.total)) {
    console.log(`[Digest:profile-review] user=${userId} シグナル${signals.total}件（閾値${REVIEW_THRESHOLD}未満）のためスキップ`);
    return { status: 'skipped', signals: signals.total, threshold: REVIEW_THRESHOLD };
  }

  const [profile] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
  const profileText = profile?.editorialProfile || DEFAULT_EDITORIAL_PROFILE;

  const summaryHeadline = (summary: string | null, title: string) =>
    (summary ?? '').split('｜')[0].trim() || title;

  const ratedRows = await db
    .select({
      id: digestArticles.id,
      rating: digestArticles.humanRating,
      title: digestArticles.title,
      summary: digestArticles.summary,
      section: digestArticles.section,
      included: digestArticles.included,
      sourceTitle: digestFeeds.title,
    })
    .from(digestArticles)
    .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
    .where(and(
      eq(digestArticles.userId, userId),
      isNotNull(digestArticles.humanRating),
      gte(digestArticles.fetchedAt, signals.since),
    ))
    .orderBy(desc(digestArticles.id))
    .limit(MAX_RATED);

  const ratedIds = ratedRows.map((r) => r.id);
  const reasonRows = ratedIds.length
    ? await db
        .select({ articleId: digestFeedback.articleId, comment: digestFeedback.comment })
        .from(digestFeedback)
        .where(and(eq(digestFeedback.userId, userId), inArray(digestFeedback.articleId, ratedIds)))
        .orderBy(desc(digestFeedback.id))
    : [];
  const reasonByArticle = new Map<number, string>();
  for (const row of reasonRows) {
    if (row.articleId !== null && !reasonByArticle.has(row.articleId)) {
      reasonByArticle.set(row.articleId, row.comment);
    }
  }

  const rated: RatedSignal[] = ratedRows.map((r) => ({
    rating: r.rating ?? 0,
    headline: summaryHeadline(r.summary, r.title),
    section: r.section,
    included: r.included,
    sourceTitle: r.sourceTitle,
    reason: reasonByArticle.get(r.id) ?? null,
  }));

  const opinionRows = await db
    .select({ createdAt: digestFeedback.createdAt, comment: digestFeedback.comment })
    .from(digestFeedback)
    .where(and(
      eq(digestFeedback.userId, userId),
      gte(digestFeedback.createdAt, signals.since),
      isNull(digestFeedback.articleId),
    ))
    .orderBy(desc(digestFeedback.createdAt))
    .limit(MAX_OPINIONS);
  const opinions: OpinionSignal[] = opinionRows.map((o) => ({
    createdAt: o.createdAt.toISOString().slice(0, 10),
    comment: o.comment,
  }));

  const coverageText = await coverageFactsForUserSafe(userId);

  const proposal = await reviewProfile({ profileText, rated, opinions, coverageText }, { createMessageFn });

  const [inserted] = await db
    .insert(digestEditorialProposals)
    .values({ userId, content: proposal, status: 'proposed' })
    .returning({ id: digestEditorialProposals.id });

  const now = new Date();
  const updated = await db
    .update(digestProfiles)
    .set({ lastReviewAt: now, updatedAt: now })
    .where(eq(digestProfiles.userId, userId))
    .returning({ userId: digestProfiles.userId });
  if (updated.length === 0) {
    await db.insert(digestProfiles)
      .values({ userId, settings: {}, lastReviewAt: now })
      .onConflictDoNothing();
  }

  try {
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (user?.email && !user.email.startsWith('deleted+')) {
      await sendDigestProfileReviewEmail({
        to: user.email,
        proposalId: inserted.id,
        proposal,
        ratedCount: rated.length,
        opinionCount: opinions.length,
      });
    }
  } catch (err) {
    console.error(`[Digest:profile-review] メール送信失敗（提案#${inserted.id}は起票済み）: ${String((err as Error).message || err).slice(0, 200)}`);
  }

  console.log(`[Digest:profile-review] user=${userId} 評価${rated.length}件・意見${opinions.length}件 → 提案#${inserted.id}を起票`);
  return { status: 'proposed', proposalId: inserted.id, signals: signals.total };
}
