
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestPodcasts } from '../../db/schema.js';
import { siteConfig } from '../siteConfig.js';

export const PODCAST_RETENTION_DAYS = Number(process.env.PODCAST_RETENTION_DAYS ?? 180);

export const DB_WARN_BYTES = Number(process.env.DB_WARN_BYTES || 8 * 1024 ** 3);

const WATCHED_TABLES = [
  { table: 'digest_podcasts', label: 'ダイジェストの音声版（mp3）' },
  { table: 'digest_articles', label: '収集記事（本文つき）' },
  { table: 'digest_editions', label: '朝刊の紙面データ' },
] as const;

export interface StorageReport {
  databaseBytes: number;
  tables: Array<{ table: string; label: string; bytes: number; rows: number }>;
  podcastAudioBytes: number;
  podcastAudioCount: number;
  warnBytes: number;
  usedRatio: number;
  retentionDays: number;
}

export async function storageReport(): Promise<StorageReport> {
  const dbSize = await db.execute<{ size: string }>(sql`SELECT pg_database_size(current_database())::text AS size`);
  const databaseBytes = Number(dbSize.rows[0]?.size ?? 0);

  const tables: StorageReport['tables'] = [];
  for (const { table, label } of WATCHED_TABLES) {
    try {
      const r = await db.execute<{ bytes: string; rows: string }>(sql`
        SELECT COALESCE(pg_total_relation_size(to_regclass(${table})), 0)::text AS bytes,
               COALESCE((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = ${table}), 0)::text AS rows
      `);
      tables.push({
        table,
        label,
        bytes: Number(r.rows[0]?.bytes ?? 0),
        rows: Number(r.rows[0]?.rows ?? 0),
      });
    } catch {
    }
  }
  tables.sort((a, b) => b.bytes - a.bytes);

  const audio = await db
    .select({
      bytes: sql<string>`COALESCE(SUM(octet_length(${digestPodcasts.audio})), 0)::text`,
      count: sql<string>`COUNT(*) FILTER (WHERE ${digestPodcasts.audio} IS NOT NULL)::text`,
    })
    .from(digestPodcasts);

  return {
    databaseBytes,
    tables,
    podcastAudioBytes: Number(audio[0]?.bytes ?? 0),
    podcastAudioCount: Number(audio[0]?.count ?? 0),
    warnBytes: DB_WARN_BYTES,
    usedRatio: DB_WARN_BYTES > 0 ? databaseBytes / DB_WARN_BYTES : 0,
    retentionDays: PODCAST_RETENTION_DAYS,
  };
}

