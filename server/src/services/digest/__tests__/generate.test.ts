import { describe, it, expect } from 'vitest';
import {
  pickRepresentatives,
  buildGeneratePrompt,
  parseGenerated,
  parseGeneratedDetailed,
  formatGenerateGaps,
  selectTopPerSection,
  generateBatch,
  DEFAULT_SECTIONS,
  type GenerateArticle,
  materialChars,
  writingPlan,
} from '../generate.js';
import { getGenerateModel, type AnthropicMessageBody } from '../anthropicClient.js';
import { OTHER_OUTLETS } from '../podcastScript.js';

const a = (
  id: string,
  {
    score = 3,
    cluster = null,
    feed = 1,
    summary = '',
    content = '',
  }: {
    score?: number;
    cluster?: string | null;
    feed?: number;
    summary?: string;
    content?: string;
  } = {},
): GenerateArticle => ({
  id,
  feedId: feed,
  title: `title-${id}`,
  summaryRaw: summary,
  content,
  clusterId: cluster,
  triageScore: score,
});

describe('pickRepresentatives', () => {
  it('同じ話題のまとまりからは点数がいちばん高い記事を選ぶ', () => {
    const reps = pickRepresentatives([
      a('x1', { cluster: 'cl_1', score: 3, feed: 1 }),
      a('x2', { cluster: 'cl_1', score: 5, feed: 2 }),
      a('x3', { cluster: null, score: 4 }),
    ]);
    expect(reps.length).toBe(2);
    const cl = reps.find((r) => r.memberIds.length === 2);
    expect(cl?.rep.id).toBe('x2');
    expect(cl?.clusterSize).toBe(2);
    expect(cl?.feedCount).toBe(2);
  });

  it('点数が同じなら要約の長いほうを選ぶ', () => {
    const reps = pickRepresentatives([
      a('x1', { cluster: 'cl_1', score: 4, summary: '新製品の話' }),
      a('x2', { cluster: 'cl_1', score: 4, summary: '架空の電機メーカーA社が新しい電池を発表した' }),
    ]);
    expect(reps[0].rep.id).toBe('x2');
  });
});

