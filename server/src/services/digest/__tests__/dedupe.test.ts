import { describe, it, expect } from 'vitest';
import {
  buildDedupePrompt,
  buildPublishedDedupePrompt,
  parseDedupeGroups,
  parseDedupeGroupsDetailed,
  chooseExcluded,
  dedupeBatch,
  dedupeBatchDetailed,
  dedupeAgainstPublished,
  excludeAlreadyPublished,
  splitStoredSummary,
  formatDedupeLog,
  dedupeRound,
  dedupeUntilStable,
  MAX_DEDUPE_ROUNDS,
  formatRetryLog,
  verifyPublishedGroup,
  verifyIntraGroup,
  buildIntraVerifyPrompt,
  parseVerifyAnswer,
  buildPublishedVerifyPrompt,
  type DedupeItem,
  type DedupeOutcome,
} from '../dedupe.js';
import { pickRepresentatives, type GenerateArticle } from '../generate.js';
import { getDedupeModel, getGenerateModel, type AnthropicMessageBody } from '../anthropicClient.js';

const item = (
  id: string,
  headline = `見出し-${id}`,
  lead = `リード-${id}`,
  section = '総合',
): DedupeItem => ({ id, headline, lead, section });

const a = (
  id: string,
  { score = 3, cluster = null, feed = 1 }: { score?: number; cluster?: string | null; feed?: number } = {},
): GenerateArticle => ({
  id,
  feedId: feed,
  title: `title-${id}`,
  summaryRaw: '',
  content: '',
  clusterId: cluster,
  triageScore: score,
});

describe('重複を探す依頼文を組み立てる', () => {
  it('番号と見出しとリードは並べるが、内部の id は見せない', () => {
    const { system, user } = buildDedupePrompt([item('x1'), item('x2')]);
    expect(system).toMatch(/同一の事象/);
    expect(user).toMatch(/\[1\]/);
    expect(user).toMatch(/\[2\]/);
    expect(user).not.toMatch(/id: /);
    expect(user).toMatch(/見出し-x2/);
    expect(user).toMatch(/リード-x1/);
  });
});

describe('重複グループの答えを読み取る', () => {
  it('知らない id、1本だけの組、二重に入った記事を取りこぼさず処理する', () => {
    const items = [item('x1'), item('x2'), item('x3')];
    const text = `前置き [
      {"ids": ["x1", "x2", "zzz"], "subject": "見出し", "event": "同じ発表"},
      {"ids": ["x3"], "event": "単独"},
      {"ids": ["x2", "x3"], "subject": "見出し", "event": "同じ発表"}
    ] 後置き`;
    const groups = parseDedupeGroups(text, items);
    expect(groups).toEqual([['x1', 'x2']]);
  });

  it('重複が無いという答えなら空の配列になる', () => {
    expect(parseDedupeGroups('[]', [item('x1')])).toEqual([]);
  });
});

describe('重複の組から外す記事を選ぶ', () => {
  it('多くの媒体が報じた記事を優先し、次に点数の高い記事を残して、ほかを外す', () => {
    const reps = pickRepresentatives([
      a('x1', { score: 5, feed: 1 }),
      a('x2', { cluster: 'cl_1', score: 3, feed: 2 }),
      a('x2b', { cluster: 'cl_1', score: 3, feed: 3 }),
      a('x3', { score: 4, feed: 4 }),
      a('x4', { score: 3, feed: 5 }),
    ]);
    const excluded = chooseExcluded([['x1', 'x2'], ['x3', 'x4']], reps);
    expect(excluded.has('x1')).toBe(true);
    expect(excluded.has('x4')).toBe(true);
    expect(excluded.size).toBe(2);
  });
});

describe('1回分の記事の重複を調べる', () => {
  it('決められたモデルに問い合わせて、組を返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: '[{"ids": [1, 2], "subject": "見出し", "event": "同じ発表"}]' }] };
    };
    const groups = await dedupeBatch([item('x1'), item('x2'), item('x3')], { createMessageFn });
    expect(captured?.model).toBe(getDedupeModel());
    expect(groups).toEqual([['x1', 'x2']]);
  });

  it('記事が1本以下なら問い合わせずに空を返す', async () => {
    const createMessageFn = async () => {
      throw new Error('呼ばれてはいけない');
    };
    expect(await dedupeBatch([item('x1')], { createMessageFn })).toEqual([]);
  });

  it('読めない答えが返ったら問い直し、読めた答えを使う', async () => {
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls === 1) return { content: [{ type: 'text', text: '空応答' }] };
      return { content: [{ type: 'text', text: '[{"ids": [1, 2], "subject": "見出し", "event": "同じ発表"}]' }] };
    };
    const groups = await dedupeBatch([item('x1'), item('x2')], { createMessageFn });
    expect(calls).toBe(2);
    expect(groups).toEqual([['x1', 'x2']]);
  });
});

