
import '../../env.js';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { digestProfiles } from '../../db/schema.js';
import { pollFeeds, formatSameArticle } from './poller.js';
import { runEdition } from './editionBuilder.js';
import { runProfileReview } from './profileReview.js';
import { runSourceSuggestion } from './sourceSuggest.js';
import { runResearch } from './research.js';
import { runResearchVisual } from './researchVisual.js';
import { runPodcast } from './podcastBuilder.js';
import { installDbUsageSink, setUsageUser } from './usage.js';

const [stage, ...args] = process.argv.slice(2);

installDbUsageSink();

async function main(): Promise<void> {
  switch (stage) {
    case 'poll': {
      const userId = args[0] ? Number(args[0]) : undefined;
      try {
        const summary = await pollFeeds({ userId });
        const reattached = summary.results.reduce((n, r) => n + (r.reattached ?? 0), 0);
        const notModified = summary.results.filter((r) => r.notModified).length;
        console.log(
          `[Digest:poll]${userId ? ` user=${userId}` : ''} ${summary.feedCount}フィード / 新着${summary.added}件 / `
          + `再紐付け${reattached}件 / 304=${notModified}件 / エラー${summary.errors.length}件`
          + formatSameArticle(summary.sameArticle),
        );
        for (const r of summary.errors) console.log(`  ERROR ${r.feed}: ${r.error}`);
        if (userId != null) {
          for (const r of summary.results) {
            console.log(
              `  ${r.feed}: ${r.notModified ? '304未更新' : `記事${r.itemCount ?? 0}件中 新規${r.newCount}件・再紐付け${r.reattached ?? 0}件`}${r.error ? ` ERROR ${r.error}` : ''}`,
            );
          }
          await db.update(digestProfiles)
            .set({
              pollStatus: 'done',
              pollFinishedAt: new Date(),
              pollResult: {
                feedCount: summary.feedCount,
                added: summary.added,
                reattached,
                notModified,
                errorCount: summary.errors.length,
              },
            })
            .where(eq(digestProfiles.userId, userId));
        }
      } catch (err) {
        if (userId != null) {
          await db.update(digestProfiles)
            .set({ pollStatus: 'failed', pollFinishedAt: new Date() })
            .where(eq(digestProfiles.userId, userId))
            .catch(() => {});
        }
        throw err;
      }
      break;
    }
    case 'edition': {
      const userId = Number(args[0]);
      if (!Number.isInteger(userId)) throw new Error('edition stage requires userId');
      setUsageUser(userId);
      const firstIssue = args.includes('--first');
      const result = await runEdition(userId, { firstIssue });
      console.log(`[Digest:edition] user=${userId} edition=${result.editionId} status=${result.status} 採用${result.articleCount}件`);
      if (result.status === 'failed') process.exitCode = 1;
      break;
    }
    case 'profile-review': {
      const userId = Number(args[0]);
      if (!Number.isInteger(userId)) throw new Error('profile-review stage requires userId');
      setUsageUser(userId);
      const result = await runProfileReview(userId);
      if (result.status === 'skipped') {
        console.log(`[Digest:profile-review] user=${userId} skipped（シグナル${result.signals}件 < 閾値${result.threshold}件）`);
      } else {
        console.log(`[Digest:profile-review] user=${userId} 提案#${result.proposalId}を起票（シグナル${result.signals}件）`);
      }
      break;
    }
    case 'source-suggest': {
      const userId = Number(args[0]);
      if (!Number.isInteger(userId)) throw new Error('source-suggest stage requires userId');
      setUsageUser(userId);
      const result = await runSourceSuggestion(userId);
      if (result.status === 'skipped') {
        console.log(`[Digest:source-suggest] user=${userId} skipped（材料なし）`);
      } else {
        console.log(`[Digest:source-suggest] user=${userId} 提案${result.count}件を起票`);
      }
      break;
    }
    case 'research': {
      const userId = Number(args[0]);
      const articleId = Number(args[1]);
      if (!Number.isInteger(userId) || !Number.isInteger(articleId)) {
        throw new Error('research stage requires userId and articleId');
      }
      setUsageUser(userId);
      const result = await runResearch(userId, articleId);
      console.log(`[Digest:research] user=${userId} article=${articleId} レポート${result.reportLength}字を保存`);
      break;
    }
    case 'research-visual': {
      const userId = Number(args[0]);
      const researchId = Number(args[1]);
      if (!Number.isInteger(userId) || !Number.isInteger(researchId)) {
        throw new Error('research-visual stage requires userId and researchId');
      }
      setUsageUser(userId);
      const result = await runResearchVisual(userId, researchId);
      console.log(`[Digest:research-visual] user=${userId} research=${researchId} HTML ${result.htmlLength}字を保存`);
      break;
    }
    case 'podcast': {
      const userId = Number(args[0]);
      const editionId = Number(args[1]);
      if (!Number.isInteger(userId) || !Number.isInteger(editionId)) {
        throw new Error('podcast stage requires userId and editionId');
      }
      setUsageUser(userId);
      const reuseScript = args.includes('--reuse');
      const result = await runPodcast(userId, editionId, { reuseScript });
      console.log(
        `[Digest:podcast] user=${userId} edition=${editionId} `
        + `${result.segmentCount}セグメント / ${Math.round(result.audioBytes / 1024)}KB (${result.mimeType}) / 約${result.durationSec}秒`,
      );
      break;
    }
    case 'storage': {
      const { runStorageWatch } = await import('./storageWatch.js');
      const { sendOperationsEmail } = await import('../emailService.js');
      const to = process.env.OPS_EMAIL || '';
      await runStorageWatch({
        baseUrl: process.env.APP_URL || '',
        sendMailFn: to ? (mail) => sendOperationsEmail({ to, ...mail }) : undefined,
      });
      if (!to) {
        console.warn('[Digest:storage] OPS_EMAIL 未設定のため警告メールは送りません（ログのみ）');
      }
      break;
    }
    default:
      throw new Error(`unknown digest job stage: ${stage}`);
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`[Digest:${stage}] failed:`, err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
