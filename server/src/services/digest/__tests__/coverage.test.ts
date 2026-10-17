import { describe, it, expect } from 'vitest';
import {
  summarizeCoverage,
  formatCoverageFacts,
  mentionsAi,
  coverageFactsBlock,
  AI_SECTIONS,
  type CoverageRow,
} from '../coverage.js';
import { buildReviewPrompt } from '../profileReview.js';
import { buildRevisePrompt } from '../proposalChat.js';
import { buildChatSystemPrompt } from '../sourceChat.js';
import { buildTriagePrompt } from '../triage.js';

let seq = 0;
const row = (
  editionId: number,
  section: string,
  headline: string,
  { feedTitle = 'サンプル新聞', lead = '書き出し' }: { feedTitle?: string; lead?: string } = {},
): CoverageRow => ({
  id: ++seq,
  editionId,
  editionDate: `2054-09-0${editionId}`,
  section,
  summary: `${headline}｜${lead}｜続き`,
  title: headline,
  feedTitle,
});

describe('mentionsAi', () => {
  it('AI に関わる言葉は拾い、英単語の中に ai が含まれるだけのものは拾わない', () => {
    expect(mentionsAi('架空の食品メーカーがAI導入')).toBe(true);
    expect(mentionsAi('人工知能で在庫を予測')).toBe(true);
    expect(mentionsAi('大規模言語モデルの比較')).toBe(true);
    expect(mentionsAi('Email said the trail remains fair')).toBe(false);
    expect(mentionsAi('町の図書館が改装へ')).toBe(false);
  });
});

describe('summarizeCoverage', () => {
  it('面ごとの本数を紙面の順に数え、AI 面の割合と、ほかの面で AI に触れた記事の割合を別々に出す', () => {
    const rows = [
      row(1, 'テクノロジー・AI', '人工知能で在庫を予測'),
      row(1, '総合', '町の図書館が改装へ'),
      row(1, '経済・ビジネス', '架空の食品メーカーがAI導入'),
      row(1, '経済・ビジネス', '株式会社サンプルが新工場'),
    ];
    const s = summarizeCoverage(rows, { days: 30 });
    expect(s.editions).toBe(1);
    expect(s.articles).toBe(4);
    expect(s.sections.map((x) => x.section)).toEqual(['総合', '経済・ビジネス', 'テクノロジー・AI']);
    expect(s.sections.find((x) => x.section === '経済・ビジネス')?.count).toBe(2);
    expect(s.ai.sectionCount).toBe(1);
    expect(s.ai.sectionShare).toBe(25);
    expect(s.ai.generalTotal).toBe(3);
    expect(s.ai.generalAiCount).toBe(1);
    expect(s.ai.generalAiShare).toBe(33);
    expect(AI_SECTIONS).toContain('テクノロジー・AI');
  });

  it('出典ごとの本数を多い順に並べて返す', () => {
    const rows = [
      row(1, '国際', 'x1', { feedTitle: 'フィードA' }),
      row(1, '国際', 'x2', { feedTitle: 'フィードA' }),
      row(1, '国際', 'x3', { feedTitle: 'フィードB' }),
      { ...row(1, '国際', 'x4'), feedTitle: null },
    ];
    const s = summarizeCoverage(rows);
    expect(s.feeds.map((f) => f.feedTitle)).toEqual(['フィードA', 'フィードB', '(出典不明)']);
    expect(s.feeds[0].share).toBe(50);
  });
});

describe('formatCoverageFacts', () => {
  it('集計結果を読みやすい箇条書きの文にする', () => {
    const rows = [
      row(1, '国際', '架空の港町で祭り'),
      row(2, '国際', '架空の港町の祭りが続く'),
      row(2, 'テクノロジー・AI', '人工知能で在庫を予測'),
    ];
    const text = formatCoverageFacts(summarizeCoverage(rows, { days: 30 }), { today: '2054-09-06' });
    expect(text).toMatch(/直近30日・2号・掲載3本・集計日 2054-09-06/);
    expect(text).toMatch(/面ごとの本数: テクノロジー・AI 1本\(33%\) \/ 国際 2本\(67%\)/);
    expect(text).toMatch(/AI面（テクノロジー・AI）の比率: 33%/);
    expect(text).not.toMatch(/過去号との重なり/);
    expect(text).toMatch(/出典の偏り（上位）: サンプル新聞 100%/);
  });

  it('記事が一本も無いときは、そのことだけを書く', () => {
    expect(formatCoverageFacts(summarizeCoverage([], { days: 7 }))).toMatch(/直近7日に掲載記事がありません/);
  });
});

describe('集計結果を指示文に入れる', () => {
  const facts = '紙面の実績（直近30日）\n■ AI面の比率: 40%';

  it('集計が空なら何も入れず、あればタグで囲む', () => {
    expect(coverageFactsBlock('')).toEqual([]);
    expect(coverageFactsBlock(null)).toEqual([]);
    expect(coverageFactsBlock(facts).join('\n')).toBe(`<coverage_facts>\n${facts}\n</coverage_facts>\n`);
  });

  it('方針の見直しの指示文に、集計と数字の使い方の決まりが入る', () => {
    const withFacts = buildReviewPrompt('p', [], [], facts);
    expect(withFacts.system).toContain(`<coverage_facts>\n${facts}\n</coverage_facts>`);
    expect(withFacts.system).toMatch(/数字を引用する/);
    const without = buildReviewPrompt('p', [], []);
    expect(without.system).not.toContain('coverage_facts');
  });

  it('案の書き直しの指示文に、集計と数字を根拠にする決まりが入る', () => {
    const history = [{ role: 'user' as const, content: '国際の記事が多すぎない？' }];
    const withFacts = buildRevisePrompt('current', 'draft', history, facts);
    expect(withFacts.system).toContain(`<coverage_facts>\n${facts}\n</coverage_facts>`);
    expect(withFacts.system).toMatch(/実測値を根拠にする/);
    const without = buildRevisePrompt('current', 'draft', history);
    expect(without.system).not.toContain('coverage_facts');
    expect(without.system).not.toMatch(/実測値を根拠にする/);
  });

  it('相談の会話の指示文に、集計を別の段として入れ、無ければ共通の段だけにする', () => {
    const withFacts = buildChatSystemPrompt([], [], facts);
    expect(withFacts).toHaveLength(2);
    expect(withFacts[1].text).toContain('読者の直近の紙面の実績（実測）');
    expect(withFacts[1].text).toContain(facts);
    expect(withFacts[1].text).toMatch(/手薄な面を情報源の提案で埋め|その面や角度を埋める情報源/);
    expect(buildChatSystemPrompt([], [], '')).toHaveLength(1);
  });
});

describe('buildTriagePrompt', () => {
  it('採点役の名乗りを、特定分野ではなく総合紙のものにする', () => {
    const { system } = buildTriagePrompt('p', [{ id: 'x', title: 't', summaryRaw: '', feedTitle: 'f', feedTier: 'specialist' } as never]);
    expect(system).toMatch(/総合ダイジェスト紙/);
  });
});