describe('重複を探す依頼文の判断のしかた', () => {
  const prompt = (): string =>
    buildDedupePrompt([
      { id: 'a1', headline: '見出し1', lead: 'リード1', section: '総合' },
      { id: 'a2', headline: '見出し2', lead: 'リード2', section: '経済' },
    ]).system;

  it('判断に迷ったら組にしない側を選ぶよう伝える', () => {
    expect(prompt()).toContain('迷った場合はグループにしない');
    expect(prompt()).not.toContain('迷った場合はグループにする');
  });

  it('これが最後の確認であることを伝える', () => {
    expect(prompt()).toContain('最後の砦');
  });

  it('外した記事がどこへ回るかと、違う出来事を組にしたときの不利益を伝える', () => {
    expect(prompt()).toContain('ほかにこんな記事がありました');
    expect(prompt()).toContain('本編で見落とす');
  });

  it('同じ発表を違う切り口で書いた記事も同じとみなすよう伝える', () => {
    expect(prompt()).toContain('別の角度');
  });

  it('出来事が違えば組にしないという決まりも入っている', () => {
    expect(prompt()).toContain('事象が別');
  });
});

describe('掲載済みの記事と重なる今日の記事を外す', () => {
  const published = new Set(['p1', 'p2']);

  it('掲載済みを含む組からは、今日の記事をすべて外す', () => {
    const out = excludeAlreadyPublished([['a', 'b', 'p1']], published);
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('掲載済みの記事そのものは外す対象にしない', () => {
    const out = excludeAlreadyPublished([['a', 'p1']], published);
    expect(out.has('p1')).toBe(false);
  });

  it('掲載済みを含まない組はそのままにする', () => {
    const out = excludeAlreadyPublished([['a', 'b']], published);
    expect(out.size).toBe(0);
  });

  it('いくつもの組を一つずつ判定する', () => {
    const out = excludeAlreadyPublished([['a', 'p1'], ['b', 'c'], ['d', 'p2']], published);
    expect([...out].sort()).toEqual(['a', 'd']);
  });

  it('掲載済みが無ければ何も外さない', () => {
    expect(excludeAlreadyPublished([['a', 'b']], new Set()).size).toBe(0);
  });
});

describe('保存した要約を見出しとリードに分ける', () => {
  it('見出しとリードを取り出す', () => {
    expect(splitStoredSummary('見出し｜リード｜本文')).toEqual({ headline: '見出し', lead: 'リード' });
  });

  it('本文に区切り文字が入っていても崩れない', () => {
    expect(splitStoredSummary('見出し｜リード｜本文にも｜が入る')).toEqual({
      headline: '見出し', lead: 'リード',
    });
  });

  it('リードが無いときや null や空でもエラーにならない', () => {
    expect(splitStoredSummary('見出しだけ')).toEqual({ headline: '見出しだけ', lead: '' });
    expect(splitStoredSummary(null)).toEqual({ headline: '', lead: '' });
    expect(splitStoredSummary('')).toEqual({ headline: '', lead: '' });
  });
});

const answer = (text: string) => async () => ({ content: [{ type: 'text', text }] });

describe('同じ日の記事どうしを比べる依頼文の決まり', () => {
  const sys = () => buildDedupePrompt([item('a'), item('b')]).system;

  it('同じ行事の一連の流れは、日付が違っても同じ出来事とみなす', () => {
    expect(sys()).toContain('一連の流れ');
  });

  it('日付が違うだけで別の出来事とする決まりは入っていない', () => {
    expect(sys()).not.toContain('別の日の出来事');
  });

  it('同じ日の記事を比べる依頼文には掲載済みの話を入れない', () => {
    const { system, user } = buildDedupePrompt([item('a'), item('b')]);
    expect(system).not.toContain('掲載済み');
    expect(user).not.toContain('掲載済み');
  });
});

describe('掲載済みの記事と比べる依頼文の決まり', () => {
  const build = () => buildPublishedDedupePrompt(
    [item('t1', '山田市長、新しい図書館の建設を表明')],
    [item('p1', '山田市長、図書館の運営を民間に任せる方針')],
  );

  it('新しい展開を含む記事は組にしない', () => {
    expect(build().system).toContain('新しい展開');
    expect(build().system).toContain('同じ出来事にしない');
  });

  it('判断に迷ったら組にしない側を選ぶ', () => {
    expect(build().system).toContain('迷った場合はグループにしない');
    expect(build().system).not.toContain('迷った場合はグループにする');
  });

  it('組にした記事は本編から外れることを伝える', () => {
    expect(build().system).toContain('本編から1本も残さず外します');
  });

  it('今日の記事を先に並べ、掲載済みの記事は印を付けて後ろに並べる', () => {
    const { user } = build();
    const boundary = user.indexOf('ここから下は前日までの号に掲載済み');
    expect(user.indexOf('建設を表明')).toBeLessThan(boundary);
    expect(user.indexOf('民間に任せる')).toBeGreaterThan(boundary);
    expect(user).toContain('【掲載済み】');
    expect(user).toContain('【今日の採用予定】1件');
  });
});

describe('重複の答えを細かく読み取る', () => {
  it('一覧に無い id を別に返す', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": ["a", "zzz"], "subject": "見出し", "event": "e"}, {"ids": ["b", "c"], "subject": "見出し", "event": "e"}]', [item('a'), item('b'), item('c')]);
    expect(r.groups).toEqual([['b', 'c']]);
    expect(r.unknownIds).toEqual(['zzz']);
  });

  it('すべて一覧にある id なら、知らない id は空になる', () => {
    expect(parseDedupeGroupsDetailed('[{"ids": ["a", "b"], "subject": "見出し", "event": "e"}]', [item('a'), item('b')]).unknownIds).toEqual([]);
  });
});

describe('答えをそのまま返す処理と、掲載済みとの照合', () => {
  it('組が無いときでも、答えの文をそのまま返す', async () => {
    const r = await dedupeBatchDetailed([item('a'), item('b')], { createMessageFn: answer('[]') });
    expect(r.groups).toEqual([]);
    expect(r.rawText).toBe('[]');
  });

  it('掲載済みとの照合は、そのための依頼文で問い合わせる', async () => {
    let system = '';
    const createMessageFn = async (body: AnthropicMessageBody) => {
      system = String(body.system);
      return { content: [{ type: 'text', text: '[{"ids": [1, 2], "subject": "見出し", "event": "同じ発表"}]' }] };
    };
    const r = await dedupeAgainstPublished([item('t1')], [item('p1')], { createMessageFn });
    expect(system).toContain('迷った場合はグループにしない');
    expect(r.groups).toEqual([['t1', 'p1']]);
  });

  it('今日の記事か掲載済みの記事が無ければ、問い合わせずに空を返す', async () => {
    let called = 0;
    const createMessageFn = async () => { called++; return { content: [{ type: 'text', text: '[]' }] }; };
    await dedupeAgainstPublished([], [item('p1')], { createMessageFn });
    await dedupeAgainstPublished([item('t1')], [], { createMessageFn });
    expect(called).toBe(0);
  });
});

describe('重複判定の記録の文', () => {
  const headlineOf = (id: string) => `見出し-${id}`;

  it('組が無いときは答えの文をそのまま記録する', () => {
    const lines = formatDedupeLog('号内', { groups: [], unknownIds: [], rawText: '[]' }, { todayCount: 21, headlineOf });
    expect(lines[0]).toContain('採用21件を照合');
    expect(lines[0]).toContain('同一事象なし');
    expect(lines[0]).toContain('AIの答え: []');
  });

  it('見つけた組は見出しを並べて記録する', () => {
    const lines = formatDedupeLog('号内', { groups: [['a', 'b']], unknownIds: [], rawText: '' }, { todayCount: 2, headlineOf });
    expect(lines[0]).toContain('同一事象1グループ');
    expect(lines[1]).toContain('見出し-a');
    expect(lines[1]).toContain('見出し-b');
  });

  it('一覧に無い id を捨てたら、その id を記録する', () => {
    const lines = formatDedupeLog('号内', { groups: [], unknownIds: ['zzz'], rawText: '[{"ids":["zzz"]}]' }, { todayCount: 2, headlineOf });
    expect(lines.some((l) => l.includes('一覧に無いIDを捨てた: zzz'))).toBe(true);
  });

  it('掲載済みとの照合では両方の件数を書き、掲載済みの記事に印を付ける', () => {
    const lines = formatDedupeLog('既報', { groups: [['t1', 'p1']], unknownIds: [], rawText: '' }, {
      todayCount: 20, publishedCount: 28, headlineOf, publishedIds: new Set(['p1']),
    });
    expect(lines[0]).toContain('採用20件 × 掲載済み28件');
    expect(lines[1]).toContain('見出し-p1」【既報】');
    expect(lines[1]).not.toContain('見出し-t1」【既報】');
  });
});

describe('同じ日の判定と掲載済みとの判定を分けて行う', () => {
  const reps = pickRepresentatives([
    a('t1', { score: 5, feed: 1 }),
    a('t2', { score: 4, feed: 2 }),
    a('t3', { score: 3, feed: 3 }),
  ]);
  const today = [item('t1'), item('t2'), item('t3')];
  const published = [item('p1'), item('p2')];
  const headlineOf = (id: string) => `見出し-${id}`;
  const outcome = (groups: string[][]): DedupeOutcome => ({ groups, unknownIds: [], rawText: JSON.stringify(groups) });
  const quiet = { log: () => {}, logError: () => {} };

  it('同じ日の判定には今日の記事だけを渡す', async () => {
    let intraSeen: string[] = [];
    await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      ...quiet,
      intraFn: async (items) => { intraSeen = items.map((i) => i.id); return outcome([]); },
      crossFn: async () => outcome([]),
    });
    expect(intraSeen).toEqual(['t1', 't2', 't3']);
  });

  it('掲載済みとの判定には、今日の記事と掲載済みを分けて渡す', async () => {
    let seen: { t: string[]; p: string[] } = { t: [], p: [] };
    await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      ...quiet,
      intraFn: async () => outcome([]),
      crossFn: async (t, p) => { seen = { t: t.map((i) => i.id), p: p.map((i) => i.id) }; return outcome([]); },
    });
    expect(seen).toEqual({ t: ['t1', 't2', 't3'], p: ['p1', 'p2'] });
  });

  it('同じ日の組からは1本だけ残し、掲載済みと重なる今日の記事はすべて外す', async () => {
    const { removed } = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      ...quiet,
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => ({ same: true, reason: '同じ発表' }),
      crossFn: async () => outcome([['t3', 'p1']]),
      verifyFn: async () => ({ same: true, reason: '同じ発表' }),
    });
    expect([...removed].sort()).toEqual(['t2', 't3']);
  });

  it('掲載済みとの判定で出た今日の記事どうしの組は使わない', async () => {
    const { removed } = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      ...quiet,
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 't2']]),
    });
    expect(removed.size).toBe(0);
  });

  it('掲載済みとの判定が失敗しても、同じ日の判定の結果は使う', async () => {
    const errors: string[] = [];
    const r = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      log: () => {},
      logError: (l) => errors.push(l),
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => ({ same: true, reason: '同じ発表' }),
      crossFn: async () => { throw new Error('timeout'); },
    });
    expect([...r.removed]).toEqual(['t2']);
    expect(r.crossAlive).toBe(false);
    expect(errors.join('\n')).toContain('既報との照合は実行できませんでした');
  });

  it('掲載済みとの判定を止めた後は、その判定を呼ばない', async () => {
    let crossCalls = 0;
    await dedupeRound(today, published, reps, { crossAlive: false, headlineOf }, {
      ...quiet,
      intraFn: async () => outcome([]),
      crossFn: async () => { crossCalls++; return outcome([]); },
    });
    expect(crossCalls).toBe(0);
  });

  it('同じ日の判定が失敗したらエラーを投げる', async () => {
    await expect(dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      ...quiet,
      intraFn: async () => { throw new Error('boom'); },
      crossFn: async () => outcome([]),
    })).rejects.toThrow('boom');
  });

  it('組が無いときも答えの文が記録に出る', async () => {
    const lines: string[] = [];
    await dedupeRound(today, [], reps, { crossAlive: true, headlineOf }, {
      log: (l) => lines.push(l),
      logError: () => {},
      intraFn: async () => ({ groups: [], unknownIds: [], rawText: '[]' }),
    });
    expect(lines.join('\n')).toContain('AIの答え: []');
  });
});

