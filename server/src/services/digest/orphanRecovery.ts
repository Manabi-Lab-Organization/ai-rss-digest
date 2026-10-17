
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestEditions, digestPodcasts, digestProfiles, digestResearch } from '../../db/schema.js';

export async function recoverOrphanedDigestJobs(): Promise<void> {
  try {
    const editions = await db
      .update(digestEditions)
      .set({ status: 'failed', generatedAt: new Date() })
      .where(eq(digestEditions.status, 'generating'))
      .returning({ id: digestEditions.id });
    const podcasts = await db
      .update(digestPodcasts)
      .set({ status: 'failed' })
      .where(inArray(digestPodcasts.status, ['pending', 'running']))
      .returning({ id: digestPodcasts.id });
    const research = await db
      .update(digestResearch)
      .set({ status: 'failed' })
      .where(inArray(digestResearch.status, ['pending', 'running']))
      .returning({ id: digestResearch.id });
    const visuals = await db
      .update(digestResearch)
      .set({ visualStatus: 'failed' })
      .where(eq(digestResearch.visualStatus, 'running'))
      .returning({ id: digestResearch.id });
    const polls = await db
      .update(digestProfiles)
      .set({ pollStatus: 'failed', pollFinishedAt: new Date() })
      .where(eq(digestProfiles.pollStatus, 'running'))
      .returning({ userId: digestProfiles.userId });
    const total = editions.length + podcasts.length + research.length + visuals.length + polls.length;
    if (total > 0) {
      console.log(
        `[Digest] 前回稼働の孤児ジョブを整理: 朝刊${editions.length} / 音声版${podcasts.length} / `
        + `深掘り${research.length} / ビジュアル版${visuals.length} / `
        + `手動収集${polls.length} → failed（再実行可能）`,
      );
    }
  } catch (err) {
    console.error('[Digest] 孤児ジョブ整理に失敗（続行）:', err);
  }
}
