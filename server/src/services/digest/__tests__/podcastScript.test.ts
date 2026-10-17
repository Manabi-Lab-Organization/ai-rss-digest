import { describe, it, expect } from 'vitest';
import {
  buildSectionScriptPrompt,
  parseScript,
  generateScript,
  charsPerArticle,
  targetMinutesFor,
  computeEmptySections,
  scriptStats,
  type PodcastSection,
  scriptCharsFor,
  articleMaterialChars,
  buildOpening,
  spokenProgramName,
  spokenDate,
  OTHER_OUTLETS,
  orderSegments,
  isInArticleOrder,
  missingArticles,
  type ScriptSegment,
} from '../podcastScript.js';
import type { AnthropicMessageBody, CreateMessageFn } from '../anthropicClient.js';

const articleA = {
  headline: '架空の電機メーカーA社が新しい電池を発表',
  lead: '充電にかかる時間が半分になるという',
  body: '来年の春から売り出す予定だ',
  sourceTitle: 'サンプル技術通信',
};
const articleB = {
  headline: '架空町で三年ぶりに秋祭り',
  lead: '駅前の通りに屋台が並んだ',
  body: '町は来年も続ける考えだ',
  sourceTitle: null,
};

const PROGRAM = spokenProgramName('').replace(/のポッドキャスト$/, '');

describe('targetMinutesFor / charsPerArticle', () => {
  it('記事が少なければ短く（最短3分）、多ければ長く（最長30分）する', () => {
    expect(targetMinutesFor(1)).toBe(3);
    expect(targetMinutesFor(2)).toBe(3);
    expect(targetMinutesFor(10)).toBe(15);
    expect(targetMinutesFor(30)).toBe(30);
    expect(targetMinutesFor(100)).toBe(30);
  });

  it('30分で12本なら1本あたり700字前後になる', () => {
    const c = charsPerArticle(12, 30);
    expect(c).toBeGreaterThanOrEqual(600);
    expect(c).toBeLessThanOrEqual(800);
  });

  it('1本あたりの字数は500字から1400字の間に収める', () => {
    expect(charsPerArticle(100, 30)).toBe(500);
    expect(charsPerArticle(1, 30)).toBe(1400);
  });
});

describe('buildSectionScriptPrompt', () => {
  const base = {
    editionTitle: 'サンプル号',
    section: 'テクノロジー・AI',
    articles: [articleA],
    perArticleChars: 800,
    isFirst: true,
    isLast: false,
  };

  it('最初の欄はあいさつをせず、欄の名前から話し始めるよう指示する', () => {
    const { system, user } = buildSectionScriptPrompt('好みの説明', base);
    expect(system).toContain('番組の挨拶と全体像はこの直前で紹介済み');
    expect(system).toContain('まずはテクノロジー・AIからです');
    expect(PROGRAM).toBe('エーアイ アールエスエス ダイジェスト');
    expect(system).not.toContain(`番組名「${PROGRAM}」`);
    expect(system).toContain('記事ごとに「台本の分量」として指定する');
    expect(user).toContain('台本の分量:');
    expect(user).toContain(articleA.headline);
    expect(user).toContain('テクノロジー・AI');
  });

  it('読み手の好みの説明を指示文に入れる', () => {
    const { system } = buildSectionScriptPrompt('園芸と料理の話題が好き', base);
    expect(system).toContain('<editorial_profile>');
    expect(system).toContain('園芸と料理の話題が好き');
  });

  it('記事から機械的に取り出したときに紛れ込んだ文を使わないよう指示する', () => {
    const { system } = buildSectionScriptPrompt('好みの説明', { ...base, isFirst: false, isLast: true });
    expect(system).toContain('機械抽出');
    expect(system).toContain('無関係な断片');
    expect(system).toContain('一語も使わない');
  });

  it('記事のない欄のお知らせは、欄ごとの台本ではなく冒頭で伝える', () => {
    const segs = buildOpening({
      editionDate: '2054-07-19',
      sections: ['テクノロジー・AI'],
      articleCount: 3,
      emptySections: ['文化・スポーツ', '社会・地域'],
    });
    expect(segs[0].text).toContain('文化・スポーツ、社会・地域は、掲載基準を満たす記事がありませんでした');
    expect(buildOpening({ editionDate: '2054-07-19', sections: ['総合'], articleCount: 1 })[0].text)
      .not.toContain('掲載基準を満たす記事がありませんでした');
  });

  it('途中の欄では、次の欄の予告をしないよう指示する', () => {
    const { system } = buildSectionScriptPrompt('好みの説明', { ...base, isFirst: false, isLast: false });
    expect(system).toMatch(/次セクションの.*予告はしない/s);
    expect(system).not.toContain('次のセクションへ渡す一言');
  });

  it('最後の欄では、お別れのあいさつを書かないよう指示する', () => {
    const { system } = buildSectionScriptPrompt('好みの説明', { ...base, isFirst: false, isLast: true });
    expect(system).toMatch(/別れの挨拶.*絶対に書かない/s);
  });

  it('元の記事はHTMLを取り除き、2000字までに切る', () => {
    const { user } = buildSectionScriptPrompt('好みの説明', {
      ...base,
      articles: [{ ...articleA, content: `<p>${'あ'.repeat(3000)}</p>` }],
    });
    expect(user).not.toContain('<p>');
    expect(user).toContain('あ'.repeat(2000));
    expect(user).not.toContain('あ'.repeat(2001));
  });
});