describe('掲載済みとの判定の組を3つに分けて記録する', () => {
  const headlineOf = (id: string) => `見出し-${id}`;
  const publishedIds = new Set(['p1', 'p2']);
  const log = (groups: string[][]) => formatDedupeLog('既報', { groups, unknownIds: [], rawText: JSON.stringify(groups) }, {
    todayCount: 15, publishedCount: 30, headlineOf, publishedIds,
  });

  it('掲載済みどうしの組は、掲載済みと重なる組として数えない', () => {
    const lines = log([['p1', 'p2']]);
    expect(lines[0]).toContain('既報と同じ事象なし');
  });

  it('掲載済みどうしの組は、過去の号で重なっていた話題として記録する', () => {
    const lines = log([['p1', 'p2']]);
    expect(lines.some((l) => l.includes('過去の号で重複していた話題') && l.includes('見出し-p1') && l.includes('見出し-p2'))).toBe(true);
  });

  it('今日の記事と掲載済みの両方を含む組だけを数える', () => {
    const lines = log([['t1', 'p1'], ['p1', 'p2']]);
    expect(lines[0]).toContain('既報と同じ事象1件');
  });

  it('今日の記事どうしの組は使わないと記録する', () => {
    const lines = log([['t1', 't2']]);
    expect(lines[0]).toContain('既報と同じ事象なし');
    expect(lines.some((l) => l.includes('今日の記事どうし（号内の判定に任せるため使わない）'))).toBe(true);
  });
});