describe('buildGeneratePrompt', () => {
  it('すべての記事の番号と欄の一覧が入り、内部の識別子は出さない', () => {
    const reps = pickRepresentatives([a('x1'), a('x2')]);
    const { system, user } = buildGeneratePrompt('読み手の好みの説明', reps);
    expect(system).toMatch(/読み手の好みの説明/);
    for (const s of DEFAULT_SECTIONS) expect(system).toContain(s);
    expect(user).toMatch(/\[1\] \(score/);
    expect(user).toMatch(/\[2\] \(score/);
    expect(user).not.toMatch(/id: /);
    expect(user).toContain('title-x1');
  });

  it('同じ出来事を報じた情報源の数を数え、媒体の種類では分けない', () => {
    const reps = pickRepresentatives([
      { ...a('m1', { cluster: 'cl_1', score: 4, feed: 1 }), feedTitle: 'サンプル新聞' },
      { ...a('m2', { cluster: 'cl_1', score: 3, feed: 1 }), feedTitle: '架空テレビ' },
      { ...a('s1', { cluster: 'cl_1', score: 3, feed: 3 }), feedTitle: 'サンプル新聞' },
    ]);
    expect(reps[0].sourceCount).toBe(2);
    const { user, system } = buildGeneratePrompt('p', reps);
    expect(user).toMatch(/sources: 2, cluster: 3記事/);
    expect(system).toContain('既知性の軸');
    expect(system).not.toMatch(/マスメディア|全国紙|テレビ/);
  });

});

describe('parseGenerated', () => {
  it('知らない識別子は捨て、知らない欄は「その他」にする', () => {
    const reps = pickRepresentatives([a('x1'), a('x2')]);
    const text = `はじめに [
      {"id": "x1", "headline": "A社が新しい電池を発表", "lead": "充電の時間が短くなる", "section": "テクノロジー・AI"},
      {"id": "x2", "headline": "架空町で秋祭り", "lead": "三年ぶりの開催", "section": "どこにもない欄"},
      {"id": "zzz", "headline": "関係ない", "lead": "関係ない", "section": "その他"}
    ] おわりに`;
    const out = parseGenerated(text, reps);
    expect(out.size).toBe(2);
    expect(out.get('x1')?.section).toBe('テクノロジー・AI');
    expect(out.get('x2')?.section).toBe('その他');
  });

  it('途中で切れた配列でも、最後まで書けているところまでは読む', () => {
    const reps = pickRepresentatives([a('x1'), a('x2')]);
    const truncated = `[
      {"id": "x1", "headline": "A社が新しい電池を発表", "lead": "充電の時間が短くなる", "section": "その他"},
      {"id": "x2", "headline": "架空町で秋`;
    const out = parseGenerated(truncated, reps);
    expect(out.size).toBe(1);
    expect(out.get('x1')?.headline).toBe('A社が新しい電池を発表');
  });
});

describe('selectTopPerSection', () => {
  it('欄ごとに上限の本数まで選び、複数の配信元が報じた話題を優先する', () => {
    const articles: GenerateArticle[] = [];
    for (let i = 0; i < 8; i++) articles.push(a(`s${i}`, { score: 3 + (i % 3), feed: 10 + i }));
    articles.push(a('m1', { cluster: 'cl_m', score: 3, feed: 1 }));
    articles.push(a('m2', { cluster: 'cl_m', score: 3, feed: 2 }));
    const reps = pickRepresentatives(articles);
    const generated = new Map(
      reps.map((r) => [r.rep.id, { headline: 'h', lead: 'l', body: '', section: 'テクノロジー・AI' }]),
    );
    const selected = selectTopPerSection(reps, generated, 5);
    expect(selected.size).toBe(5);
    expect(selected.has('m1') || selected.has('m2')).toBe(true);
  });

  it('外すよう指定した記事を除き、次の候補で埋める', () => {
    const articles: GenerateArticle[] = [];
    for (let i = 0; i < 7; i++) articles.push(a(`e${i}`, { score: 5 - (i % 3), feed: 10 + i }));
    const reps = pickRepresentatives(articles);
    const generated = new Map(
      reps.map((r) => [r.rep.id, { headline: 'h', lead: 'l', body: '', section: 'テクノロジー・AI' }]),
    );
    const first = selectTopPerSection(reps, generated, 5);
    expect(first.size).toBe(5);
    const [victim] = [...first];
    const second = selectTopPerSection(reps, generated, 5, new Set([victim]));
    expect(second.size).toBe(5);
    expect(second.has(victim)).toBe(false);
  });

  it('ひとつの配信元から選ぶのは1回につき2本まで', () => {
    const articles: GenerateArticle[] = [];
    for (let i = 0; i < 5; i++) articles.push(a(`same${i}`, { score: 5, feed: 1 }));
    articles.push(a('other1', { score: 3, feed: 2 }));
    articles.push(a('other2', { score: 3, feed: 3 }));
    const reps = pickRepresentatives(articles);
    const generated = new Map(
      reps.map((r) => [r.rep.id, { headline: 'h', lead: 'l', body: '', section: 'テクノロジー・AI' }]),
    );
    const selected = selectTopPerSection(reps, generated, 5);
    const sameCount = [...selected].filter((id) => id.startsWith('same')).length;
    expect(sameCount).toBe(2);
    expect(selected.has('other1') && selected.has('other2')).toBe(true);
  });
});

const noSleep = async () => {};

describe('generateBatch', () => {
  it('呼び出しの結果を記事ごとに返し、設定どおりのモデルを使う', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return {
        content: [
          {
            type: 'text',
            text: '[{"id":"x1","headline":"A社が新しい電池を発表","lead":"充電の時間が短くなる","body":"来年から売り出す","section":"総合"}]',
          },
        ],
      };
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn });
    expect(captured?.model).toBe(getGenerateModel());
    expect(out.get('x1')?.headline).toBe('A社が新しい電池を発表');
    expect(out.get('x1')?.section).toBe('総合');
    expect(captured?.system).toEqual([
      { type: 'text', text: buildGeneratePrompt('p', reps).system, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('読めない返事ならやり直し、うまくいった返事を使う', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls === 1) return { content: [{ type: 'text', text: '何もありません' }] };
      return {
        content: [
          { type: 'text', text: '[{"id":"x1","headline":"h","lead":"l","section":"その他"}]' },
        ],
      };
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep });
    expect(calls).toBe(2);
    expect(out.get('x1')?.headline).toBe('h');
  });

  it('通信の失敗はやり直して立ち直る', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return {
        content: [
          { type: 'text', text: '[{"id":"x1","headline":"h","lead":"l","section":"その他"}]' },
        ],
      };
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep });
    expect(calls).toBe(2);
    expect(out.get('x1')?.headline).toBe('h');
  });

  it('混雑や相手側の不調を示すコードもやり直し、最大3回まで試す', async () => {
    for (const status of [429, 500, 529]) {
      const reps = pickRepresentatives([a('x1')]);
      let calls = 0;
      const createMessageFn = async () => {
        calls++;
        if (calls < 3) throw new Error(`Anthropic API HTTP ${status}: overloaded`);
        return {
          content: [
            { type: 'text', text: '[{"id":"x1","headline":"h","lead":"l","section":"その他"}]' },
          ],
        };
      };
      const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep });
      expect(calls).toBe(3);
      expect(out.get('x1')?.headline).toBe('h');
    }
  });

  it('送った側の誤りを示すコードではやり直さず、すぐに失敗する', async () => {
    for (const status of [400, 401, 403]) {
      const reps = pickRepresentatives([a('x1')]);
      let calls = 0;
      const createMessageFn = async () => {
        calls++;
        throw new Error(`Anthropic API HTTP ${status}: invalid x-api-key`);
      };
      await expect(
        generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(calls).toBe(1);
    }
  });

  it('やり直しの回数を使い切ったら、最後の失敗をそのまま投げる', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    await expect(
      generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep }),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('やり直しまでの待ち時間は10秒、次は20秒と延びる', async () => {
    const reps = pickRepresentatives([a('x1')]);
    const waits: number[] = [];
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls < 3) throw new TypeError('fetch failed');
      return {
        content: [
          { type: 'text', text: '[{"id":"x1","headline":"h","lead":"l","section":"その他"}]' },
        ],
      };
    };
    await generateBatch(reps, {
      profileText: 'p',
      createMessageFn,
      sleepFn: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([10_000, 20_000]);
  });
});

