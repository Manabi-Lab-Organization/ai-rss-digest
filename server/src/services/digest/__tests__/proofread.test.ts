import { describe, it, expect } from 'vitest';
import {
  INSPECT_SYSTEM_PROMPT, REVISE_SYSTEM_PROMPT,
  buildInspectUserMessage, buildReviseUserMessage,
  parseFindings, parseRevisions, runWithBudget, proofreadArticles, readJsonArray,
  findUnsourcedYen, mergeCodeFindings,
  type ProofreadItem,
} from '../proofread.js';
import type { AnthropicMessageBody, AnthropicMessageResponse } from '../anthropicClient.js';

function textResponse(text: string): AnthropicMessageResponse {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } };
}

const item = (over: Partial<ProofreadItem> = {}): ProofreadItem => ({
  id: 'a1',
  title: 'Example Electric unveils a new battery',
  summaryRaw: 'Example Electric says its new battery charges twice as fast.',
  content: 'SAMPLE CITY: The fictional maker showed the battery at its spring event.',
  headline: '架空の電機メーカー、新しい電池を発表',
  lead: '架空の電機メーカーA社の山田社長は、充電が2倍速い電池を発表した。',
  body: '春の発表会で披露した。',
  ...over,
});

describe('検査用の指示文', () => {
  it('モデル自身の知識で正しいかどうかを決めさせない', () => {
    expect(INSPECT_SYSTEM_PROMPT).toContain('あなた自身の知識で正誤を判断してはならない');
    expect(INSPECT_SYSTEM_PROMPT).toContain('知識に基づく指摘は**してはならない**');
  });

  it('訳したり言い換えたりした内容は、元の資料にあるものとして扱う', () => {
    expect(INSPECT_SYSTEM_PROMPT).toContain('翻訳・要約・言い換えは素材にあるものとみなす');
    expect(INSPECT_SYSTEM_PROMPT).toContain('文字列の一致で見てはならない');
    expect(INSPECT_SYSTEM_PROMPT).toContain('Mar 3, 2031');
  });

  it('書き方や長さについては何も言わせない', () => {
    expect(INSPECT_SYSTEM_PROMPT).toContain('文体・長さ・言い回し・構成には**一切口を出さない**');
  });

  it('確信が持てないときは指摘しないよう伝える', () => {
    expect(INSPECT_SYSTEM_PROMPT).toContain('迷ったら指摘しない');
  });
});

describe('修正用の指示文', () => {
  it('指摘された所のほかは変えないよう伝える', () => {
    expect(REVISE_SYSTEM_PROMPT).toContain('一字も変えない');
    expect(REVISE_SYSTEM_PROMPT).toContain('文体を整えたり、言い回しを良くしたりしない');
  });

  it('削った分を新しい内容で補わないよう伝える', () => {
    expect(REVISE_SYSTEM_PROMPT).toContain('短くなった分を別の内容で埋めない');
    expect(REVISE_SYSTEM_PROMPT).toContain('新たに足すことは、いかなる理由でも禁止');
  });
});

describe('モデルに渡す文の組み立て', () => {
  it('元の資料と原稿を記事のIDと一緒に並べる', () => {
    const msg = buildInspectUserMessage([item()]);
    expect(msg).toContain('[id: a1]');
    expect(msg).toContain('--- 素材（元記事） ---');
    expect(msg).toContain('Example Electric');
    expect(msg).toContain('--- 原稿 ---');
    expect(msg).toContain('山田社長');
  });

  it('修正を頼むときは指摘の内容も付ける', () => {
    const msg = buildReviseUserMessage([{ ...item(), issues: ['「山田社長」は素材に無い'] }]);
    expect(msg).toContain('--- 校閲の指摘 ---');
    expect(msg).toContain('1. 「山田社長」は素材に無い');
  });
});

describe('モデルの返答の読み取り', () => {
  it('記事ごとの指摘を取り出せる', () => {
    const f = parseFindings('[{"id":"a1","issues":["人名が素材に無い"]}]');
    expect(f).toEqual([{ id: 'a1', issues: ['人名が素材に無い'] }]);
  });

  it('指摘が一つも無い記事は結果に含めない', () => {
    expect(parseFindings('[{"id":"a1","issues":[]}]')).toEqual([]);
  });

  it('JSON の前後に文やコードの囲みが付いていても読める', () => {
    const f = parseFindings('見ました。\n```json\n[{"id":"a1","issues":["x"]}]\n```\nおわり。');
    expect(f).toHaveLength(1);
  });

  it('JSON として読めなければ空の結果にする', () => {
    expect(parseFindings('{こわれた')).toEqual([]);
    expect(parseRevisions('こわれた')).toEqual([]);
  });
});

