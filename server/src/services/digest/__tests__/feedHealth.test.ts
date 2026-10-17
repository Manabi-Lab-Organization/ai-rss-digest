import { describe, it, expect } from 'vitest';
import {
  feedHealthWarning,
  feedStaleThresholdDays,
  latestPublishedAt,
  nextLastPublishedAt,
} from '../feedHealth.js';

const NOW = new Date('2054-09-20T00:00:00Z').getTime();
const daysAgo = (n: number): Date => new Date(NOW - n * 24 * 3600_000);

const feed = (over: Partial<Parameters<typeof feedHealthWarning>[0]> = {}) => ({
  status: 'active',
  kind: 'rss',
  lastPublishedAt: daysAgo(1),
  createdAt: daysAgo(365),
  articleCount: 100,
  spanDays: 100,
  ...over,
});

describe('feedStaleThresholdDays', () => {
  it('記事が少なく間隔が分からないときは、いちばん短い21日にする', () => {
    expect(feedStaleThresholdDays(0, null)).toBe(21);
    expect(feedStaleThresholdDays(3, 50)).toBe(21);
    expect(feedStaleThresholdDays(10, null)).toBe(21);
  });

  it('毎日記事が出るフィードでも21日より短くしない', () => {
    expect(feedStaleThresholdDays(100, 100)).toBe(21);
  });

  it('記事の少ないフィードは、平均の間隔の3倍ほどまで待つ', () => {
    const t = feedStaleThresholdDays(20, 360);
    expect(t).toBeGreaterThan(50);
    expect(t).toBeLessThan(65);
  });

  it('間隔がどれほど長くても120日を超えない', () => {
    expect(feedStaleThresholdDays(5, 3650)).toBe(120);
  });
});

describe('feedHealthWarning', () => {
  it('止めてあるフィードには何も返さない', () => {
    expect(feedHealthWarning(feed({ status: 'paused', lastPublishedAt: daysAgo(999) }), NOW)).toBeNull();
  });

  it('最近の記事があれば警告しない', () => {
    expect(feedHealthWarning(feed(), NOW)).toBeNull();
  });

  it('RSS の記事が長く途絶えたら stale を返す', () => {
    expect(feedHealthWarning(feed({ kind: 'rss', lastPublishedAt: daysAgo(400) }), NOW)).toBe('stale');
  });

  it('ニュース検索のフィードで記事が途絶えたら no-hits を返す', () => {
    expect(feedHealthWarning(feed({ kind: 'gnews', lastPublishedAt: daysAgo(400) }), NOW)).toBe('no-hits');
  });

  it('記事の少ないフィードが25日空いただけなら警告しない', () => {
    const r = feedHealthWarning(
      feed({ kind: 'rss', articleCount: 20, spanDays: 360, lastPublishedAt: daysAgo(25) }),
      NOW,
    );
    expect(r).toBeNull();
  });

  it('記事の少ないフィードでも、待つ日数を超えたら警告する', () => {
    const r = feedHealthWarning(
      feed({ kind: 'rss', articleCount: 20, spanDays: 360, lastPublishedAt: daysAgo(90) }),
      NOW,
    );
    expect(r).toBe('stale');
  });

  it('1年ほど記事が無いフィードは警告する', () => {
    const r = feedHealthWarning(
      feed({ kind: 'rss', articleCount: 10, spanDays: 67, lastPublishedAt: daysAgo(369) }),
      NOW,
    );
    expect(r).toBe('stale');
  });

  it('記事が一度も無いフィードは、登録した日から数える', () => {
    const r = feedHealthWarning(
      feed({ lastPublishedAt: null, createdAt: daysAgo(30), articleCount: 0, spanDays: null }),
      NOW,
    );
    expect(r).toBe('stale');
  });
});

describe('nextLastPublishedAt', () => {
  const later = new Date('2054-09-06T00:00:00Z');
  const earlier = new Date('2054-08-15T00:00:00Z');

  it('新しく読んだ日付の方が新しければ、その日付にする', () => {
    expect(nextLastPublishedAt(earlier, later)).toEqual(later);
  });

  it('新しく読んだ日付の方が古ければ、前の日付のままにする', () => {
    expect(nextLastPublishedAt(later, earlier)).toEqual(later);
  });

  it('同じ日付なら変えない', () => {
    expect(nextLastPublishedAt(later, new Date(later))).toEqual(later);
  });

  it('日付のある記事が無かったときは前の日付のままにする', () => {
    expect(nextLastPublishedAt(later, null)).toEqual(later);
  });

  it('前の日付が無ければ、新しく読んだ日付にする', () => {
    expect(nextLastPublishedAt(null, later)).toEqual(later);
  });

  it('どちらの日付も無ければ null のままにする', () => {
    expect(nextLastPublishedAt(null, null)).toBeNull();
  });
});

describe('latestPublishedAt', () => {
  it('並び順にかかわらず、いちばん新しい日時を返す', () => {
    const r = latestPublishedAt([
      '2054-08-15T00:00:00.000Z',
      '2054-09-06T12:00:00.000Z',
      '2054-09-01T00:00:00.000Z',
    ]);
    expect(r?.toISOString()).toBe('2054-09-06T12:00:00.000Z');
  });

  it('日付が一つも無ければ null を返す', () => {
    expect(latestPublishedAt([])).toBeNull();
    expect(latestPublishedAt([null, undefined, ''])).toBeNull();
  });

  it('日付として読めない値は飛ばし、残りからいちばん新しいものを返す', () => {
    const r = latestPublishedAt(['not a date', '2054-09-06T00:00:00.000Z', 'xxx']);
    expect(r?.toISOString()).toBe('2054-09-06T00:00:00.000Z');
  });

  it('読めない値しか無ければ null を返す', () => {
    expect(latestPublishedAt(['not a date'])).toBeNull();
  });

  it('時差の付いた書き方でも、同じ基準の時刻にそろえて比べる', () => {
    const r = latestPublishedAt(['2054-09-06T23:00:00+09:00', '2054-09-06T15:30:00Z']);
    expect(r?.toISOString()).toBe('2054-09-06T15:30:00.000Z');
  });
});

describe('間隔の見積もりと、古い記事が混じったとき', () => {
  it('とても古い記事が1件混じると、期間が延びて120日になる', () => {
    expect(feedStaleThresholdDays(20, 8766)).toBe(120);
  });

  it('最近の20件だけで測れば21日になる', () => {
    expect(feedStaleThresholdDays(20, 90)).toBe(21);
  });
});