describe('parseGenerated（配列でなくひとつのオブジェクトで返ってきたとき）', () => {
  const reps = pickRepresentatives([
    { id: '3501', title: 't', summaryRaw: 's', clusterId: null, triageScore: 4 },
  ]);

  it('オブジェクトひとつだけの返事も読み取れる', () => {
    const text = '{"id": "3501", "headline": "A社が新しい電池を発表", "lead": "充電の時間が短くなる", "body": "来年から売り出す", "section": "テクノロジー・AI"}';
    const out = parseGenerated(text, reps);
    expect(out.get('3501')?.headline).toBe('A社が新しい電池を発表');
    expect(out.get('3501')?.section).toBe('テクノロジー・AI');
  });

  it('前に文やコードの囲みが付いていても読み取れる', () => {
    const text = '```json\n{"id":"3501","headline":"h","lead":"l","section":"その他"}\n```';
    expect(parseGenerated(text, reps).get('3501')?.headline).toBe('h');
  });

  it('配列の返事はこれまでどおり読み取る', () => {
    const text = '[{"id":"3501","headline":"h2","lead":"l","section":"その他"}]';
    expect(parseGenerated(text, reps).get('3501')?.headline).toBe('h2');
  });

  it('JSONらしいものがまったくなければ失敗する', () => {
    expect(() => parseGenerated('今回はお手伝いできません', reps)).toThrow(/JSON配列が見つかりません/);
  });
});

describe('materialChars / writingPlan', () => {
  it('指示文に入る分だけを数え、要約と本文はそれぞれの上限で切る', () => {
    const chars = materialChars({
      id: 'x', title: 't', summaryRaw: 'あ'.repeat(1000), content: 'い'.repeat(3000),
    });
    expect(chars).toBe(400 + 1500);
  });

  it('HTMLのタグは文字数に入れない', () => {
    const chars = materialChars({ id: 'x', title: null, summaryRaw: null, content: '<p>かきく</p>' });
    expect(chars).toBe(3);
  });

  it('材料が多い記事には長めの分量を指定する', () => {
    expect(writingPlan(1200)).toEqual({ lead: '2〜3文・80〜140字', body: '3〜6文・150〜300字' });
    expect(writingPlan(5000).body).toBe('3〜6文・150〜300字');
  });

  it('材料が中くらいなら本文を短めにする', () => {
    expect(writingPlan(600).body).toBe('2〜4文・100〜200字');
  });

  it('材料が少なければ前文も本文も短くする', () => {
    expect(writingPlan(0)).toEqual({ lead: '1〜2文・50〜120字', body: '1〜2文・50〜100字' });
    expect(writingPlan(599).body).toBe('1〜2文・50〜100字');
  });

  it('材料が少ないほど指定の分量も少なくなる', () => {
    const len = (s: string) => Number(s.match(/(\d+)字$/)?.[1] ?? 0);
    expect(len(writingPlan(0).body)).toBeLessThan(len(writingPlan(600).body));
    expect(len(writingPlan(600).body)).toBeLessThan(len(writingPlan(1200).body));
  });
});

