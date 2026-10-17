
import { articleSource } from './feedTier.js';
import { and, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestFeeds, digestArticles, digestEditions, digestProfiles, users } from '../../db/schema.js';
import { triageBatch, applyFeedWeight, BATCH_SIZE } from './triage.js';
import {
  pickRepresentatives, generateBatch, selectTopPerSection, DEFAULT_SECTIONS, PER_SECTION,
  materialChars, THIN_MATERIAL_CHARS,
  type GenerateArticle, type GeneratedArticle, type Representative,
} from './generate.js';
import {
  dedupeRound, dedupeUntilStable, splitStoredSummary, type DedupeItem, type VerifyVerdict,
} from './dedupe.js';
import { enrichWithFullText, formatEnrichFailures } from './fetchArticle.js';
import { proofreadArticles } from './proofread.js';
import { DEFAULT_EDITORIAL_PROFILE } from './editorialProfile.js';
import { pollFeeds, formatSameArticle } from './poller.js';
import { sendDigestEditionEmail } from '../emailService.js';

const MIN_SCORE = 3;
const WINDOW_HOURS = Number(process.env.DIGEST_WINDOW_HOURS || 24);
const CLUSTER_WINDOW_HOURS = Number(process.env.CLUSTER_WINDOW_HOURS || 72);
const MAX_REPRESENTATIVES = 60;
const TRIAGE_LIMIT = Number(process.env.TRIAGE_LIMIT || 1000);
const FIRST_ISSUE_PER_FEED = 10;
const FIRST_ISSUE_MAX_AGE_DAYS = 90;
const PUBLISHED_SLACK = 1.25;
const BRIEF_THRESHOLD = 12;
const GROWING_MIN_FEEDS = 8;

export interface EditionContentArticle {
  articleId: number;
  headline: string;
  lead: string;
  body: string;
  url: string;
  sourceTitle: string | null;
  score: number | null;
  sourceCount?: number;
}

export interface EditionContentOtherArticle {
  articleId: number;
  headline: string;
  url: string;
  sourceTitle: string | null;
  publishedAt: string | null;
}

export interface EditionEditorialNote {
  feedCount: number;
  candidateCount: number;
  adoptedCount: number;
  emptySections: string[];
}

export interface EditionContent {
  format: 'brief' | 'paper';
  sections: Array<{ name: string; articles: EditionContentArticle[] }>;
  candidateCount: number;
  sourceCount: number;
  note?: string;
  coverage?: string;
  others?: Array<{ name: string; articles: EditionContentOtherArticle[] }>;
  editorialNote?: EditionEditorialNote;
}

export const OTHERS_PER_SECTION = 8;
export function buildOthersSections(
  reps: Representative[],
  generated: Map<string, GeneratedArticle>,
  selected: Set<string>,
  byId: Map<string, { url: string; feedTitle?: string | null; triageScore?: number | null; publishedAt?: Date | null }>,
): EditionContent['others'] {
  const others: NonNullable<EditionContent['others']> = [];
  for (const name of DEFAULT_SECTIONS) {
    const articles = reps
      .filter((r) => !selected.has(r.rep.id) && generated.get(r.rep.id)?.section === name)
      .sort((a, b) => (b.rep.triageScore ?? 0) - (a.rep.triageScore ?? 0))
      .slice(0, OTHERS_PER_SECTION)
      .map((r) => {
        const g = generated.get(r.rep.id)!;
        const c = byId.get(r.rep.id);
        return {
          articleId: Number(r.rep.id),
          headline: g.headline,
          url: c?.url ?? '',
          sourceTitle: c?.feedTitle ?? null,
          publishedAt: c?.publishedAt ? new Date(c.publishedAt).toISOString() : null,
        };
      })
      .filter((a) => a.url);
    if (articles.length > 0) others.push({ name, articles });
  }
  return others.length > 0 ? others : undefined;
}

interface CandidateRow extends GenerateArticle {
  url: string;
}

function jstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function jstTitle(dateStr: string, firstIssue: boolean): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return firstIssue ? `${m}月${d}日 創刊号` : `${m}月${d}日 朝刊`;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}

export function windowHoursForFrequency(frequency: string | undefined): number {
  if (frequency === 'weekly3') return WINDOW_HOURS * 3;
  if (frequency === 'weekly1') return WINDOW_HOURS * 7;
  return WINDOW_HOURS;
}

export function publishedWindowHours(windowHours: number): number {
  return Math.ceil(windowHours * PUBLISHED_SLACK);
}

export function buildCoverageLabel(firstIssue: boolean, windowHours: number, now: Date = new Date()): string {
  if (firstIssue) return `各情報源の最新記事（過去${FIRST_ISSUE_MAX_AGE_DAYS}日以内）`;
  const fmt = (d: Date) => {
    const jst = new Date(d.getTime() + 9 * 3600_000);
    return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.getUTCHours()}時`;
  };
  const from = new Date(now.getTime() - windowHours * 3600_000);
  const span = windowHours % 24 === 0 && windowHours > 24 ? `${windowHours / 24}日間` : `${windowHours}時間`;
  return `${fmt(from)} 〜 ${fmt(now)}（直近${span}）`;
}

export async function loadUserEditorialProfile(userId: number): Promise<string> {
  const [profile] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
  if (profile?.editorialProfile) return profile.editorialProfile;
  if (profile) {
    await db.update(digestProfiles)
      .set({ editorialProfile: DEFAULT_EDITORIAL_PROFILE, updatedAt: new Date() })
      .where(eq(digestProfiles.userId, userId));
  } else {
    await db.insert(digestProfiles)
      .values({ userId, settings: {}, editorialProfile: DEFAULT_EDITORIAL_PROFILE })
      .onConflictDoNothing();
  }
  return DEFAULT_EDITORIAL_PROFILE;
}

async function triageUser(
  userId: number,
  profileText: string,
  { firstIssue, windowHours }: { firstIssue: boolean; windowHours: number },
): Promise<void> {
  if (!firstIssue) {
    await db.update(digestArticles)
      .set({ triageScore: 0 })
      .where(and(
        eq(digestArticles.userId, userId),
        isNull(digestArticles.triageScore),
        sql`${digestArticles.publishedAt} IS NOT NULL AND ${digestArticles.publishedAt} < ${hoursAgo(publishedWindowHours(windowHours) + 24)}`,
      ));
  }

  const articles = await db
    .select({
      id: digestArticles.id,
      title: digestArticles.title,
      url: digestArticles.url,
      summaryRaw: digestArticles.summaryRaw,
      feedTitle: digestFeeds.title,
      feedTier: digestFeeds.tier,
      sourceName: digestArticles.sourceName,
      sourceUrl: digestArticles.sourceUrl,
    })
    .from(digestArticles)
    .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
    .where(and(eq(digestArticles.userId, userId), isNull(digestArticles.triageScore)))
    .orderBy(sql`${digestArticles.fetchedAt} DESC`)
    .limit(TRIAGE_LIMIT);
  if (articles.length === 0) return;

  let scored = 0;
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE).map((a) => ({ ...a, ...articleSource(a), id: String(a.id) }));
    try {
      const scores = await triageBatch(batch, { profileText });
      for (const a of batch) {
        const raw = scores.get(a.id);
        if (raw === undefined) continue;
        await db.update(digestArticles)
          .set({ triageScore: applyFeedWeight(raw) })
          .where(eq(digestArticles.id, Number(a.id)));
        scored++;
      }
    } catch (err) {
      console.error(`[Digest:edition] triageバッチ失敗: ${String((err as Error).message).slice(0, 200)}`);
    }
  }
  console.log(`[Digest:edition] triage: 対象${articles.length}件 / 採点${scored}件`);
}

function clusterWindowCondition(firstIssue: boolean, windowHours: number): SQL {
  return firstIssue
    ? sql`TRUE`
    : gte(digestArticles.fetchedAt, hoursAgo(Math.max(CLUSTER_WINDOW_HOURS, windowHours))) as SQL;
}

export function publishedInMainCondition(): SQL {
  return and(isNotNull(digestArticles.editionId), eq(digestArticles.included, true)) as SQL;
}

const PUBLISHED_DEDUPE_LIMIT = 40;

async function loadPublishedDedupeItems(userId: number, windowCond: SQL): Promise<DedupeItem[]> {
  if (process.env.DEDUPE_AGAINST_PUBLISHED === 'false') return [];
  try {
    const rows = await db
      .select({
        id: digestArticles.id,
        summary: digestArticles.summary,
        section: digestArticles.section,
      })
      .from(digestArticles)
      .where(and(
        eq(digestArticles.userId, userId),
        publishedInMainCondition(),
        isNotNull(digestArticles.summary),
        windowCond,
      ))
      .orderBy(sql`${digestArticles.fetchedAt} DESC`)
      .limit(PUBLISHED_DEDUPE_LIMIT);
    return rows
      .map((r) => ({ id: String(r.id), section: r.section, ...splitStoredSummary(r.summary) }))
      .filter((it) => it.headline !== '');
  } catch (err) {
    console.error(`[Digest:edition] 既報記事の取得に失敗、連日の重複チェックなしで続行: ${String((err as Error).message).slice(0, 160)}`);
    return [];
  }
}

async function loadCandidates(
  userId: number,
  { firstIssue, minScore, windowHours }: { firstIssue: boolean; minScore: number; windowHours: number },
): Promise<CandidateRow[]> {
  const base = {
    id: digestArticles.id,
    feedId: digestArticles.feedId,
    title: digestArticles.title,
    url: digestArticles.url,
    summaryRaw: digestArticles.summaryRaw,
    content: digestArticles.content,
    clusterId: digestArticles.clusterId,
    triageScore: digestArticles.triageScore,
    publishedAt: digestArticles.publishedAt,
    fetchedAt: digestArticles.fetchedAt,
    feedTitle: digestFeeds.title,
    feedTier: digestFeeds.tier,
    sourceName: digestArticles.sourceName,
    sourceUrl: digestArticles.sourceUrl,
  };
  const conds = [
    eq(digestArticles.userId, userId),
    isNull(digestArticles.editionId),
    gte(digestArticles.triageScore, minScore),
  ];
  if (!firstIssue) {
    conds.push(gte(digestArticles.fetchedAt, hoursAgo(windowHours)));
    conds.push(sql`(${digestArticles.publishedAt} IS NULL OR ${digestArticles.publishedAt} >= ${hoursAgo(publishedWindowHours(windowHours))})`);
  } else {
    conds.push(sql`(${digestArticles.publishedAt} IS NULL OR ${digestArticles.publishedAt} >= ${hoursAgo(FIRST_ISSUE_MAX_AGE_DAYS * 24)})`);
  }
  const rows = await db
    .select(base)
    .from(digestArticles)
    .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
    .where(and(...conds));

  let picked = rows;
  if (firstIssue) {
    const byFeed = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = String(r.feedId ?? 'none');
      if (!byFeed.has(key)) byFeed.set(key, []);
      byFeed.get(key)!.push(r);
    }
    picked = [...byFeed.values()].flatMap((list) =>
      list
        .sort((a, b) => (b.publishedAt ?? b.fetchedAt).getTime() - (a.publishedAt ?? a.fetchedAt).getTime())
        .slice(0, FIRST_ISSUE_PER_FEED));
  }
  return picked.map((r) => ({ ...r, ...articleSource(r), id: String(r.id) }));
}

export interface RunEditionResult {
  editionId: number;
  status: 'done' | 'failed';
  articleCount: number;
}

export async function runEdition(userId: number, { firstIssue = false }: { firstIssue?: boolean } = {}): Promise<RunEditionResult> {
  const editionDate = jstToday();
  const [edition] = await db.insert(digestEditions)
    .values({ userId, editionDate, status: 'generating', isFirstIssue: firstIssue, title: jstTitle(editionDate, firstIssue) })
    .returning();

  try {
    const poll = await pollFeeds({ userId });
    console.log(`[Digest:edition] poll: ${poll.feedCount}フィード / 新着${poll.added}件${formatSameArticle(poll.sameArticle)}`);

    const profileText = await loadUserEditorialProfile(userId);

    const [profileRow] = await db
      .select({ settings: digestProfiles.settings })
      .from(digestProfiles)
      .where(eq(digestProfiles.userId, userId));
    const frequency = ((profileRow?.settings ?? {}) as { frequency?: string }).frequency;
    const windowHours = windowHoursForFrequency(frequency);
    const coverage = buildCoverageLabel(firstIssue, windowHours);

    await triageUser(userId, profileText, { firstIssue, windowHours });

    let candidates = await loadCandidates(userId, { firstIssue, minScore: MIN_SCORE, windowHours });
    if (candidates.length === 0 && firstIssue) {
      candidates = await loadCandidates(userId, { firstIssue, minScore: 2, windowHours });
    }

    if (candidates.length === 0) {
      const content: EditionContent = {
        format: 'brief', sections: [], candidateCount: 0, sourceCount: 0, coverage,
        note: '掲載基準を満たす記事がありませんでした。情報源を増やすと紙面が充実します。',
      };
      const [done] = await db.update(digestEditions)
        .set({ status: 'done', format: 'brief', content, articleCount: 0, growingNotice: true, generatedAt: new Date() })
        .where(eq(digestEditions.id, edition.id))
        .returning();
      return { editionId: done.id, status: 'done', articleCount: 0 };
    }

    const reps: Representative[] = pickRepresentatives(candidates)
      .sort((a, b) => b.feedCount - a.feedCount || (b.rep.triageScore ?? 0) - (a.rep.triageScore ?? 0))
      .slice(0, MAX_REPRESENTATIVES);

    const enrich = await enrichWithFullText(reps);
    const thin = reps.filter((r) => materialChars(r.rep) < THIN_MATERIAL_CHARS).length;
    console.log(
      `[Digest:edition] generate: 代表${reps.length}件 / 本文取得を${enrich.attempted}件試行`
      + ` → 成功${enrich.succeeded}件・失敗${enrich.failed}件`,
    );
    for (const line of formatEnrichFailures(enrich.failures)) console.log(line);
    console.log(
      `[Digest:edition] generate: 素材が薄い記事（${THIN_MATERIAL_CHARS}字未満）${thin}件 → 短めの分量で生成します`,
    );

    const generated = new Map<string, GeneratedArticle>();
    let failedBatches = 0;
    let lastGenerateErr: unknown;
    for (let i = 0; i < reps.length; i += 10) {
      try {
        const part = await generateBatch(reps.slice(i, i + 10), { profileText });
        for (const [k, v] of part) generated.set(k, v);
      } catch (err) {
        failedBatches++;
        lastGenerateErr = err;
        console.error(
          `[Digest:edition] generateバッチ失敗（この${Math.min(10, reps.length - i)}件は掲載されません）:`
          + ` ${String((err as Error).message ?? err).slice(0, 200)}`,
        );
      }
    }
    if (generated.size === 0) throw lastGenerateErr ?? new Error('記事の生成が1件も成功しませんでした');
    if (failedBatches > 0) {
      console.warn(`[Digest:edition] generate: ${failedBatches}バッチ失敗 / 生成${generated.size}件で続行`);
    }
    const exclude = new Set<string>();
    let selected = selectTopPerSection(reps, generated, PER_SECTION, exclude);

    const publishedItems = await loadPublishedDedupeItems(userId, clusterWindowCondition(firstIssue, windowHours));
    const publishedHeadline = new Map(publishedItems.map((it) => [it.id, it.headline ?? '']));
    const headlineOf = (id: string) => generated.get(id)?.headline ?? publishedHeadline.get(id) ?? '';
    if (publishedItems.length > 0) {
      console.log(`[Digest:edition] 連日の重複チェック: 掲載済み${publishedItems.length}件と突き合わせ`);
    }
    let publishedCheckAlive = publishedItems.length > 0;
    const verifyCache = new Map<string, VerifyVerdict>();
    try {
      const result = await dedupeUntilStable(
        selected,
        async (current) => {
          const items: DedupeItem[] = [...current].map((id) => {
            const g = generated.get(id)!;
            return { id, headline: g.headline, lead: g.lead, section: g.section };
          });
          const round_ = await dedupeRound(items, publishedItems, reps, {
            crossAlive: publishedCheckAlive, headlineOf, verifyCache,
          });
          publishedCheckAlive = round_.crossAlive;
          return round_.removed;
        },
        (removed) => {
          for (const id of removed) exclude.add(id);
          return selectTopPerSection(reps, generated, PER_SECTION, exclude);
        },
      );
      selected = result.selected;
      if (result.capped) {
        console.error(
          `[Digest:edition] 重複統合が${result.rounds}周で止まらず打ち切り。最後に詰め直した記事は照合していません`,
        );
      }
    } catch (err) {
      console.error(`[Digest:edition] 重複統合をスキップ（${String((err as Error).message).slice(0, 120)}）`);
    }

    const materialById = new Map(candidates.map((c) => [c.id, c]));
    try {
      const targets = [...selected].map((id) => {
        const g = generated.get(id)!;
        const c = materialById.get(id);
        return {
          id,
          title: c?.title ?? null,
          summaryRaw: c?.summaryRaw ?? null,
          content: c?.content ?? null,
          headline: g.headline,
          lead: g.lead,
          body: g.body ?? '',
        };
      });
      const proof = await proofreadArticles(targets);
      for (const [id, r] of proof.revised) {
        const g = generated.get(id);
        if (g) generated.set(id, { ...g, headline: r.headline, lead: r.lead, body: r.body });
      }
      const line =
        `[Digest:edition] generate: 校閲 検査${proof.inspected}/${targets.length}件`
        + ` → 素材に無い記述の指摘${proof.findings.length}件 / 修正${proof.revised.size}件`
        + (proof.skipped > 0 ? ` / 期限切れ${proof.skipped}件` : '')
        + (proof.failed > 0 ? ` / 失敗${proof.failed}件` : '');
      if (targets.length > 0 && proof.inspected === 0) {
        console.error(`${line} ← 校閲が1本も動いていません`);
      } else {
        console.log(line);
      }
      for (const f of proof.findings) {
        const g = generated.get(f.id);
        console.log(`[Digest:edition] 校閲指摘: id=${f.id}「${g?.headline ?? ''}」 → ${f.issues.join(' / ')}`);
      }
    } catch (err) {
      console.error(`[Digest:edition] 校閲をスキップ（${String((err as Error).message).slice(0, 120)}）`);
    }

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const sourceCountById = new Map(reps.map((r) => [r.rep.id, r.sourceCount]));
    const sections: EditionContent['sections'] = [];
    for (const name of DEFAULT_SECTIONS) {
      const articles = [...selected]
        .filter((id) => generated.get(id)?.section === name)
        .sort((a, b) => (byId.get(b)?.triageScore ?? 0) - (byId.get(a)?.triageScore ?? 0))
        .map((id) => {
          const g = generated.get(id)!;
          const c = byId.get(id)!;
          const reportedBy = sourceCountById.get(id) ?? 1;
          return {
            articleId: Number(id),
            headline: g.headline,
            lead: g.lead,
            body: g.body ?? '',
            url: c.url,
            sourceTitle: c.feedTitle ?? null,
            score: c.triageScore ?? null,
            ...(reportedBy > 1 ? { sourceCount: reportedBy } : {}),
          };
        });
      if (articles.length > 0) sections.push({ name, articles });
    }

    const format: 'brief' | 'paper' = selected.size < BRIEF_THRESHOLD ? 'brief' : 'paper';
    const sourceCount = new Set(candidates.map((c) => String(c.feedId))).size;

    const others = buildOthersSections(reps, generated, selected, byId);

    const [{ count: activeFeeds }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(digestFeeds)
      .where(and(eq(digestFeeds.userId, userId), eq(digestFeeds.status, 'active')));
    const growingNotice = activeFeeds < GROWING_MIN_FEEDS;

    const editorialNote: EditionEditorialNote = {
      feedCount: activeFeeds,
      candidateCount: candidates.length,
      adoptedCount: selected.size,
      emptySections: format === 'paper'
        ? DEFAULT_SECTIONS.filter((n) => n !== 'その他' && !sections.some((s) => s.name === n))
        : [],
    };

    const content: EditionContent = {
      format, sections, candidateCount: candidates.length, sourceCount, coverage,
      ...(others ? { others } : {}),
      editorialNote,
    };

    for (const r of reps) {
      const g = generated.get(r.rep.id);
      if (!g) continue;
      const included = selected.has(r.rep.id);
      await db.update(digestArticles)
        .set({
          summary: `${g.headline}｜${g.lead}｜${g.body ?? ''}`,
          section: g.section,
          editionId: edition.id,
          included,
        })
        .where(eq(digestArticles.id, Number(r.rep.id)));
      for (const mid of r.memberIds) {
        if (mid === r.rep.id) continue;
        await db.update(digestArticles)
          .set({ editionId: edition.id, included: false })
          .where(and(eq(digestArticles.id, Number(mid)), isNull(digestArticles.editionId)));
      }
    }

    const [done] = await db.update(digestEditions)
      .set({ status: 'done', format, content, articleCount: selected.size, growingNotice, generatedAt: new Date() })
      .where(eq(digestEditions.id, edition.id))
      .returning();
    console.log(`[Digest:edition] 完了: user=${userId} 号=${done.id} 候補${candidates.length}→代表${reps.length}→採用${selected.size} (${format})`);

    await maybeSendEditionMail(userId, done.id);
    return { editionId: done.id, status: 'done', articleCount: selected.size };
  } catch (err) {
    console.error(`[Digest:edition] 失敗: user=${userId}`, err);
    await db.update(digestEditions)
      .set({ status: 'failed', generatedAt: new Date() })
      .where(eq(digestEditions.id, edition.id));
    return { editionId: edition.id, status: 'failed', articleCount: 0 };
  }
}

async function maybeSendEditionMail(userId: number, editionId: number): Promise<void> {
  const skip = (reason: string) => {
    console.log(`[Digest:edition] メール送信なし: user=${userId} edition=${editionId}（${reason}）`);
  };
  try {
    const [edition] = await db.select().from(digestEditions).where(eq(digestEditions.id, editionId));
    if (!edition || edition.status !== 'done') return skip(`号の状態が done ではない（${edition?.status ?? '見つからない'}）`);
    if (edition.articleCount === 0 && !edition.isFirstIssue) return skip('採用記事が0件（創刊号でもない）');

    const [profile] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
    const settings = (profile?.settings ?? {}) as { emailEnabled?: boolean };
    if (settings.emailEnabled === false) return skip('ユーザー設定でメール配信がOFF');

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user?.email) return skip('メールアドレスが未登録');
    if (user.email.startsWith('deleted+')) return skip('退会済みアカウント');

    await sendDigestEditionEmail({
      to: user.email,
      editionId,
      title: edition.title,
      content: edition.content as unknown as EditionContent,
      isFirstIssue: edition.isFirstIssue,
      growingNotice: edition.growingNotice,
    });
    await db.update(digestEditions).set({ mailSentAt: new Date() }).where(eq(digestEditions.id, editionId));
    const domain = user.email.slice(user.email.indexOf('@'));
    console.log(`[Digest:edition] メール送信済み: user=${userId} edition=${editionId} 宛先ドメイン=${domain}`);
  } catch (err) {
    console.error(`[Digest:edition] メール送信失敗: user=${userId} edition=${editionId}:`,
      err instanceof Error ? err.message : err);
  }
}
