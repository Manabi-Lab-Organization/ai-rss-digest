import { describe, expect, it } from 'vitest';
import { windowHoursForFrequency, buildCoverageLabel, publishedWindowHours,
  buildOthersSections, OTHERS_PER_SECTION, publishedInMainCondition } from '../editionBuilder.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseExcluded } from '../dedupe.js';
import type { Representative, GeneratedArticle } from '../generate.js';

describe('windowHoursForFrequency', () => {
  it('毎日のとき、または指定が無いときは24時間', () => {
    expect(windowHoursForFrequency(undefined)).toBe(24);
    expect(windowHoursForFrequency('daily')).toBe(24);
  });

  it('週3回なら72時間、週1回なら168時間', () => {
    expect(windowHoursForFrequency('weekly3')).toBe(72);
    expect(windowHoursForFrequency('weekly1')).toBe(168);
  });
});

describe('publishedWindowHours', () => {
  it('公開日で絞る幅は、対象の時間の1.25倍にする', () => {
    expect(publishedWindowHours(24)).toBe(30);
    expect(publishedWindowHours(72)).toBe(90);
    expect(publishedWindowHours(168)).toBe(210);
  });
});

describe('buildOthersSections', () => {
  const rep = (id: string, score: number): Representative => ({
    rep: { id, title: `T${id}`, summaryRaw: null, triageScore: score },
    memberIds: [id],
    clusterSize: 1,
    feedCount: 1,
    sourceCount: 1,
  });
  const gen = (section: string): GeneratedArticle =>
    ({ headline: '仮の見出し', lead: '仮のリード', body: '仮の本文', section }) as GeneratedArticle;

  it('記事は作ったが選ばれなかったものを欄ごとに集め、選ばれたものとまだ作っていないものは入れない', () => {
    const reps = [rep('1', 5), rep('2', 4), rep('3', 3)];
    const generated = new Map([
      ['1', gen('国際')],
      ['2', gen('国際')],
    ]);
    const selected = new Set(['1']);
    const byId = new Map([
      ['1', { url: 'https://news.example.com/1', feedTitle: 'A', publishedAt: new Date('2054-07-20T00:00:00Z') }],
      ['2', { url: 'https://news.example.com/2', feedTitle: 'A', publishedAt: new Date('2054-07-20T01:00:00Z') }],
      ['3', { url: 'https://news.example.com/3', feedTitle: 'A', publishedAt: null }],
    ]);
    const others = buildOthersSections(reps, generated, selected, byId);
    expect(others).toHaveLength(1);
    expect(others![0].name).toBe('国際');
    expect(others![0].articles.map((a) => a.articleId)).toEqual([2]);
    expect(others![0].articles[0].publishedAt).toBe('2054-07-20T01:00:00.000Z');
  });

  it('欄ごとに上限の数までを、点数の高い順に並べる', () => {
    const reps = Array.from({ length: 12 }, (_, i) => rep(String(i + 1), i + 1));
    const generated = new Map(reps.map((r) => [r.rep.id, gen('経済・ビジネス')]));
    const byId = new Map(reps.map((r) => [r.rep.id, { url: `https://news.example.com/${r.rep.id}`, feedTitle: 'A', publishedAt: null }]));
    const others = buildOthersSections(reps, generated, new Set(), byId)!;
    expect(others[0].articles).toHaveLength(OTHERS_PER_SECTION);
    expect(others[0].articles[0].articleId).toBe(12);
  });

  it('選ばれなかった記事が無ければ undefined を返す', () => {
    const reps = [rep('1', 5)];
    const generated = new Map([['1', gen('国際')]]);
    expect(buildOthersSections(reps, generated, new Set(['1']), new Map())).toBeUndefined();
  });
});

