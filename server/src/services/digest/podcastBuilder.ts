
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles, digestEditions, digestPodcasts, digestProfiles, users } from '../../db/schema.js';
import { sendDigestPodcastEmail } from '../emailService.js';
import type { EditionContent } from './editionBuilder.js';
import { DEFAULT_EDITORIAL_PROFILE } from './editorialProfile.js';
import {
  generateScript, computeEmptySections, scriptStats, getPodcastScriptModel,
  type PodcastSection, type ScriptSegment,
} from './podcastScript.js';
import { synthesizeScript, getTtsModel, type TtsFetchLike } from './podcastTts.js';
import { recordUsage, estimateCostUsd } from './usage.js';
import type { CreateMessageFn } from './anthropicClient.js';

export function formatTtsUsage(
  usage: { promptTokens: number; audioTokens: number },
  durationSec: number,
  model: string,
): string {
  const minutes = durationSec / 60;
  const perMin = minutes > 0 ? Math.round(usage.audioTokens / minutes) : 0;
  const usd = estimateCostUsd(model, usage.promptTokens, usage.audioTokens);
  const n = (v: number) => v.toLocaleString('en-US');
  return `入力 ${n(usage.promptTokens)} tok / 出力 ${n(usage.audioTokens)} tok`
    + ` / ${minutes.toFixed(1)}分 = ${n(perMin)} tok/分（概算 $${usd.toFixed(2)}）`;
}

export interface RunPodcastResult {
  editionId: number;
  status: 'done';
  segmentCount: number;
  durationSec: number;
  mimeType: string;
  audioBytes: number;
}

export interface RunPodcastOptions {
  reuseScript?: boolean;
  createMessageFn?: CreateMessageFn;
  fetchFn?: TtsFetchLike;
}

export async function loadProfileText(userId: number): Promise<string> {
  const [profile] = await db
    .select({ editorialProfile: digestProfiles.editorialProfile })
    .from(digestProfiles)
    .where(eq(digestProfiles.userId, userId));
  return profile?.editorialProfile || DEFAULT_EDITORIAL_PROFILE;
}

export async function buildSections(userId: number, content: EditionContent): Promise<PodcastSection[]> {
  const articleIds = content.sections.flatMap((s) => s.articles.map((a) => a.articleId)).filter(Number.isInteger);
  const contentById = new Map<number, string | null>();
  if (articleIds.length > 0) {
    const rows = await db
      .select({ id: digestArticles.id, content: digestArticles.content })
      .from(digestArticles)
      .where(and(eq(digestArticles.userId, userId), inArray(digestArticles.id, articleIds)));
    for (const r of rows) contentById.set(r.id, r.content);
  }
  return content.sections.map((s) => ({
    name: s.name,
    articles: s.articles.map((a) => ({
      headline: a.headline,
      lead: a.lead,
      body: a.body,
      sourceTitle: a.sourceTitle,
      content: contentById.get(a.articleId) ?? null,
    })),
  }));
}