describe('runWithBudget', () => {
  it('時間内に収まれば全部を処理する', async () => {
    let t = 0;
    const r = await runWithBudget([1, 2, 3], async (n) => n * 2, { now: () => t, budgetMs: 1000, concurrency: 1 });
    expect(r.results.sort()).toEqual([2, 4, 6]);
    expect(r.skipped).toBe(0);
  });

  it('時間を超えたら残りは始めず、飛ばした数を返す', async () => {
    let t = 0;
    const r = await runWithBudget(
      [1, 2, 3, 4],
      async (n) => { t += 100; return n; },
      { now: () => t, budgetMs: 250, concurrency: 1 },
    );
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.results.length).toBeLessThan(4);
  });

  it('途中の1件が失敗しても、ほかは処理を続ける', async () => {
    let t = 0;
    const r = await runWithBudget(
      [1, 2, 3],
      async (n) => { if (n === 2) throw new Error('fail'); return n; },
      { now: () => t, budgetMs: 1000, concurrency: 1 },
    );
    expect(r.results.sort()).toEqual([1, 3]);
  });
});

describe('proofreadArticles', () => {
  it('指摘のあった記事だけを修正し、ほかの記事はそのままにする', async () => {
    const items = [item(), item({ id: 'a2', headline: 'ほかの見出し', lead: 'ほかのリード', body: 'ほかの本文' })];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      if (body.system === INSPECT_SYSTEM_PROMPT) {
        return textResponse('[{"id":"a1","issues":["「山田社長」は素材に無い"]}]');
      }
      return textResponse('[{"id":"a1","headline":"架空の電機メーカー、新しい電池を発表","lead":"架空の電機メーカーA社は、充電が2倍速い電池を発表した。","body":"春の発表会で披露した。"}]');
    };
    const r = await proofreadArticles(items, { createMessageFn });
    expect(r.findings).toHaveLength(1);
    expect(r.revised.get('a1')?.lead).toBe('架空の電機メーカーA社は、充電が2倍速い電池を発表した。');
    expect(r.revised.has('a2')).toBe(false);
  });

  it('指摘が無ければ修正のための呼び出しをしない', async () => {
    let reviseCalls = 0;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      if (body.system === REVISE_SYSTEM_PROMPT) reviseCalls++;
      return textResponse('[]');
    };
    const r = await proofreadArticles([item()], { createMessageFn });
    expect(r.findings).toEqual([]);
    expect(reviseCalls).toBe(0);
  });

  it('検査がすべて失敗したら inspected は 0、failed は 1 以上になる', async () => {
    const createMessageFn = async () => { throw new Error('unavailable'); };
    const r = await proofreadArticles([item()], { createMessageFn });
    expect(r.revised.size).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.inspected).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('検査ができて指摘が無いときは inspected が件数、failed は 0 になる', async () => {
    const createMessageFn = async () => textResponse('[]');
    const r = await proofreadArticles([item(), item({ id: 'a2' })], { createMessageFn });
    expect(r.findings).toEqual([]);
    expect(r.inspected).toBe(2);
    expect(r.failed).toBe(0);
  });

  it('一部のまとまりだけ失敗したら、検査できた件数だけを inspected に数える', async () => {
    let call = 0;
    const createMessageFn = async () => {
      call += 1;
      if (call === 1) throw new Error('unavailable');
      return textResponse('[]');
    };
    const items = Array.from({ length: 4 }, (_, i) => item({ id: `a${i}` }));
    const r = await proofreadArticles(items, { createMessageFn, batchSize: 2, concurrency: 1 });
    expect(r.inspected).toBe(2);
    expect(r.failed).toBe(2);
  });

  it('記事が無ければモデルを呼ばない', async () => {
    let calls = 0;
    await proofreadArticles([], { createMessageFn: async () => { calls++; return textResponse('[]'); } });
    expect(calls).toBe(0);
  });
});