describe('buildCoverageLabel', () => {
  const now = new Date('2054-07-19T21:00:00Z');

  it('最初の号では、各情報源の新しい記事という説明を返す', () => {
    expect(buildCoverageLabel(true, 24, now)).toBe('各情報源の最新記事（過去90日以内）');
  });

  it('毎日届けるときは、日本時間で前の日の同じ時刻からの24時間を示す', () => {
    expect(buildCoverageLabel(false, 24, now)).toBe('7/19 6時 〜 7/20 6時（直近24時間）');
  });

  it('週1回のときは7日間を示す', () => {
    expect(buildCoverageLabel(false, 168, now)).toBe('7/13 6時 〜 7/20 6時（直近7日間）');
  });
});

describe('重なりとして外した記事を、選ばれなかった一覧に出す', () => {
  const rep = (id: string, score: number, feedCount = 1): Representative => ({
    rep: { id, title: `T${id}`, summaryRaw: null, triageScore: score },
    memberIds: [id],
    clusterSize: 1,
    feedCount,
    sourceCount: 1,
  });
  const gen = (section: string): GeneratedArticle =>
    ({ headline: '仮の見出し', lead: '仮のリード', body: '仮の本文', section }) as GeneratedArticle;

  it('まとめられて外れた方の記事が、選ばれなかった一覧に入る', () => {
    const reps = [rep('1', 9, 3), rep('2', 8, 1)];
    const generated = new Map([['1', gen('経済・ビジネス')], ['2', gen('経済・ビジネス')]]);
    const byId = new Map([
      ['1', { url: 'https://news.example.com/1', feedTitle: 'A', publishedAt: null }],
      ['2', { url: 'https://news.example.com/2', feedTitle: 'B', publishedAt: null }],
    ]);

    const removed = chooseExcluded([['1', '2']], reps);
    expect([...removed]).toEqual(['2']);

    const selected = new Set(['1', '2'].filter((id) => !removed.has(id)));
    expect(selected.has('2')).toBe(false);

    const others = buildOthersSections(reps, generated, selected, byId);
    expect(others).toBeDefined();
    const ids = others!.flatMap((o) => o.articles.map((a) => a.articleId));
    expect(ids).toContain(2);
  });

  it('一覧には作っておいた見出しがそのまま使われる', () => {
    const reps = [rep('1', 9, 3), rep('2', 8, 1)];
    const generated = new Map([
      ['1', gen('国際')],
      ['2', { headline: '作っておいた見出し', lead: 'リード', body: '本文', section: '国際' } as GeneratedArticle],
    ]);
    const byId = new Map([
      ['1', { url: 'https://news.example.com/1', feedTitle: 'A', publishedAt: null }],
      ['2', { url: 'https://news.example.com/2', feedTitle: 'B', publishedAt: null }],
    ]);
    const removed = chooseExcluded([['1', '2']], reps);
    const selected = new Set(['1', '2'].filter((id) => !removed.has(id)));
    const others = buildOthersSections(reps, generated, selected, byId)!;
    const entry = others.flatMap((o) => o.articles).find((a) => a.articleId === 2);
    expect(entry?.headline).toBe('作っておいた見出し');
  });
});

describe('publishedInMainCondition', () => {
  const rendered = new PgDialect().sqlToQuery(publishedInMainCondition());

  it('号の番号があり、かつ included が true の記事だけを対象にする', () => {
    expect(rendered.sql).toContain('"edition_id" is not null');
    expect(rendered.sql).toContain('"included" = $1');
    expect(rendered.params).toEqual([true]);
  });
});

describe('すでに載せた記事の読み込み', () => {
  const src = readFileSync(fileURLToPath(new URL('../editionBuilder.ts', import.meta.url)), 'utf8');
  const bodyOf = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nasync function ', start + 1);
    return src.slice(start, next < 0 ? undefined : next);
  };

  for (const name of ['loadPublishedDedupeItems']) {
    it(`${name} は publishedInMainCondition で絞り込む`, () => {
      expect(bodyOf(name)).toContain('publishedInMainCondition()');
    });
  }
});
