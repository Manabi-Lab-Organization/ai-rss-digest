
import { db } from '../../db/index.js';
import { digestUsage } from '../../db/schema.js';
import { setUsageSink, type UsageEvent } from './anthropicClient.js';
import { auditLlmCall } from '../audit/audit.js';

let currentUserId: number | null = null;

export function setUsageUser(userId: number | null): void {
  currentUserId = userId;
}

let installed = false;

export function recordUsage(u: UsageEvent): void {
  void db
    .insert(digestUsage)
    .values({
      userId: currentUserId,
      stage: u.stage,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
    })
    .catch((err) => console.error('[Digest:usage] 記録に失敗しました（処理は継続）:', err));
  auditLlmCall({
    feature: `digest:${u.stage}`,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens ?? 0,
    cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
    costUsd: estimateCostUsd(u.model, u.inputTokens, u.outputTokens, {
      creationInputTokens: u.cacheCreationInputTokens,
      readInputTokens: u.cacheReadInputTokens,
    }),
    userId: currentUserId,
  });
}

export function installDbUsageSink(): void {
  if (installed) return;
  installed = true;
  setUsageSink(recordUsage);
}

export const DIGEST_PRICE_TABLE: Array<{ match: RegExp; inputPerMtok: number; outputPerMtok: number }> = [
  { match: /haiku/i, inputPerMtok: 1, outputPerMtok: 5 },
  { match: /sonnet-5/i, inputPerMtok: 2, outputPerMtok: 10 },
  { match: /sonnet/i, inputPerMtok: 3, outputPerMtok: 15 },
  { match: /opus/i, inputPerMtok: 5, outputPerMtok: 25 },
  { match: /^web_search$/, inputPerMtok: 10_000, outputPerMtok: 0 },
  { match: /gemini.*pro.*tts/i, inputPerMtok: 1, outputPerMtok: 20 },
  { match: /gemini.*tts/i, inputPerMtok: 0.5, outputPerMtok: 10 },
];

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache: { creationInputTokens?: number; readInputTokens?: number } = {},
): number {
  const price =
    DIGEST_PRICE_TABLE.find((p) => p.match.test(model)) ??
    { inputPerMtok: 3, outputPerMtok: 15 };
  const cacheWrite = (cache.creationInputTokens ?? 0) * price.inputPerMtok * CACHE_WRITE_MULTIPLIER;
  const cacheRead = (cache.readInputTokens ?? 0) * price.inputPerMtok * CACHE_READ_MULTIPLIER;
  return (
    inputTokens * price.inputPerMtok
    + outputTokens * price.outputPerMtok
    + cacheWrite
    + cacheRead
  ) / 1_000_000;
}

const JST_OFFSET_MS = 9 * 3600_000;

export function jstMonthStart(now: Date = new Date()): Date {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - JST_OFFSET_MS);
}

export function jstMonthLabel(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UsageAggRow {
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface UsageStageSummary extends UsageAggRow {
  estimatedCostUsd: number;
}

export interface UsageSummary {
  month: string;
  stages: UsageStageSummary[];
  total: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    estimatedCostUsd: number;
  };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function buildUsageSummary(
  rows: UsageAggRow[],
  { now = new Date() }: { now?: Date } = {},
): UsageSummary {
  const sum = (pick: (s: UsageStageSummary) => number): number =>
    stages.reduce((acc, s) => acc + pick(s), 0);
  const stages: UsageStageSummary[] = rows
    .map((r) => ({
      ...r,
      estimatedCostUsd: round4(estimateCostUsd(r.model, r.inputTokens, r.outputTokens, {
        creationInputTokens: r.cacheCreationInputTokens,
        readInputTokens: r.cacheReadInputTokens,
      })),
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  return {
    month: jstMonthLabel(now),
    stages,
    total: {
      inputTokens: sum((s) => s.inputTokens),
      outputTokens: sum((s) => s.outputTokens),
      cacheCreationInputTokens: sum((s) => s.cacheCreationInputTokens ?? 0),
      cacheReadInputTokens: sum((s) => s.cacheReadInputTokens ?? 0),
      estimatedCostUsd: round4(sum((s) => s.estimatedCostUsd)),
    },
  };
}