describe('問い合わせなかったときはその旨を記録する', () => {
  const headlineOf = (id: string) => id;
  const empty = { groups: [], unknownIds: [], rawText: '' };

  it('同じ日の記事が1件以下なら照合しなかったと書く', () => {
    const lines = formatDedupeLog('号内', empty, { todayCount: 1, headlineOf });
    expect(lines[0]).toContain('照合不要（採用1件のため AI は呼んでいません）');
    expect(lines[0]).not.toContain('AIの答え');
  });

  it('比べる相手が無ければ照合しなかったと書く', () => {
    const lines = formatDedupeLog('既報', empty, { todayCount: 3, publishedCount: 0, headlineOf });
    expect(lines[0]).toContain('照合不要');
  });

  it('同じ日の記事が2件以上なら答えの文を記録する', () => {
    const lines = formatDedupeLog('号内', { ...empty, rawText: '[]' }, { todayCount: 2, headlineOf });
    expect(lines[0]).toContain('AIの答え: []');
  });
});

describe('番号で答えてもらい、それを id に戻す', () => {
  const items = [item('21'), item('22'), item('23'), item('24')];

  it('1から始まる番号を id に戻す', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 3], "subject": "見出し", "event": "同じ発表"}]', items);
    expect(r.groups).toEqual([['21', '23']]);
  });

  it('文字列の番号も受け付ける', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": ["2", "4"], "subject": "見出し", "event": "同じ発表"}]', items);
    expect(r.groups).toEqual([['22', '24']]);
  });

  it('id そのものが返っても受け付ける', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": ["21", 2], "subject": "見出し", "event": "同じ発表"}]', items);
    expect(r.groups).toEqual([['21', '22']]);
  });

  it('範囲の外の番号は一覧に無いものとして返す', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 9], "subject": "見出し", "event": "同じ発表"}]', items);
    expect(r.groups).toEqual([]);
    expect(r.unknownIds).toEqual(['9']);
  });
});

describe('出来事を書いていない組は使わない', () => {
  const items = [item('a'), item('b'), item('c'), item('d')];

  it('出来事の無い組は使わず、別に記録する', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 2]}, {"ids": [3, 4], "subject": "見出し", "event": "A社による株式会社サンプルの買収"}]', items);
    expect(r.groups).toEqual([['c', 'd']]);
    expect(r.events).toEqual(['A社による株式会社サンプルの買収']);
    expect(r.droppedNoEvent).toEqual([['a', 'b']]);
  });

  it('出来事が空白だけでも使わない', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 2], "event": "  "}]', items);
    expect(r.groups).toEqual([]);
    expect(r.droppedNoEvent).toEqual([['a', 'b']]);
  });

  it('使わなかった組の記事は、ほかの組に入れられる', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 2]}, {"ids": [1, 3], "subject": "見出し", "event": "同じ発表"}]', items);
    expect(r.groups).toEqual([['a', 'c']]);
  });
});