describe('buildGeneratePrompt（正確に書くための決まりと、記事ごとの分量）', () => {
  const rep = (over: Partial<GenerateArticle> = {}) => ({
    rep: { id: 'a1', title: 'T', summaryRaw: 'S', content: null, ...over } as GenerateArticle,
    memberIds: ['a1'], clusterSize: 1, feedCount: 1, sourceCount: 1,
  });

  it('記事ごとに分量の指定を入れる', () => {
    const { user } = buildGeneratePrompt('# profile', [rep({ summaryRaw: 'あ'.repeat(50) })]);
    expect(user).toContain('分量の指定: リード 1〜2文・50〜120字 / 本文 1〜2文・50〜100字');
  });

  it('材料が多い記事には長めの分量を指定する', () => {
    const { user } = buildGeneratePrompt('# profile', [rep({ content: 'あ'.repeat(2000) })]);
    expect(user).toContain('分量の指定: リード 2〜3文・80〜140字 / 本文 3〜6文・150〜300字');
  });

  it('発言者をはっきり書けという指示は入っていない', () => {
    const { system } = buildGeneratePrompt('# profile', [rep()]);
    expect(system).not.toContain('誰の主張で');
  });

  it('肩書は出来事そのものに関わるときだけ書くよう指示している', () => {
    const { system } = buildGeneratePrompt('# profile', [rep()]);
    expect(system).toContain('報じている出来事の一部である場合のみ書く');
    expect(system).toContain('素材に書かれていても付けない');
    expect(system).toContain('氏名だけを書く');
  });

  it('「初めて」のような言い切りや、数字を細かくし直すことを禁じている', () => {
    const { system } = buildGeneratePrompt('# profile', [rep()]);
    expect(system).toContain('国内で初めて');
    expect(system).toContain('「45%」に直さない');
  });

  it('全記事に同じ分量を求める指示は入っていない', () => {
    const { system } = buildGeneratePrompt('# profile', [rep()]);
    expect(system).not.toContain('本文: 3〜6文・150〜300字');
  });
});

describe('generateBatch（ひとつも書けなかったときは成功にしない）', () => {
  const unknownIdResponse = {
    content: [
      { type: 'text', text: '[{"id":"zzz","headline":"架空町で秋祭り","lead":"三年ぶりの開催","body":"駅前がにぎわった","section":"その他"}]' },
    ],
  };

  it('全部知らない識別子でひとつも残らなければ失敗とみなしてやり直す', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls === 1) return unknownIdResponse;
      return {
        content: [
          { type: 'text', text: '[{"id":"x1","headline":"h","lead":"l","body":"b","section":"その他"}]' },
        ],
      };
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep });
    expect(calls).toBe(2);
    expect(out.get('x1')?.headline).toBe('h');
  });

  it('やり直しを使い切ってもひとつも残らなければ例外を投げる', async () => {
    const reps = pickRepresentatives([a('x1')]);
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      return unknownIdResponse;
    };
    await expect(
      generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep }),
    ).rejects.toThrow(/0件/);
    expect(calls).toBe(3);
  });
});

describe('buildGeneratePrompt（実在の配信元の名前を入れない）', () => {
  const { system } = buildGeneratePrompt('好みの説明', pickRepresentatives([a('x1')]));

  it('指示文に配信元の名前が入っていない', () => {
    for (const outlet of OTHER_OUTLETS) expect(system).not.toContain(outlet);
  });

  it('文体の目安は名前でなく性質で書いている', () => {
    expect(system).toContain('経済紙の記事のように');
  });
});

