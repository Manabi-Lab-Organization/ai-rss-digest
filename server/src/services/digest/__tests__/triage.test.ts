import { describe, it, expect } from 'vitest';
import {
  buildTriagePrompt,
  parseTriageScores,
  parseTriageScoresDetailed,
  formatTriageGaps,
  applyFeedWeight,
  triageBatch,
  BATCH_SIZE,
  type TriageArticle,
} from '../triage.js';
import { getTriageModel } from '../anthropicClient.js';
import type { AnthropicMessageBody } from '../anthropicClient.js';

const profile = '関心トピックの重み:\n  - トピック: 家庭菜園・園芸道具\n    重み: 高';
const articles: TriageArticle[] = [
  { id: 'aaa111', title: '小さな庭で育てるトマトの工夫', summaryRaw: '架空の園芸店が、狭い庭でトマトを育てるこつを紹介した。' },
  { id: 'bbb222', title: '新しい掃除機の発売', summaryRaw: null },
];

describe('buildTriagePrompt', () => {
  it('出典にはサイト名を付け、一次情報のときだけ種別を付ける', () => {
    const { user } = buildTriagePrompt(profile, [
      { id: 'a1', title: 't', summaryRaw: '', feedTitle: 'サンプル新聞', feedTier: 'none', sourceSite: 'news.example.com' },
      { id: 'a2', title: 't2', summaryRaw: '', feedTitle: '架空省の発表', feedTier: 'primary', sourceSite: 'www.sample.go.jp' },
    ]);
    expect(user).toContain('出典: サンプル新聞（サイト: news.example.com）\n');
    expect(user).toContain('出典: 架空省の発表（サイト: www.sample.go.jp）［一次情報］');
  });

  it('指示文は媒体の名前ではなく、情報源の数と記事の中身で判断させる', () => {
    const { system } = buildTriagePrompt(profile, articles);
    expect(system).toContain('媒体の名前や知名度で点を上げ下げしないでください');
    expect(system).toContain('多くの情報源がすでに報じていて');
    expect(system).toContain('当事者');
    expect(system).not.toMatch(/マスメディア|全国紙|テレビ/);
  });

  it('関心の設定とすべての記事が文に入り、記事は番号で示される', () => {
    const { system, user } = buildTriagePrompt(profile, articles);
    expect(system).toContain('家庭菜園・園芸道具');
    expect(system).toContain('<editorial_profile>');
    expect(user).toContain('[1]');
    expect(user).toContain('[2]');
    expect(user).not.toContain('id: ');
    expect(user).not.toContain('aaa111');
    expect(user).toContain('小さな庭で育てるトマトの工夫');
    expect(user).toContain('要約: (なし)');
  });

  it('要約が長すぎるときは途中で切る', () => {
    const long: TriageArticle[] = [{ id: 'c', title: 't', summaryRaw: 'あ'.repeat(1000) }];
    const { user } = buildTriagePrompt(profile, long);
    expect(user).not.toContain('あ'.repeat(301));
  });
});

describe('parseTriageScores', () => {
  it('JSON の配列だけの返答を読める', () => {
    const scores = parseTriageScores('[{"id":"aaa111","score":5},{"id":"bbb222","score":2}]', articles);
    expect(scores.get('aaa111')).toBe(5);
    expect(scores.get('bbb222')).toBe(2);
  });

  it('前後に文やコードの囲みがあっても配列を取り出せる', () => {
    const text = '点数をつけました。\n```json\n[{"id":"aaa111","score":4}]\n```\nおわり。';
    const scores = parseTriageScores(text, articles);
    expect(scores.get('aaa111')).toBe(4);
  });

  it('知らない id は無視し、1〜5の外の点数は範囲内に収める', () => {
    const text = '[{"id":"unknown","score":5},{"id":"aaa111","score":9},{"id":"bbb222","score":0}]';
    const scores = parseTriageScores(text, articles);
    expect(scores.has('unknown')).toBe(false);
    expect(scores.get('aaa111')).toBe(5);
    expect(scores.get('bbb222')).toBe(1);
  });

  it('配列が見つからない返答は例外にする', () => {
    expect(() => parseTriageScores('点数をつけられません', articles)).toThrow(/JSON配列/);
  });

  it('配列の後ろに余計な文や別の配列があっても、最初の配列だけを読む', () => {
    const t1 = '[{"id":"aaa111","score":4}]\nこれが点数です。';
    expect(parseTriageScores(t1, articles).get('aaa111')).toBe(4);
    const t2 = '[{"id":"aaa111","score":3}]\n[{"id":"bbb222","score":5}]';
    const s2 = parseTriageScores(t2, articles);
    expect(s2.get('aaa111')).toBe(3);
    expect(s2.has('bbb222')).toBe(false);
    const t3 = '[{"id":"aaa111","score":2,"reason":"かっこ ] の入った理由"}]\nあまり]';
    expect(parseTriageScores(t3, articles).get('aaa111')).toBe(2);
  });

  it('id が数値で返ってきても文字列にして照らし合わせる', () => {
    const numeric: TriageArticle[] = [{ id: '123', title: 't', summaryRaw: null }];
    const scores = parseTriageScores('[{"id":123,"score":4}]', numeric);
    expect(scores.get('123')).toBe(4);
  });
});

describe('applyFeedWeight', () => {
  it('重みに関係なく元の点数を返す', () => {
    expect(applyFeedWeight(4, 1.0)).toBe(4);
    expect(applyFeedWeight(4, 0.5)).toBe(4);
  });
});