describe('依頼文で具体的な出来事を書かせる', () => {
  it('同じ日の判定では具体的な出来事を書かせ、話題だけなら組にしない', () => {
    const { system } = buildDedupePrompt([item('a'), item('b')]);
    expect(system).toContain('"event"');
    expect(system).toContain('テーマしか書けないなら、それは同じ出来事ではない');
    expect(system).toContain('一覧の [ ] の中の数字');
  });

  it('同じ日の判定では、間違えやすい例を別の出来事として示す', () => {
    const { system } = buildDedupePrompt([item('a'), item('b')]);
    expect(system).toContain('どちらも半導体の話でも別の出来事');
  });

  it('掲載済みとの判定でも出来事を書かせ、番号で答えさせる', () => {
    const { system, user } = buildPublishedDedupePrompt([item('t1')], [item('p1')]);
    expect(system).toContain('"event"');
    expect(system).toContain('同じ出来事ではないのでグループにしない');
    expect(user).not.toMatch(/id: /);
    expect(user).toMatch(/\[2\]（セクション: 総合） 【掲載済み】/);
  });

  it('掲載済みの記事の番号は今日の記事の続きから振る', async () => {
    const createMessageFn = async () => ({ content: [{ type: 'text', text: '[{"ids": [1, 2], "subject": "見出し", "event": "同じ発表"}]' }] });
    const r = await dedupeAgainstPublished([item('t1')], [item('p1')], { createMessageFn });
    expect(r.groups).toEqual([['t1', 'p1']]);
  });
});

describe('記録に出来事を添える', () => {
  const headlineOf = (id: string) => `見出し-${id}`;

  it('組にした記録に、答えで示された出来事を添える', () => {
    const lines = formatDedupeLog('号内', {
      groups: [['a', 'b']], events: ['A社による株式会社サンプルの買収'], unknownIds: [], rawText: '',
    }, { todayCount: 2, headlineOf });
    expect(lines[1]).toContain('— 出来事: A社による株式会社サンプルの買収');
  });

  it('出来事を書かなかった組は使わないと記録する', () => {
    const lines = formatDedupeLog('号内', {
      groups: [], unknownIds: [], rawText: '[{"ids":[1,2]}]', droppedNoEvent: [['a', 'b']],
    }, { todayCount: 2, headlineOf });
    expect(lines.some((l) => l.includes('出来事を名指ししなかったので使わない') && l.includes('見出し-a'))).toBe(true);
  });
});

describe('組にする根拠を処理の中で確かめる', () => {
  const hakobune = item('r', '架空の物流ソフト会社ハコブネ、20億円調達', '配送の計画を自動で組む仕組みを作るハコブネが資金を集めた。');
  const minato = item('f', '架空の運送会社ミナト急便、電動トラック2000台を発注', 'ミナト急便が配送車の電動化を進める。');
  const g1 = item('g1', '架空の電機メーカーA社、新しい電池「Volta Cell 9」', 'A社が新しい電池を発表した。');
  const g2 = item('g2', 'A社が次世代電池「ＶＯＬＴＡ ＣＥＬＬ ９」を発表', '充電が10分で終わる。');
  const companyB = item('o', '架空のソフト会社B社、不正ログインの攻撃を防いだと発表', 'B社が不正な利用を止めた。');
  const sample = item('c', '警備ロボットの株式会社サンプル、10億円調達', 'サンプルが資金を集めた。');

  it('共通の名前がどれか1本に出てこなければ使わない', () => {
    const r = parseDedupeGroupsDetailed(
      '[{"ids": [1, 2], "subject": "ハコブネ", "event": "ハコブネによる資金調達"}]', [hakobune, minato],
    );
    expect(r.groups).toEqual([]);
    expect(r.rejected?.[0].reason).toContain('に出てこない');
  });

  it('本当に同じ出来事なら通り、全角と半角や大文字と小文字の違いは気にしない', () => {
    const r = parseDedupeGroupsDetailed(
      '[{"ids": [1, 2], "subject": "volta cell 9", "event": "A社によるVolta Cell 9の発表"}]', [g1, g2],
    );
    expect(r.groups).toEqual([['g1', 'g2']]);
    expect(r.rejected).toEqual([]);
  });

  it('出来事の欄が話題をまとめる言い方なら使わない', () => {
    for (const ev of ['A社とB社がそれぞれ新製品を発表', '電池関連の新製品', '架空の島国の家電産業の動向']) {
      const r = parseDedupeGroupsDetailed(`[{"ids": [1, 2], "subject": "Volta Cell 9", "event": "${ev}"}]`, [g1, g2]);
      expect(r.groups).toEqual([]);
      expect(r.rejected?.[0].reason).toContain('テーマの言い回し');
    }
  });

  it('一般的な言葉は、両方に出てきても根拠にしない', () => {
    const a1 = item('a1', '会話AIエージェントの部品、5億円調達', 'AIエージェントの応答を速くする。');
    const a2 = item('a2', 'AIエージェントが買い物を代わりに行う', 'AIエージェントどうしで取引する仕組みづくりが進む。');
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 2], "subject": "AIエージェント", "event": "仕組みづくり"}]', [a1, a2]);
    expect(r.groups).toEqual([]);
    expect(r.rejected?.[0].reason).toContain('一般的な言葉');
  });

  it('共通の名前が無ければ使わない', () => {
    const r = parseDedupeGroupsDetailed('[{"ids": [1, 2], "event": "A社によるVolta Cell 9の発表"}]', [g1, g2]);
    expect(r.groups).toEqual([]);
    expect(r.rejected?.[0].reason).toContain('subject');
  });

  it('掲載済みとの判定でも同じ確かめ方をする', async () => {
    const createMessageFn = answer('[{"ids": [1, 2], "subject": "B社", "event": "B社のセキュリティ対策"}]');
    const r = await dedupeAgainstPublished([companyB], [sample], { createMessageFn });
    expect(r.groups).toEqual([]);
    expect(r.rejected?.[0].ids).toEqual(['o', 'c']);
  });

  it('使わなかった組は、理由と出来事を添えて記録する', () => {
    const r = parseDedupeGroupsDetailed(
      '[{"ids": [1, 2], "subject": "ハコブネ", "event": "ハコブネによる資金調達"}]', [hakobune, minato],
    );
    const lines = formatDedupeLog('号内', { ...r, rawText: '' }, { todayCount: 2, headlineOf: (id) => (id === 'r' ? 'ハコブネ' : 'ミナト急便') });
    const line = lines.find((l) => l.includes('根拠が足りないので使わない'));
    expect(line).toContain('「ハコブネ」 ／ 「ミナト急便」');
    expect(line).toContain('に出てこない');
    expect(line).toContain('出来事: ハコブネによる資金調達');
  });

  it('どちらの依頼文も共通の名前を書かせ、2つの出来事をまとめることを禁じる', () => {
    for (const { system } of [buildDedupePrompt([g1, g2]), buildPublishedDedupePrompt([companyB], [sample])]) {
      expect(system).toContain('"subject"');
      expect(system).toContain('1つのグループに書ける出来事は1つだけ');
      expect(system).toContain('迷った場合はグループにしない');
    }
  });
});