export async function runPodcast(
  userId: number,
  editionId: number,
  { reuseScript = false, createMessageFn, fetchFn }: RunPodcastOptions = {},
): Promise<RunPodcastResult> {
  const [edition] = await db
    .select()
    .from(digestEditions)
    .where(and(eq(digestEditions.id, editionId), eq(digestEditions.userId, userId)));
  if (!edition) throw new Error(`号が見つかりません（editionId=${editionId}）`);
  if (edition.status !== 'done') throw new Error(`号がまだ完成していません（status=${edition.status}）`);

  const content = edition.content as unknown as EditionContent | null;
  const articleCount = content?.sections?.reduce((n, s) => n + s.articles.length, 0) ?? 0;
  if (!content || articleCount === 0) throw new Error('この号には音声化する記事がありません');

  const [existing] = await db
    .select({ id: digestPodcasts.id, script: digestPodcasts.script })
    .from(digestPodcasts)
    .where(eq(digestPodcasts.editionId, editionId));

  await db
    .insert(digestPodcasts)
    .values({ userId, editionId, status: 'running' })
    .onConflictDoUpdate({
      target: digestPodcasts.editionId,
      set: { status: 'running', completedAt: null },
    });

  try {
    let segments: ScriptSegment[] | null = null;
    if (reuseScript && existing?.script) {
      try {
        const parsed: unknown = JSON.parse(existing.script);
        if (Array.isArray(parsed) && parsed.length > 0) {
          segments = parsed as ScriptSegment[];
          console.log(`[Digest:podcast] 保存済み台本を再利用（${segments.length}セグメント）`);
        }
      } catch {
      }
    }

    if (!segments) {
      console.log(`[Digest:podcast] 台本生成中 (${getPodcastScriptModel()})...`);
      const sections = await buildSections(userId, content);
      const profileText = await loadProfileText(userId);
      segments = await generateScript(
        sections,
        {
          editionTitle: edition.title ?? '本日の号',
          editionDate: edition.editionDate,
          emptySections: computeEmptySections(content),
        },
        {
          profileText,
          createMessageFn,
          onProgress: (done, total) => console.log(`[Digest:podcast] 台本セクション ${done}/${total}`),
        },
      );
      await db
        .update(digestPodcasts)
        .set({ script: JSON.stringify(segments) })
        .where(eq(digestPodcasts.editionId, editionId));
    }

    const stats = scriptStats(segments);
    console.log(`[Digest:podcast] 台本: ${segments.length}セグメント / ${stats.chars}字（読み上げ約${stats.estimatedMinutes}分）`);

    console.log(`[Digest:podcast] 音声合成中 (${getTtsModel()})...`);
    const { buffer, mimeType, durationSec, usage } = await synthesizeScript(segments, {
      fetchFn,
      onProgress: (done, total) => console.log(`[Digest:podcast] チャンク ${done}/${total}`),
    });
    recordUsage({
      stage: 'podcast-tts',
      model: getTtsModel(),
      inputTokens: usage.promptTokens,
      outputTokens: usage.audioTokens,
    });

    await db
      .update(digestPodcasts)
      .set({ status: 'done', audio: buffer, mimeType, durationSec, ttsModel: getTtsModel(), completedAt: new Date() })
      .where(eq(digestPodcasts.editionId, editionId));

    console.log(`[Digest:podcast] 完了: edition=${editionId} ${Math.round(buffer.length / 1024)}KB (${mimeType}) 約${Math.round(durationSec / 60)}分`);
    console.log(`[Digest:podcast] 利用量: ${formatTtsUsage(usage, durationSec, getTtsModel())}`);

    await maybeSendPodcastMail(userId, editionId, edition.title ?? '本日の号', durationSec);
    return {
      editionId,
      status: 'done',
      segmentCount: segments.length,
      durationSec,
      mimeType,
      audioBytes: buffer.length,
    };
  } catch (err) {
    await db
      .update(digestPodcasts)
      .set({ status: 'failed', completedAt: null })
      .where(eq(digestPodcasts.editionId, editionId))
      .catch(() => {});
    throw err;
  }
}

async function maybeSendPodcastMail(
  userId: number, editionId: number, editionTitle: string, durationSec: number,
): Promise<void> {
  try {
    const [profile] = await db
      .select({ settings: digestProfiles.settings })
      .from(digestProfiles)
      .where(eq(digestProfiles.userId, userId));
    const settings = (profile?.settings ?? {}) as { emailEnabled?: boolean };
    if (settings.emailEnabled === false) return;

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user?.email || user.email.startsWith('deleted+')) return;

    await sendDigestPodcastEmail({ to: user.email, editionId, editionTitle, durationSec });
  } catch (err) {
    console.error(`[Digest:podcast] メール送信失敗: user=${userId}`, err);
  }
}
