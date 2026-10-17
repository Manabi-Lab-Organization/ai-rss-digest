import { describe, it, expect } from 'vitest';
import {
  DIGEST_PRICE_TABLE,
  estimateCostUsd,
  buildUsageSummary,
  jstMonthStart,
  jstMonthLabel,
} from '../usage.js';

describe('単価表と費用の見積もり', () => {
  it('haiku の型番は haiku の単価で見積もる', () => {
    expect(estimateCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBe(6);
    expect(estimateCostUsd('claude-haiku-4-5-20251001', 500_000, 0)).toBe(0.5);
  });

  it('sonnet-5 の型番は新しい sonnet の単価で見積もる', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 100_000)).toBe(3);
  });

  it('それより前の sonnet の型番は前の単価で見積もる', () => {
    expect(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 100_000)).toBe(4.5);
  });

  it('表に無い型番は、高めになる sonnet の単価で見積もる', () => {
    expect(estimateCostUsd('some-future-model', 1_000_000, 0)).toBe(3);
  });

  it('単価表に haiku と sonnet の行がある', () => {
    expect(DIGEST_PRICE_TABLE.some((p) => p.match.test('claude-haiku-4-5-20251001'))).toBe(true);
    expect(DIGEST_PRICE_TABLE.some((p) => p.match.test('claude-sonnet-5'))).toBe(true);
  });

  it('Web 検索は入力の数を回数として見積もる', () => {
    expect(estimateCostUsd('web_search', 1000, 0)).toBe(10);
    expect(estimateCostUsd('web_search', 6, 0)).toBe(0.06);
  });

  it('音声合成は pro とそれ以外で別の単価で見積もる', () => {
    expect(estimateCostUsd('gemini-2.5-pro-preview-tts', 1_000_000, 1_000_000)).toBe(21);
    expect(estimateCostUsd('gemini-2.5-flash-preview-tts', 1_000_000, 1_000_000)).toBe(10.5);
  });
});

describe('日本時間での月の区切り', () => {
  it('日本時間の月はじめ 0 時を UTC で返す', () => {
    const start = jstMonthStart(new Date('2054-07-19T10:00:00Z'));
    expect(start.toISOString()).toBe('2054-06-30T15:00:00.000Z');
  });

  it('UTC では前の月でも、日本時間で次の月に入っていれば次の月にする', () => {
    const start = jstMonthStart(new Date('2054-06-30T16:00:00Z'));
    expect(start.toISOString()).toBe('2054-06-30T15:00:00.000Z');
    expect(jstMonthLabel(new Date('2054-06-30T16:00:00Z'))).toBe('2054-07');
  });

  it('日本時間でまだその月のうちなら、その月のはじめを返す', () => {
    const start = jstMonthStart(new Date('2054-06-30T14:59:00Z'));
    expect(start.toISOString()).toBe('2054-05-31T15:00:00.000Z');
    expect(jstMonthLabel(new Date('2054-06-30T14:59:00Z'))).toBe('2054-06');
  });
});

describe('buildUsageSummary', () => {
  const rows = [
    { stage: 'triage', model: 'claude-haiku-4-5-20251001', inputTokens: 2_000_000, outputTokens: 100_000 },
    { stage: 'generate', model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 200_000 },
  ];

  it('処理の段階ごとの見積もりと合計をドルで出す', () => {
    const summary = buildUsageSummary(rows, { now: new Date('2054-07-19T10:00:00Z') });
    expect(summary.month).toBe('2054-07');
    expect(summary.stages.map((s) => s.stage)).toEqual(['generate', 'triage']);
    expect(summary.stages[0].estimatedCostUsd).toBe(4);
    expect(summary.stages[1].estimatedCostUsd).toBe(2.5);
    expect(summary.total).toEqual({
      inputTokens: 3_000_000,
      outputTokens: 300_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 6.5,
    });
  });

  it('小数は4桁に丸める', () => {
    const summary = buildUsageSummary(
      [{ stage: 'research', model: 'claude-sonnet-5', inputTokens: 1234, outputTokens: 567 }],
      { now: new Date('2054-07-19T10:00:00Z') },
    );
    expect(summary.stages[0].estimatedCostUsd).toBe(0.0081);
  });

  it('キャッシュの読み込みと書き込みも見積もりに足す', () => {
    const summary = buildUsageSummary(
      [{
        stage: 'source-chat',
        model: 'claude-opus-4-8',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }],
      { now: new Date('2054-09-02T01:00:00Z') },
    );
    expect(summary.stages[0].estimatedCostUsd).toBe(6.75);
    expect(summary.total.cacheCreationInputTokens).toBe(1_000_000);
    expect(summary.total.cacheReadInputTokens).toBe(1_000_000);
  });

  it('キャッシュの数が無い行も、入力と出力だけで見積もれる', () => {
    const summary = buildUsageSummary(
      [{ stage: 'generate', model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 0 }],
      { now: new Date('2054-09-02T01:00:00Z') },
    );
    expect(summary.stages[0].estimatedCostUsd).toBe(2);
  });

  it('行が一つも無くても 0 として返す', () => {
    const summary = buildUsageSummary([]);
    expect(summary.stages).toEqual([]);
    expect(summary.total.estimatedCostUsd).toBe(0);
  });
});