describe('掲載済みと重なる組は外す前に確かめ直す', () => {
  const reps = pickRepresentatives([a('t1', { score: 5, feed: 1 }), a('t2', { score: 4, feed: 2 })]);
  const today = [item('t1', 'サンプル市の来館者数、数え方を見直しへ'), item('t2')];
  const published = [item('p1', '9月のサンプル市図書館の来館者数、前月並み')];
  const headlineOf = (id: string) => [...today, ...published].find((i) => i.id === id)?.headline ?? id;
  const outcome = (groups: string[][]): DedupeOutcome => ({ groups, unknownIds: [], rawText: '' });

  it('確かめ直して別の出来事なら外さない', async () => {
    const lines: string[] = [];
    const { removed } = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      log: (l) => lines.push(l), logError: () => {},
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 'p1']]),
      verifyFn: async () => ({ same: false, reason: '前日は9月の数、今日は数え方の見直しで別' }),
    });
    expect(removed.size).toBe(0);
    expect(lines.join('\n')).toContain('確認で別の出来事と判定（本編に残す）: 「サンプル市の来館者数、数え方を見直しへ」');
  });

  it('確かめ直して同じ出来事なら外す', async () => {
    const { removed } = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      log: () => {}, logError: () => {},
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 'p1']]),
      verifyFn: async () => ({ same: true, reason: '同じ発表' }),
    });
    expect([...removed]).toEqual(['t1']);
  });

  it('確かめ直しが失敗したら外さない', async () => {
    const errors: string[] = [];
    const { removed } = await dedupeRound(today, published, reps, { crossAlive: true, headlineOf }, {
      log: () => {}, logError: (l) => errors.push(l),
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 'p1']]),
      verifyFn: async () => { throw new Error('timeout'); },
    });
    expect(removed.size).toBe(0);
    expect(errors.join('\n')).toContain('確認できなかったので本編に残す');
  });

  it('今日の記事と掲載済みを分けて渡し、どちらか一方だけの組は確かめない', async () => {
    const calls: Array<{ t: string[]; p: string[] }> = [];
    const published2 = [...published, item('p2')];
    await dedupeRound(today, published2, reps, { crossAlive: true, headlineOf }, {
      log: () => {}, logError: () => {},
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 'p1'], ['t1', 't2'], ['p1', 'p2']]),
      verifyFn: async (t, p) => { calls.push({ t: t.map((x) => x.id), p: p.map((x) => x.id) }); return { same: false, reason: '' }; },
    });
    expect(calls).toEqual([{ t: ['t1'], p: ['p1'] }]);
  });
});