describe('空の返答や読めない返答', () => {
  it('readJsonArray は読めないとき null、空の配列なら [] を返す', () => {
    expect(readJsonArray('[]')).toEqual([]);
    expect(readJsonArray('')).toBeNull();
    expect(readJsonArray('{こわれた')).toBeNull();
    expect(readJsonArray('[{"id": こわれ]')).toBeNull();
  });

  it('検査の返答が何度でも空なら failed に数える', async () => {
    const createMessageFn = async () => textResponse('');
    const r = await proofreadArticles([item()], { createMessageFn });
    expect(r.inspected).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('最初の返答が空でも、もう一度呼んで読めれば inspected に数える', async () => {
    let calls = 0;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      if (body.system === INSPECT_SYSTEM_PROMPT) calls++;
      return textResponse(calls === 1 ? '' : '[]');
    };
    const r = await proofreadArticles([item()], { createMessageFn });
    expect(calls).toBe(2);
    expect(r.inspected).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('呼び直すのは1回まで', async () => {
    let calls = 0;
    const createMessageFn = async () => { calls++; return textResponse('答えられません'); };
    await proofreadArticles([item()], { createMessageFn });
    expect(calls).toBe(2);
  });

  it('修正の返答が読めないときも failed に数える', async () => {
    const createMessageFn = async (body: AnthropicMessageBody) => (body.system === INSPECT_SYSTEM_PROMPT
      ? textResponse('[{"id":"a1","issues":["人名が素材に無い"]}]')
      : textResponse(''));
    const r = await proofreadArticles([item()], { createMessageFn });
    expect(r.inspected).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.revised.size).toBe(0);
  });
});

describe('findUnsourcedYen / mergeCodeFindings', () => {
  const sample = item({
    id: 'p1',
    title: 'Sample Robotics raises $50M',
    summaryRaw: 'Sample Robotics raised $50 million to build delivery robots.',
    content: '',
    headline: '配送ロボのサンプルロボティクス、50億円超を調達',
    lead: '架空のサンプルロボティクスが5000万ドル（50億円超）を調達した。',
    body: '',
  });

  it('元の資料に円が出てこないのに原稿に円の金額があれば指摘する', () => {
    const issue = findUnsourcedYen(sample);
    expect(issue).toContain('［機械検査］円建ての金額（50億円）');
  });

  it('元の資料に円の記述があれば指摘しない', () => {
    expect(findUnsourcedYen({ ...sample, summaryRaw: '5000万ドル（約70億円）を調達' })).toBeNull();
    expect(findUnsourcedYen({ ...sample, content: 'about ¥7 billion' })).toBeNull();
  });

  it('原稿に円の金額が無ければ指摘しない', () => {
    expect(findUnsourcedYen({ ...sample, headline: 'サンプルロボティクス、5000万ドル調達', lead: '5000万ドルを調達した。' })).toBeNull();
  });

  it('モデルの指摘がある記事には付け足し、無い記事には新しく作る', () => {
    const other = item({ id: 'o1', headline: 'ほかの見出し', lead: 'ほかのリード', body: 'ほかの本文' });
    const merged = mergeCodeFindings([{ id: 'o1', issues: ['人名が素材に無い'] }], [sample, other]);
    expect(merged).toHaveLength(2);
    expect(merged.find((f) => f.id === 'o1')?.issues).toEqual(['人名が素材に無い']);
    expect(merged.find((f) => f.id === 'p1')?.issues[0]).toContain('機械検査');
  });

  it('同じ記事に両方の指摘があれば、一つにまとめて両方を残す', () => {
    const merged = mergeCodeFindings([{ id: 'p1', issues: ['見出しの円の金額は素材に無い'] }], [sample]);
    expect(merged).toHaveLength(1);
    expect(merged[0].issues).toHaveLength(2);
    expect(merged[0].issues[1]).toContain('機械検査');
  });

  it('モデルの検査で指摘が無くても、円の金額の指摘があれば修正に回す', async () => {
    const reviseUsers: string[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      if (body.system === INSPECT_SYSTEM_PROMPT) return textResponse('[]');
      reviseUsers.push(String(body.messages[0].content));
      return textResponse('[{"id":"p1","headline":"配送ロボのサンプルロボティクス、5000万ドル調達","lead":"架空のサンプルロボティクスが5000万ドルを調達した。","body":""}]');
    };
    const r = await proofreadArticles([sample], { createMessageFn });
    expect(r.findings[0].issues[0]).toContain('機械検査');
    expect(reviseUsers[0]).toContain('円建ての金額（50億円）');
    expect(r.revised.get('p1')?.headline).toBe('配送ロボのサンプルロボティクス、5000万ドル調達');
  });
});