describe('triageBatch', () => {
  it('差し替えた呼び出し関数を使い、記事ごとの点数を返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: '[{"id":"aaa111","score":5},{"id":"bbb222","score":1}]' }] };
    };
    const scores = await triageBatch(articles, { profileText: profile, createMessageFn });
    expect(captured?.model).toBe(getTriageModel());
    expect(captured?.system).toContain('家庭菜園・園芸道具');
    expect(captured?.messages.length).toBe(1);
    expect(scores.get('aaa111')).toBe(5);
    expect(scores.get('bbb222')).toBe(1);
  });
});

describe('BATCH_SIZE', () => {
  it('1回にまとめる記事の数は20', () => {
    expect(BATCH_SIZE).toBe(20);
  });
});

describe('triageBatch で点数が1件も取れないとき', () => {
  it('返ってきた id がすべて知らないもので0件なら例外にする', async () => {
    const createMessageFn = async () => ({
      content: [{ type: 'text', text: '[{"id":"zzz","score":5}]' }],
    });
    await expect(
      triageBatch(articles, { profileText: profile, createMessageFn }),
    ).rejects.toThrow(/0件/);
  });

  it('一部でも点数が取れていれば結果を返す', async () => {
    const createMessageFn = async () => ({
      content: [{ type: 'text', text: '[{"id":"aaa111","score":4},{"id":"zzz","score":5}]' }],
    });
    const scores = await triageBatch(articles, { profileText: profile, createMessageFn });
    expect(scores.get('aaa111')).toBe(4);
    expect(scores.size).toBe(1);
  });
});

describe('parseTriageScoresDetailed', () => {
  const list: TriageArticle[] = [
    { id: '11', title: 'a', summaryRaw: null },
    { id: '12', title: 'b', summaryRaw: null },
    { id: '13', title: 'c', summaryRaw: null },
  ];

  it('1から始まる番号を記事の id に置き換える', () => {
    const r = parseTriageScoresDetailed('[{"id":1,"score":5},{"id":"2","score":3},{"id":3,"score":1}]', list);
    expect([...r.scores]).toEqual([['11', 5], ['12', 3], ['13', 1]]);
    expect(r.missing).toEqual([]);
  });

  it('番号ではなく id が返ってきても読める', () => {
    expect(parseTriageScoresDetailed('[{"id":"12","score":4}]', list).scores.get('12')).toBe(4);
  });

  it('返答に無かった記事と、一覧に無い番号を分けて返す', () => {
    const r = parseTriageScoresDetailed('[{"id":1,"score":5},{"id":14,"score":3}]', list);
    expect(r.missing).toEqual(['12', '13']);
    expect(r.unknown).toEqual(['14']);
  });

  it('同じ記事に2回点数が付いたら最初の点数を使い、重なった記事を記録する', () => {
    const r = parseTriageScoresDetailed('[{"id":1,"score":5},{"id":1,"score":2},{"id":3,"score":4}]', list);
    expect(r.scores.get('11')).toBe(5);
    expect(r.duplicated).toEqual(['11']);
    expect(r.missing).toEqual(['12']);
  });
});

describe('triageBatch の聞き直し', () => {
  const list: TriageArticle[] = [
    { id: '11', title: 'a', summaryRaw: null },
    { id: '12', title: 'b', summaryRaw: null },
    { id: '13', title: 'c', summaryRaw: null },
  ];

  it('点数の無かった記事だけに番号を付け直して聞き、結果を足す', async () => {
    const asked: string[] = [];
    const lines: string[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      const user = String(body.messages[0].content);
      asked.push(user);
      return { content: [{ type: 'text', text: asked.length === 1 ? '[{"id":1,"score":5}]' : '[{"id":1,"score":2},{"id":2,"score":3}]' }] };
    };
    const scores = await triageBatch(list, { profileText: profile, createMessageFn, logFn: (l) => lines.push(l) });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('以下の2件の記事');
    expect(asked[1]).toContain('タイトル: b');
    expect(asked[1]).not.toContain('タイトル: a');
    expect([...scores].sort()).toEqual([['11', 5], ['12', 2], ['13', 3]]);
    expect(lines[0]).toContain('答えに無かった2件 → もう1回聞いて2件採点');
  });

  it('全部に点数があれば聞き直さず、記録も出さない', async () => {
    let calls = 0;
    const lines: string[] = [];
    const createMessageFn = async () => { calls++; return { content: [{ type: 'text', text: '[{"id":1,"score":5},{"id":2,"score":3},{"id":3,"score":1}]' }] }; };
    await triageBatch(list, { profileText: profile, createMessageFn, logFn: (l) => lines.push(l) });
    expect(calls).toBe(1);
    expect(lines).toEqual([]);
  });

  it('聞き直しが失敗しても最初の点数は使い、失敗したことを記録に書く', async () => {
    let calls = 0;
    const lines: string[] = [];
    const createMessageFn = async () => {
      calls++;
      if (calls === 2) throw new Error('timeout');
      return { content: [{ type: 'text', text: '[{"id":1,"score":5}]' }] };
    };
    const scores = await triageBatch(list, { profileText: profile, createMessageFn, logFn: (l) => lines.push(l) });
    expect(scores.size).toBe(1);
    expect(lines[0]).toContain('やり直し失敗: timeout');
  });

  it('formatTriageGaps は一覧に無い番号と重なった記事の数も書く', () => {
    const line = formatTriageGaps({ total: 20, missing: 1, recovered: 1, unknown: ['23'], duplicated: ['11'] });
    expect(line).toContain('（20件中）: 答えに無かった1件 → もう1回聞いて1件採点');
    expect(line).toContain('一覧に無い番号: 23');
    expect(line).toContain('2回答えた記事1件');
  });
});