describe('確かめ直しの答えを読み取る', () => {
  it('same が真のときだけ同じとみなし、文字列や欠けた値は別とみなす', () => {
    expect(parseVerifyAnswer('{"same": true, "reason": "同じ発表"}')).toEqual({ same: true, reason: '同じ発表' });
    expect(parseVerifyAnswer('{"same": "true"}').same).toBe(false);
    expect(parseVerifyAnswer('{"reason": "不明"}').same).toBe(false);
  });

  it('JSON が無ければエラーを投げる', () => {
    expect(() => parseVerifyAnswer('答えられません')).toThrow();
  });

  it('上位のモデルで問い合わせ、読めない答えは1回だけ問い直す', async () => {
    const models: string[] = [];
    let calls = 0;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      models.push(body.model);
      calls++;
      return { content: [{ type: 'text', text: calls === 1 ? '空' : '{"same": false, "reason": "別"}' }] };
    };
    const v = await verifyPublishedGroup([item('t1')], [item('p1')], { createMessageFn });
    expect(v).toEqual({ same: false, reason: '別' });
    expect(models.every((m) => m === getGenerateModel())).toBe(true);
    expect(calls).toBe(2);
  });

  it('依頼文は迷ったら別とし、今日の記事と掲載済みを分けて見せる', () => {
    const { system, user } = buildPublishedVerifyPrompt([item('t1', '今日の見出し')], [item('p1', '前日の見出し')]);
    expect(system).toContain('迷ったら別の出来事とする');
    expect(system).toContain('同じ指標・同じ制度');
    expect(system).toContain('観光客数');
    expect(user.indexOf('今日の見出し')).toBeLessThan(user.indexOf('【前日までに掲載した記事】'));
    expect(user.indexOf('前日の見出し')).toBeGreaterThan(user.indexOf('【前日までに掲載した記事】'));
  });
});

describe('重なりが無くなるまで判定をくり返す', () => {
  it('外す記事が無くなるまでくり返し、入れ替えた記事を毎回調べる', async () => {
    const seen: string[][] = [];
    let pool = ['a', 'b1', 'b2', 'b3', 'b4', 'b5'];
    const result = await dedupeUntilStable(
      pool.slice(0, 2),
      async (sel) => { seen.push(sel); const dup = sel.find((x) => x.startsWith('b') && x !== 'b5'); return new Set(dup ? [dup] : []); },
      (removed) => { pool = pool.filter((x) => !removed.has(x)); return pool.slice(0, 2); },
    );
    expect(result.selected).toEqual(['a', 'b5']);
    expect(result.capped).toBe(false);
    expect(seen.at(-1)).toEqual(['a', 'b5']);
    expect(result.rounds).toBe(5);
  });

  it('回数の上限で止まったら、上限で止まったことを返す', async () => {
    let n = 0;
    const result = await dedupeUntilStable(0, async () => new Set([`x${n++}`]), () => n, { maxRounds: 2 });
    expect(result.capped).toBe(true);
    expect(result.rounds).toBe(2);
  });

  it('回数の上限は3より大きい', () => {
    expect(MAX_DEDUPE_ROUNDS).toBeGreaterThan(3);
  });
});

describe('確かめ直しの答えを次の回でも使う', () => {
  const reps = pickRepresentatives([a('t1', { score: 5, feed: 1 })]);
  const today = [item('t1')];
  const published = [item('p1')];
  const outcome = (groups: string[][]): DedupeOutcome => ({ groups, unknownIds: [], rawText: '' });

  it('同じ組は2回目から問い合わせず、前の答えを使う', async () => {
    const cache = new Map();
    let calls = 0;
    const deps = {
      log: () => {}, logError: () => {},
      intraFn: async () => outcome([]),
      crossFn: async () => outcome([['t1', 'p1']]),
      verifyFn: async () => { calls++; return { same: calls > 1, reason: '' }; },
    };
    const ctx = { crossAlive: true, headlineOf: (id: string) => id, verifyCache: cache };
    const r1 = await dedupeRound(today, published, reps, ctx, deps);
    const r2 = await dedupeRound(today, published, reps, ctx, deps);
    expect(calls).toBe(1);
    expect(r1.removed.size).toBe(0);
    expect(r2.removed.size).toBe(0);
  });
});

describe('問い直したことを記録する', () => {
  it('同じ日の判定で問い直したら、答えの冒頭を添えて1行記録する', async () => {
    const lines: string[] = [];
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      return { content: [{ type: 'text', text: calls === 1 ? '重なっている記事は次の二つです。まず…' : '[]' }] };
    };
    const r = await dedupeBatchDetailed([item('a'), item('b')], { createMessageFn, logFn: (l) => lines.push(l) });
    expect(r.groups).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('重複統合（号内）：読めない答えのためやり直し（1回目）');
    expect(lines[0]).toContain('答えの冒頭: 重なっている記事は次の二つです。');
  });

  it('掲載済みとの照合でも、どの判定で問い直したかが分かる', async () => {
    const lines: string[] = [];
    let calls = 0;
    const createMessageFn = async () => { calls++; return { content: [{ type: 'text', text: calls === 1 ? '' : '[]' }] }; };
    await dedupeAgainstPublished([item('t1')], [item('p1')], { createMessageFn, logFn: (l) => lines.push(l) });
    expect(lines[0]).toContain('既報との照合：読めない答えのためやり直し（1回目）');
    expect(lines[0]).toContain('答えの冒頭: （空）');
  });

  it('掲載済みの確かめ直しでも、問い直したら記録する', async () => {
    const lines: string[] = [];
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      return { content: [{ type: 'text', text: calls === 1 ? 'どちらとも言えません' : '{"same": false, "reason": "別"}' }] };
    };
    await verifyPublishedGroup([item('t1')], [item('p1')], { createMessageFn, logFn: (l) => lines.push(l) });
    expect(lines[0]).toContain('既報の確かめ直し：読めない答えのためやり直し（1回目）');
  });

  it('1回目で読めたら何も記録しない', async () => {
    const lines: string[] = [];
    await dedupeBatchDetailed([item('a'), item('b')], { createMessageFn: answer('[]'), logFn: (l) => lines.push(l) });
    expect(lines).toEqual([]);
  });

  it('長い答えは切り詰め、改行はつなげる', () => {
    const line = formatRetryLog('重複統合（号内）', 2, `最初の行\n${'あ'.repeat(200)}`, new Error('JSON配列が見つかりません'));
    expect(line).toContain('（2回目）— JSON配列が見つかりません');
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(220);
  });
});