describe('parseGeneratedDetailed（番号で答えてもらい、識別子に戻す）', () => {
  const reps = pickRepresentatives([a('4201', { feed: 1 }), a('4202', { feed: 2 }), a('4203', { feed: 3 })]);
  const row = (id: unknown, h = 'h') => ({ id, headline: h, lead: 'l', section: 'その他' });
  const ids = reps.map((r) => r.rep.id);

  it('1から始まる一覧の番号を識別子に戻す', () => {
    const r = parseGeneratedDetailed(JSON.stringify([row(1, 'A'), row(2, 'B'), row(3, 'C')]), reps);
    expect(ids.map((id) => r.generated.get(id)?.headline)).toEqual(['A', 'B', 'C']);
    expect(r.missing).toEqual([]);
  });

  it('書かれなかった記事・一覧にない番号・二度書かれた記事をそれぞれ返す', () => {
    const r = parseGeneratedDetailed(JSON.stringify([row(1, 'A'), row(1, 'A2'), row(4999)]), reps);
    expect(r.generated.get(ids[0])?.headline).toBe('A');
    expect(r.duplicated).toEqual([ids[0]]);
    expect(r.unknown).toEqual(['4999']);
    expect(r.missing).toEqual([ids[1], ids[2]]);
  });
});

describe('generateBatch（書かれなかった記事だけをもう一度頼む）', () => {
  const reps = pickRepresentatives([a('4201', { feed: 1 }), a('4202', { feed: 2 }), a('4203', { feed: 3 })]);
  const ids = reps.map((r) => r.rep.id);
  const reply = (rows: unknown[]) => ({ content: [{ type: 'text', text: JSON.stringify(rows) }] });
  const row = (id: unknown, h: string) => ({ id, headline: h, lead: 'l', section: 'その他' });

  it('書かれなかった記事だけを番号を付け直して頼み、結果を足す', async () => {
    const users: string[] = [];
    const lines: string[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      users.push(String(body.messages[0].content));
      return users.length === 1 ? reply([row(1, 'A')]) : reply([row(1, 'B'), row(2, 'C')]);
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep, logFn: (l) => lines.push(l) });
    expect(users).toHaveLength(2);
    expect(users[1]).toContain('以下の2件を処理してください');
    expect(users[1]).not.toContain(`title-${ids[0]}`);
    expect(ids.map((id) => out.get(id)?.headline)).toEqual(['A', 'B', 'C']);
    expect(lines[0]).toContain('書かれなかった2件 → もう1回頼んで2件生成');
  });

  it('全部書けていれば頼み直さず、ログも出さない', async () => {
    let calls = 0;
    const lines: string[] = [];
    const createMessageFn = async () => { calls++; return reply([row(1, 'A'), row(2, 'B'), row(3, 'C')]); };
    await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep, logFn: (l) => lines.push(l) });
    expect(calls).toBe(1);
    expect(lines).toEqual([]);
  });

  it('頼み直しが失敗しても最初の結果は使い、失敗をログに残す', async () => {
    let calls = 0;
    const lines: string[] = [];
    const createMessageFn = async () => {
      calls++;
      if (calls >= 2) throw new TypeError('fetch failed');
      return reply([row(1, 'A')]);
    };
    const out = await generateBatch(reps, { profileText: 'p', createMessageFn, sleepFn: noSleep, logFn: (l) => lines.push(l) });
    expect(out.size).toBe(1);
    expect(calls).toBe(2);
    expect(lines[0]).toContain('やり直し失敗: fetch failed');
  });

  it('formatGenerateGaps は一覧にない番号と二度書かれた記事も書き出す', () => {
    const line = formatGenerateGaps({ total: 10, missing: 1, recovered: 0, unknown: ['11'], duplicated: ['4201'] });
    expect(line).toContain('（10件中）: 書かれなかった1件 → もう1回頼んで0件生成');
    expect(line).toContain('一覧に無い番号: 11');
    expect(line).toContain('2回書いた記事1件');
  });
});

describe('buildGeneratePrompt（金額をほかの通貨に直させない）', () => {
  it('元の通貨と桁のまま書き、円に直さないよう指示している', () => {
    const { system } = buildGeneratePrompt('p', pickRepresentatives([a('x1')]));
    expect(system).toContain('別の通貨に換算しない');
    expect(system).toContain('「$7.5B」は「75億ドル」');
    expect(system).toContain('見出しも同じ');
  });
});