describe('computeEmptySections', () => {
  it('紙面の形では、記事がひとつもない欄を返す（「その他」は除く）', () => {
    const empty = computeEmptySections({
      format: 'paper',
      sections: [
        { name: '総合', articles: [] },
        { name: '経済・ビジネス', articles: [] },
        { name: 'テクノロジー・AI', articles: [] },
        { name: '行政・政策', articles: [] },
        { name: '国際', articles: [] },
      ],
    });
    expect(empty).toEqual(['社会・地域', '文化・スポーツ']);
  });

  it('本数だけを示す形では欄を名乗らないので、いつも空を返す', () => {
    const empty = computeEmptySections({ format: 'brief', sections: [{ name: '総合', articles: [] }] });
    expect(empty).toEqual([]);
  });
});

describe('parseScript', () => {
  it('正しい発言だけを残し、途中で切れていても読めたところまで返す', () => {
    const out = parseScript(`[
      {"speaker": "A", "text": "はじめまして"},
      {"speaker": "C", "text": "知らない話し手"},
      {"speaker": "B", "text": "今回の話題です"}
    ]`);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ speaker: 'A', text: 'はじめまして' });
    expect(parseScript('[{"speaker": "A", "text": "最後まで"}, {"speaker": "B", "te')).toHaveLength(1);
  });

  it('JSONの配列が見つからなければ失敗する', () => {
    expect(() => parseScript('今回は書けませんでした')).toThrow(/JSON配列/);
  });
});

describe('generateScript', () => {
  it('欄ごとに分けて作り、つなげて返す', async () => {
    const calls: AnthropicMessageBody[] = [];
    const createMessageFn: CreateMessageFn = async (body) => {
      calls.push(body);
      return {
        content: [{
          type: 'text',
          text: '[{"speaker":"A","article":1,"text":"ひとつめの話"},{"speaker":"B","article":2,"text":"ふたつめの話"}]',
        }],
      };
    };
    const sections: PodcastSection[] = [
      { name: 'テクノロジー・AI', articles: [articleA, articleB] },
      { name: 'その他', articles: [articleA] },
    ];
    const segs = await generateScript(
      sections,
      { editionTitle: 'サンプル号', editionDate: '2054-07-19' },
      { profileText: 'p', createMessageFn },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].system).toMatch(/別れの挨拶.*書かない/s);
    expect(segs).toHaveLength(6);
    expect(segs[0].text).toContain('しちがつじゅうくにちのポッドキャストです');
  });

  it('記事のない欄は飛ばし、全部の欄が空なら失敗する', async () => {
    const createMessageFn: CreateMessageFn = async () => ({
      content: [{ type: 'text', text: '[{"speaker":"B","article":1,"text":"x"}]' }],
    });
    const segs = await generateScript(
      [{ name: '空', articles: [] }, { name: '総合', articles: [articleA] }],
      { editionTitle: 't', editionDate: '2054-09-11' },
      { profileText: 'p', createMessageFn },
    );
    expect(segs).toHaveLength(3);
    await expect(
      generateScript([{ name: '空', articles: [] }], { editionTitle: 't', editionDate: '2054-09-11' }, { profileText: 'p', createMessageFn }),
    ).rejects.toThrow(/記事がありません/);
  });
});