describe('同じ日の組も確かめ直す', () => {
  const reps = pickRepresentatives([a('t1', { score: 5, feed: 1 }), a('t2', { score: 4, feed: 2 })]);
  const today = [item('t1', 'B社、試作のロボットが迷路の競技で優勝'), item('t2', 'B社、家庭用ロボットを全国で発売')];
  const headlineOf = (id: string) => today.find((i) => i.id === id)?.headline ?? id;
  const outcome = (groups: string[][]): DedupeOutcome => ({ groups, unknownIds: [], rawText: '' });
  const base = { log: () => {}, logError: () => {}, crossFn: async () => outcome([]) };

  it('確かめ直して別の出来事なら、どちらも外さない', async () => {
    const lines: string[] = [];
    const { removed } = await dedupeRound(today, [], reps, { crossAlive: true, headlineOf }, {
      ...base, log: (l) => lines.push(l),
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => ({ same: false, reason: '競技の結果と発売は別の発表' }),
    });
    expect(removed.size).toBe(0);
    expect(lines.join('\n')).toContain('確認で別の出来事と判定（号内・両方本編に残す）: 「B社、試作のロボットが迷路の競技で優勝」');
  });

  it('確かめ直して同じ出来事なら、1本残して外す', async () => {
    const { removed } = await dedupeRound(today, [], reps, { crossAlive: true, headlineOf }, {
      ...base,
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => ({ same: true, reason: '同じ発表' }),
    });
    expect([...removed]).toEqual(['t2']);
  });

  it('確かめ直しが失敗したら組にしない', async () => {
    const errors: string[] = [];
    const { removed } = await dedupeRound(today, [], reps, { crossAlive: true, headlineOf }, {
      ...base, logError: (l) => errors.push(l),
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => { throw new Error('timeout'); },
    });
    expect(removed.size).toBe(0);
    expect(errors.join('\n')).toContain('確認できなかったので束ねない（号内）');
  });

  it('組の記事をすべて見出しとリード付きで渡す', async () => {
    let seen: string[] = [];
    await dedupeRound(today, [], reps, { crossAlive: true, headlineOf }, {
      ...base,
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async (it) => { seen = it.map((x) => x.headline ?? ''); return { same: false, reason: '' }; },
    });
    expect(seen).toEqual(['B社、試作のロボットが迷路の競技で優勝', 'B社、家庭用ロボットを全国で発売']);
  });

  it('同じ組は次の回でも問い直さない', async () => {
    const cache = new Map();
    let calls = 0;
    const deps = {
      ...base,
      intraFn: async () => outcome([['t1', 't2']]),
      intraVerifyFn: async () => { calls++; return { same: false, reason: '' }; },
    };
    await dedupeRound(today, [], reps, { crossAlive: true, headlineOf, verifyCache: cache }, deps);
    await dedupeRound(today, [], reps, { crossAlive: true, headlineOf, verifyCache: cache }, deps);
    expect(calls).toBe(1);
  });
});

describe('同じ日の組を確かめ直す依頼文と問い合わせ', () => {
  it('同じ会社の別の発表や同じ連載の別の記事は別とし、迷ったら別とする', () => {
    const { system, user } = buildIntraVerifyPrompt([item('t1', 'A見出し'), item('t2', 'B見出し')]);
    expect(system).toContain('同じ企業・同じ人物による、別の発表');
    expect(system).toContain('新型の掃除機');
    expect(system).toContain('同じ連載');
    expect(system).toContain('迷ったら別の出来事とする');
    expect(user).toContain('【記事1】');
    expect(user).toContain('B見出し');
  });

  it('上位のモデルで問い合わせ、答えを読み取る', async () => {
    let model = '';
    const createMessageFn = async (body: AnthropicMessageBody) => {
      model = body.model;
      return { content: [{ type: 'text', text: '{"same": false, "reason": "別"}' }] };
    };
    expect(await verifyIntraGroup([item('t1'), item('t2')], { createMessageFn })).toEqual({ same: false, reason: '別' });
    expect(model).toBe(getGenerateModel());
  });
});

describe('確かめ直しの答えは組ごとに覚える', () => {
  it('同じ回の別の組には、それぞれ別に問い合わせる', async () => {
    const reps = pickRepresentatives([
      a('t1', { score: 5, feed: 1 }), a('t2', { score: 4, feed: 2 }), a('t3', { score: 5, feed: 3 }), a('t4', { score: 4, feed: 4 }),
    ]);
    const today = [item('t1'), item('t2'), item('t3'), item('t4')];
    const { removed } = await dedupeRound(today, [], reps, { crossAlive: true, headlineOf: (id) => id, verifyCache: new Map() }, {
      log: () => {}, logError: () => {},
      crossFn: async () => ({ groups: [], unknownIds: [], rawText: '' }),
      intraFn: async () => ({ groups: [['t1', 't2'], ['t3', 't4']], unknownIds: [], rawText: '' }),
      intraVerifyFn: async (it) => ({ same: it[0].id === 't1', reason: '' }),
    });
    expect([...removed]).toEqual(['t2']);
  });
});