export async function prunePodcastAudio(
  { days = PODCAST_RETENTION_DAYS, now = new Date() }: { days?: number; now?: Date } = {},
): Promise<{ prunedCount: number; freedBytes: number }> {
  if (days <= 0) return { prunedCount: 0, freedBytes: 0 };
  const cutoff = new Date(now.getTime() - days * 24 * 3600_000);

  const target = await db
    .select({
      bytes: sql<string>`COALESCE(SUM(octet_length(${digestPodcasts.audio})), 0)::text`,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(digestPodcasts)
    .where(and(isNotNull(digestPodcasts.audio), lt(digestPodcasts.completedAt, cutoff)));

  const freedBytes = Number(target[0]?.bytes ?? 0);
  const prunedCount = Number(target[0]?.count ?? 0);
  if (prunedCount === 0) return { prunedCount: 0, freedBytes: 0 };

  await db
    .update(digestPodcasts)
    .set({ audio: null, status: 'expired' })
    .where(and(isNotNull(digestPodcasts.audio), lt(digestPodcasts.completedAt, cutoff)));

  return { prunedCount, freedBytes };
}

export function humanBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

export function storageWarnMail(report: StorageReport, baseUrl: string): { subject: string; text: string; html: string } {
  const pct = Math.round(report.usedRatio * 100);
  const rows = report.tables
    .filter((t) => t.bytes > 0)
    .slice(0, 6)
    .map((t) => `・${t.label}: ${humanBytes(t.bytes)}（${t.rows.toLocaleString('ja-JP')}行）`);

  const text = [
    `データベースの使用量が ${humanBytes(report.databaseBytes)}（目安の ${pct}%）になりました。`,
    '',
    'このまま増えると、バックアップの容量と復元にかかる時間も同じだけ増えます。',
    `音声版（ダイジェストのポッドキャスト）は現在 ${humanBytes(report.podcastAudioBytes)}（${report.podcastAudioCount}本）で、`,
    `${report.retentionDays}日を過ぎたものは自動で削除しています（台本は残るので作り直せます）。`,
    '',
    '内訳（大きい順）:',
    ...rows,
    '',
    `${baseUrl}/digest`,
  ].join('\n');

  return {
    subject: `【要確認】データベース使用量 ${humanBytes(report.databaseBytes)}（${siteConfig().appName}）`,
    text,
    html: `<p>データベースの使用量が <strong>${humanBytes(report.databaseBytes)}</strong>（目安の ${pct}%）になりました。</p>
<p>このまま増えると、バックアップの容量と復元にかかる時間も同じだけ増えます。</p>
<p>音声版（ダイジェストのポッドキャスト）は現在 ${humanBytes(report.podcastAudioBytes)}（${report.podcastAudioCount}本）。
${report.retentionDays}日を過ぎたものは自動削除しています（台本は残るので作り直せます）。</p>
<p>内訳（大きい順）:</p><ul>${rows.map((r) => `<li>${r.replace('・', '')}</li>`).join('')}</ul>
<p><a href="${baseUrl}/digest">アプリを開く</a></p>`,
  };
}

export function decideStorageWarn(
  { usedRatio, threshold = 0.8, today, lastWarnedDate }:
  { usedRatio: number; threshold?: number; today: string; lastWarnedDate: string },
): { warn: boolean; nextLastWarnedDate: string; reason: string } {
  if (usedRatio < threshold) {
    return { warn: false, nextLastWarnedDate: '', reason: '空き十分' };
  }
  if (lastWarnedDate === today) {
    return { warn: false, nextLastWarnedDate: lastWarnedDate, reason: '本日は送信済み' };
  }
  return { warn: true, nextLastWarnedDate: today, reason: '閾値超過' };
}

let lastWarnedDate = '';

export async function runStorageWatch({
  sendMailFn,
  baseUrl = '',
  today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10),
  logFn = console.log,
}: {
  sendMailFn?: (mail: { subject: string; text: string; html: string }) => Promise<unknown>;
  baseUrl?: string;
  today?: string;
  logFn?: (msg: string) => void;
} = {}): Promise<{ pruned: { prunedCount: number; freedBytes: number }; warned: boolean; report: StorageReport }> {
  const pruned = await prunePodcastAudio();
  if (pruned.prunedCount > 0) {
    logFn(`[Digest:storage] ${PODCAST_RETENTION_DAYS}日を過ぎた音声版を${pruned.prunedCount}本削除`
      + `（${humanBytes(pruned.freedBytes)}）。台本は残しているので作り直せます`);
  }

  const report = await storageReport();
  logFn(`[Digest:storage] DB ${humanBytes(report.databaseBytes)} / 目安 ${humanBytes(report.warnBytes)}`
    + `（${Math.round(report.usedRatio * 100)}%）・音声版 ${humanBytes(report.podcastAudioBytes)}（${report.podcastAudioCount}本）`);

  const decision = decideStorageWarn({ usedRatio: report.usedRatio, today, lastWarnedDate });
  lastWarnedDate = decision.nextLastWarnedDate;
  let warned = false;
  if (decision.warn) {
    if (!sendMailFn) {
      logFn('[Digest:storage] 閾値超過だが通知先が未設定のためログのみ');
    } else {
      try {
        await sendMailFn(storageWarnMail(report, baseUrl));
        warned = true;
        logFn('[Digest:storage] 使用量の警告メールを送信しました');
      } catch (err) {
        lastWarnedDate = '';
        logFn(`[Digest:storage] 警告メールの送信に失敗: ${String((err as Error).message ?? err).slice(0, 200)}`);
      }
    }
  } else if (report.usedRatio >= 0.8) {
    logFn(`[Digest:storage] 閾値超過だがメールは送りません（${decision.reason}）`);
  }

  return { pruned, warned, report };
}