describe('scriptStats', () => {
  it('全体の字数と、1分300字で読んだときの分数を返す', () => {
    const stats = scriptStats([
      { speaker: 'A', text: 'あ'.repeat(400) },
      { speaker: 'B', text: 'い'.repeat(500) },
    ]);
    expect(stats.chars).toBe(900);
    expect(stats.estimatedMinutes).toBe(3);
  });
});

describe('scriptCharsFor', () => {
  it('材料が十分あれば目標どおりの字数にする', () => {
    expect(scriptCharsFor(1500, 1400)).toBe(1400);
    expect(scriptCharsFor(5000, 900)).toBe(900);
  });

  it('材料が少ないほど上限を下げる', () => {
    expect(scriptCharsFor(800, 1400)).toBe(800);
    expect(scriptCharsFor(400, 1400)).toBe(500);
    expect(scriptCharsFor(100, 1400)).toBe(300);
  });

  it('目標が上限より小さければ目標のほうを使う', () => {
    expect(scriptCharsFor(100, 200)).toBe(200);
  });

  it('articleMaterialChars は前文・本文・元の記事の字数を足し合わせる', () => {
    expect(articleMaterialChars({ lead: 'あ'.repeat(10), body: 'い'.repeat(20), content: 'う'.repeat(30) })).toBe(60);
  });
});

describe('buildSectionScriptPrompt（正確に話すための決まりと分量）', () => {
  const article = (over = {}) => ({
    headline: '架空の食品会社B社が新しい菓子', lead: '秋限定の味', body: '全国の店で売る', sourceTitle: 'サンプル新聞', content: null, ...over,
  });
  const input = (articles: any[]) => ({
    editionTitle: 'テスト号', section: '経済・ビジネス', articles,
    perArticleChars: 1400, isFirst: true, isLast: true,
  });

  it('記事ごとに台本の分量を入れる', () => {
    const { user } = buildSectionScriptPrompt('# profile', input([article()]));
    expect(user).toContain('台本の分量: 約300字まで');
  });

  it('短すぎる台本を認めないといった下限の求めは入っていない', () => {
    const { system } = buildSectionScriptPrompt('# profile', input([article()]));
    expect(system).not.toContain('不合格');
    expect(system).not.toContain('最低');
  });

  it('材料にない事実を足すことと、時間を埋めるための水増しを禁じている', () => {
    const { system } = buildSectionScriptPrompt('# profile', input([article()]));
    expect(system).toContain('あなたの知識から足してはならない');
    expect(system).toContain('尺を満たすための埋め合わせも禁止');
  });

  it('肩書についての決まりも台本の指示に入っている', () => {
    const { system } = buildSectionScriptPrompt('# profile', input([article()]));
    expect(system).toContain('報じている出来事の一部である場合のみ言う');
    expect(system).toContain('氏名だけを言う');
  });
});

describe('parseScript（ひとつも読めないときは成功にしない）', () => {
  it('話し手の書き方が違う返事は失敗にする', () => {
    expect(() => parseScript('[{"speaker":"案内役","text":"はじめまして"}]'))
      .toThrow(/セグメントが0件/);
  });

  it('欄の台本づくりで失敗したらやり直す', async () => {
    let calls = 0;
    const createMessageFn: CreateMessageFn = async () => {
      calls++;
      return calls <= 2
        ? { content: [{ type: 'text', text: '[{"speaker":"案内役","text":"x"}]' }] }
        : { content: [{ type: 'text', text: '[{"speaker":"A","text":"ここから本題です"}]' }] };
    };
    const segs = await generateScript(
      [{ name: '総合', articles: [articleA] }],
      { editionTitle: 't', editionDate: '2054-09-11' },
      { profileText: 'p', createMessageFn, sleepFn: async () => {} },
    );
    expect(calls).toBeGreaterThan(2);
    expect(segs.some((s) => s.text === 'ここから本題です')).toBe(true);
  });
});

describe('orderSegments / isInArticleOrder', () => {
  const seg = (article: number | undefined, text: string): ScriptSegment =>
    article === undefined ? { speaker: 'A', text } : { speaker: 'A', article, text };

  it('記事の順に並んでいれば何も動かさない', () => {
    const segs = [seg(1, 'a1'), seg(1, 'a1-2'), seg(2, 'a2'), seg(3, 'a3')];
    expect(orderSegments(segs, 3)).toEqual(segs);
    expect(isInArticleOrder(segs, 3)).toBe(true);
  });

  it('順が入れ替わっていれば記事の順に並べ直す', () => {
    const segs = [seg(3, 'a3'), seg(1, 'a1'), seg(2, 'a2')];
    expect(isInArticleOrder(segs, 3)).toBe(false);
    expect(orderSegments(segs, 3).map((s) => s.text)).toEqual(['a1', 'a2', 'a3']);
  });

  it('同じ記事の中の発言どうしの順は変えない', () => {
    const segs = [seg(2, 'b1'), seg(2, 'b2'), seg(1, 'a1'), seg(1, 'a2')];
    expect(orderSegments(segs, 2).map((s) => s.text)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('番号のない発言は、ひとつ前の記事といっしょに動く', () => {
    const segs = [seg(2, 'b1'), seg(undefined, 'b-うなずき'), seg(1, 'a1')];
    expect(orderSegments(segs, 2).map((s) => s.text)).toEqual(['a1', 'b1', 'b-うなずき']);
  });

  it('先頭にある番号のない発言は先頭のままにする', () => {
    const segs = [seg(undefined, '次は暮らしの話題です'), seg(2, 'b'), seg(1, 'a')];
    expect(orderSegments(segs, 2).map((s) => s.text)).toEqual(['次は暮らしの話題です', 'a', 'b']);
  });

  it('記事の数より大きい番号は並べ替えに使わない', () => {
    const segs = [seg(1, 'a'), seg(9, 'a-つづき')];
    expect(isInArticleOrder(segs, 1)).toBe(true);
    expect(orderSegments(segs, 1).map((s) => s.text)).toEqual(['a', 'a-つづき']);
  });
});

describe('missingArticles', () => {
  it('台本で取り上げられていない記事の番号を返す', () => {
    const segs: ScriptSegment[] = [{ speaker: 'A', article: 1, text: 'a' }, { speaker: 'B', article: 3, text: 'c' }];
    expect(missingArticles(segs, 3)).toEqual([2]);
    expect(missingArticles(segs, 4)).toEqual([2, 4]);
  });

  it('全部取り上げられていれば空を返す', () => {
    const segs: ScriptSegment[] = [{ speaker: 'A', article: 1, text: 'a' }, { speaker: 'B', article: 2, text: 'b' }];
    expect(missingArticles(segs, 2)).toEqual([]);
  });
});

describe('generateScript（記事の順を守る）', () => {
  const sections: PodcastSection[] = [
    { name: 'テクノロジー・AI', articles: [articleA, articleB] },
    { name: '総合', articles: [articleA] },
  ];

  const mockFor = (sectionText: string | (() => string)) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      fn: (async () => {
        calls++;
        return { content: [{ type: 'text', text: typeof sectionText === 'function' ? sectionText() : sectionText }] };
      }) as CreateMessageFn,
    };
  };

  const bodyTexts = (segs: ScriptSegment[]) => segs.slice(2).map((x) => x.text);

  it('欄は並んでいる順に、記事のあるものから作る', async () => {
    const asked: string[] = [];
    const createMessageFn: CreateMessageFn = async (body) => {
      const user = String(body.messages[0].content);
      const m = /セクション「(.+?)」の記事:/.exec(user);
      if (m) asked.push(m[1]);
      return { content: [{ type: 'text', text: '[{"speaker":"A","article":1,"text":"x"},{"speaker":"B","article":2,"text":"y"}]' }] };
    };
    await generateScript(sections, { editionTitle: 't', editionDate: '2054-09-11' }, { profileText: 'p', createMessageFn });
    expect(asked).toEqual(['テクノロジー・AI', '総合']);
  });

  it('記事の順が入れ替わった台本は、正しい順に直してから返す', async () => {
    const m = mockFor('[{"speaker":"A","article":2,"text":"秋祭りの話"},{"speaker":"B","article":1,"text":"電池の話"}]');
    const segs = await generateScript(
      [{ name: 'テクノロジー・AI', articles: [articleA, articleB] }],
      { editionTitle: 't', editionDate: '2054-09-11' },
      { profileText: 'p', createMessageFn: m.fn },
    );
    expect(bodyTexts(segs)).toEqual(['電池の話', '秋祭りの話']);
    expect(m.calls).toBe(1);
  });

  it('取り上げていない記事がある台本は作り直してもらう', async () => {
    let n = 0;
    const m = mockFor(() => {
      n++;
      return n === 1
        ? '[{"speaker":"A","article":1,"text":"電池の話だけ"}]'
        : '[{"speaker":"A","article":1,"text":"電池の話"},{"speaker":"B","article":2,"text":"秋祭りの話"}]';
    });
    const segs = await generateScript(
      [{ name: 'テクノロジー・AI', articles: [articleA, articleB] }],
      { editionTitle: 't', editionDate: '2054-09-11' },
      { profileText: 'p', createMessageFn: m.fn, sleepFn: async () => {} },
    );
    expect(n).toBe(2);
    expect(bodyTexts(segs)).toEqual(['電池の話', '秋祭りの話']);
  });

  it('作り直しても足りないままなら、その台本をそのまま使う', async () => {
    const m = mockFor('[{"speaker":"A","article":1,"text":"電池の話だけ"}]');
    const segs = await generateScript(
      [{ name: 'テクノロジー・AI', articles: [articleA, articleB] }],
      { editionTitle: 't', editionDate: '2054-09-11' },
      { profileText: 'p', createMessageFn: m.fn, sleepFn: async () => {} },
    );
    expect(bodyTexts(segs)).toEqual(['電池の話だけ']);
  });

  it('できあがった台本には記事番号の目印を残さない', async () => {
    const m = mockFor('[{"speaker":"A","article":1,"text":"x"},{"speaker":"B","article":2,"text":"y"}]');
    const segs = await generateScript(sections, { editionTitle: 't', editionDate: '2054-09-11' }, { profileText: 'p', createMessageFn: m.fn });
    for (const s of segs) expect(s).toEqual({ speaker: s.speaker, text: s.text });
  });
});

describe('buildSectionScriptPrompt（記事の順についての指示）', () => {
  it('示した順に・すべての記事を・番号付きで扱うよう指示する', () => {
    const { system } = buildSectionScriptPrompt('p', {
      editionTitle: 't', section: '総合', articles: [articleA, articleB],
      perArticleChars: 800, isFirst: true, isLast: true,
    });
    expect(system).toContain('提示された順（[1] → [2] → …）に扱う');
    expect(system).toContain('入れ替えてはならない');
    expect(system).toContain('提示された記事はすべて扱う');
    expect(system).toContain('article として付ける');
    expect(system).toContain('"article": 1');
  });
});

describe('指示文に実在の配信元の名前を入れない', () => {
  const sectionSystem = buildSectionScriptPrompt('p', {
    editionTitle: 't', section: '総合', articles: [articleA],
    perArticleChars: 800, isFirst: true, isLast: true,
  }).system;

  it('欄ごとの指示文に配信元の名前が入っていない', () => {
    for (const outlet of OTHER_OUTLETS) expect(sectionSystem).not.toContain(outlet);
  });

  it('決まった冒頭にも配信元の名前が入っていない', () => {
    const text = buildOpening({ editionDate: '2054-09-11', sections: ['総合'], articleCount: 3 })
      .map((x) => x.text).join('');
    for (const outlet of OTHER_OUTLETS) expect(text).not.toContain(outlet);
  });

  it('番組の雰囲気は名前でなく性質で伝えている', () => {
    expect(sectionSystem).toContain('経済紙の紙面を音声にしたような番組');
  });

});

describe('spokenProgramName', () => {
  it('日付から番組の名乗りを作り、月日は読みで書く', () => {
    expect(spokenProgramName('2054-09-11')).toBe(`${PROGRAM}、くがつじゅういちにちのポッドキャスト`);
    expect(spokenProgramName('2054-01-05')).toBe(`${PROGRAM}、いちがついつかのポッドキャスト`);
  });

  it('名乗りに「朝刊」を入れない', () => {
    expect(spokenProgramName('2054-09-11')).not.toContain('朝刊');
  });

  it('日付が読めなくても、日付なしの名乗りを返す', () => {
    expect(spokenProgramName('よめない日付')).toBe(`${PROGRAM}のポッドキャスト`);
    expect(spokenProgramName('')).toBe(`${PROGRAM}のポッドキャスト`);
  });
});

describe('buildOpening', () => {
  const base = { editionDate: '2054-09-11', sections: ['総合', '経済・ビジネス'], articleCount: 12 };

  it('番組名・日付・欄・本数を決まった言い方で伝える', () => {
    const segs = buildOpening(base);
    expect(segs[0].text).toBe(
      `${PROGRAM}、くがつじゅういちにちのポッドキャストです。`
      + '本日は総合、経済・ビジネスの各面から、あわせて12本の記事をお届けします。',
    );
    expect(segs[1]).toEqual({ speaker: 'B', text: 'よろしくお願いします。さっそく見ていきましょう。' });
  });

  it('時間帯で変わるあいさつは入れない', () => {
    const text = buildOpening(base).map((s) => s.text).join('');
    for (const greeting of ['おはようございます', 'こんにちは', 'こんばんは', '本日のあさ', '今朝']) {
      expect(text).not.toContain(greeting);
    }
  });

  it('同じ入力からはいつも同じ冒頭になる', () => {
    expect(buildOpening(base)).toEqual(buildOpening(base));
  });

  it('記事のない欄があればひとこと添える', () => {
    const segs = buildOpening({ ...base, emptySections: ['社会・地域'] });
    expect(segs[0].text).toContain('なお、社会・地域は、掲載基準を満たす記事がありませんでした。');
  });
});

describe('中身の作り直しは何度も繰り返さない', () => {
  const sections: PodcastSection[] = [{ name: '総合', articles: [articleA, articleB] }];
  const short = '[{"speaker":"A","article":1,"text":"電池の話だけ"}]';

  it('中身が足りないときの作り直しは2回目で終える', async () => {
    let calls = 0;
    const createMessageFn: CreateMessageFn = async () => {
      calls++;
      return { content: [{ type: 'text', text: short }] };
    };
    const segs = await generateScript(
      sections,
      { editionTitle: 't', editionDate: '2054-09-13' },
      { profileText: 'p', createMessageFn, sleepFn: async () => {} },
    );
    expect(calls).toBe(2);
    expect(segs.map((s) => s.text)).toContain('電池の話だけ');
  });

  it('通信の失敗なら、もっと多くやり直す', async () => {
    let calls = 0;
    const createMessageFn: CreateMessageFn = async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return { content: [{ type: 'text', text: '[{"speaker":"A","article":1,"text":"電池の話"},{"speaker":"B","article":2,"text":"秋祭りの話"}]' }] };
    };
    const segs = await generateScript(
      sections,
      { editionTitle: 't', editionDate: '2054-09-13' },
      { profileText: 'p', createMessageFn, sleepFn: async () => {} },
    );
    expect(calls).toBe(3);
    expect(segs.map((s) => s.text)).toContain('秋祭りの話');
  });
});

describe('spokenDate', () => {
  it('読み方がいくつかある月は、決めた読みで返す', () => {
    expect(spokenDate(4, 2)).toBe('しがつふつか');
    expect(spokenDate(7, 2)).toBe('しちがつふつか');
    expect(spokenDate(9, 2)).toBe('くがつふつか');
  });

  it('特別な読み方をする日を正しく返す', () => {
    expect(spokenDate(10, 1)).toBe('じゅうがつついたち');
    expect(spokenDate(1, 8)).toBe('いちがつようか');
    expect(spokenDate(1, 20)).toBe('いちがつはつか');
    expect(spokenDate(1, 14)).toBe('いちがつじゅうよっか');
    expect(spokenDate(1, 24)).toBe('いちがつにじゅうよっか');
  });

  it('12か月と31日のどの組み合わせにも読みがある', () => {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        expect(spokenDate(m, d)).not.toMatch(/[0-9]/);
      }
    }
  });

  it('ありえない月日は数字のまま返す', () => {
    expect(spokenDate(13, 1)).toBe('13月1日');
    expect(spokenDate(1, 32)).toBe('1月32日');
    expect(spokenDate(0, 0)).toBe('0月0日');
  });
});
