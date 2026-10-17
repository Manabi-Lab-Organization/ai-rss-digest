import { describe, it, expect } from 'vitest';
import {
  cachedSystem,
  type AnthropicMessageBody,
  type AnthropicMessageResponse,
} from '../anthropicClient.js';
import { researchArticle } from '../research.js';
import { reviseProposal } from '../proposalChat.js';
import { inspectBatch, reviseBatch, type ProofreadItem } from '../proofread.js';
import { triageBatch } from '../triage.js';
import { dedupeBatch } from '../dedupe.js';
import { convertReportToVisual } from '../researchVisual.js';

const SEP = String.fromCharCode(1);

function cachedPrefix(body: AnthropicMessageBody): string {
  const parts: string[] = [];
  let cutoff = -1;
  if (body.tools) parts.push(`tools:${JSON.stringify(body.tools)}`);
  const push = (text: string, cached: boolean): void => {
    parts.push(text);
    if (cached) cutoff = parts.length;
  };
  if (typeof body.system === 'string') push(`system:${body.system}`, false);
  else for (const b of body.system ?? []) push(`system:${b.text}`, Boolean(b.cache_control));
  for (const m of body.messages) {
    if (typeof m.content === 'string') {
      push(`${m.role}:${m.content}`, false);
    } else {
      for (const b of m.content) {
        push(
          `${m.role}:${b.type === 'text' ? b.text : JSON.stringify(b)}`,
          b.type === 'text' && Boolean(b.cache_control),
        );
      }
    }
  }
  return cutoff < 0 ? '' : parts.slice(0, cutoff).join(SEP);
}

function totalChars(body: AnthropicMessageBody): number {
  const sys = typeof body.system === 'string'
    ? body.system
    : (body.system ?? []).map((b) => b.text).join('');
  const msgs = body.messages
    .map((m) => (typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')))
    .join('');
  return sys.length + msgs.length + (body.tools ? JSON.stringify(body.tools).length : 0);
}

interface FakeUsage { input: number; write: number; read: number }

function fakeApi(reply: string) {
  const store = new Set<string>();
  const usages: FakeUsage[] = [];
  const bodies: AnthropicMessageBody[] = [];
  const createMessageFn = async (body: AnthropicMessageBody): Promise<AnthropicMessageResponse> => {
    bodies.push(body);
    const prefix = cachedPrefix(body);
    let read = 0;
    for (const saved of store) {
      if (saved.length > read && prefix.startsWith(saved)) read = saved.length;
    }
    const write = prefix.length - read;
    if (prefix) store.add(prefix);
    const usage: FakeUsage = { input: Math.max(0, totalChars(body) - prefix.length), write, read };
    usages.push(usage);
    return {
      content: [{ type: 'text', text: reply }],
      usage: {
        input_tokens: usage.input,
        output_tokens: 10,
        cache_creation_input_tokens: usage.write,
        cache_read_input_tokens: usage.read,
      },
    };
  };
  return { createMessageFn, usages, bodies };
}

const REPORT = '【何が起きたか】\n架空の電機メーカーA社が新しい電池を発表した。'.repeat(20);

describe('researchArticle を続けて呼んだときの読み出し', () => {
  it('同じ記事で2回呼ぶと、2回目は書き込みが無く読み出しだけになる', async () => {
    const { createMessageFn, usages } = fakeApi(REPORT);
    const article = {
      title: '株式会社サンプルが新しい冷蔵庫を発売',
      url: 'https://example.com/a',
      feedTitle: 'サンプル家電ニュース',
      publishedAt: '2054-09-18',
    };
    await researchArticle(article, { createMessageFn });
    await researchArticle(article, { createMessageFn });
    expect(usages).toHaveLength(2);
    expect(usages[0].read).toBe(0);
    expect(usages[0].write).toBeGreaterThan(0);
    expect(usages[1].read).toBeGreaterThan(0);
    expect(usages[1].write).toBe(0);
  });

  it('記事が違っても、共通の先頭部分は読み出しになる', async () => {
    const { createMessageFn, usages } = fakeApi(REPORT);
    await researchArticle({ title: 'A', url: 'https://example.com/a' }, { createMessageFn });
    await researchArticle({ title: 'B', url: 'https://example.com/b' }, { createMessageFn });
    expect(usages[1].read).toBeGreaterThan(0);
  });
});

describe('reviseProposal で会話を重ねたときの読み出し', () => {
  it('3回目のやりとりでは、それまでの会話が読み出しになる', async () => {
    const { createMessageFn, usages } = fakeApi('わかりました。案のその部分を見直します。');
    const currentProfile = '# 好みの設定\n'.padEnd(400, 'あ');
    const draftProfile = '# 好みの設定（案）\n'.padEnd(400, 'い');
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const ask of ['料理の話題を増やしたい', '同じ話が何度も出るのが気になる', 'この案で進めてください']) {
      history.push({ role: 'user', content: ask });
      const r = await reviseProposal({ currentProfile, draftProfile, history }, { createMessageFn });
      history.push({ role: 'assistant', content: r.reply });
    }
    expect(usages).toHaveLength(3);
    expect(usages[0].read).toBe(0);
    expect(usages[1].write).toBeGreaterThan(0);
    expect(usages[2].read).toBeGreaterThan(0);
  });
});

describe('短い指示文には読み出し用の区切りを付けない', () => {
  const item: ProofreadItem = {
    id: 'a1', title: 't', summaryRaw: 's', content: 'c',
    headline: 'h', lead: 'l', body: 'b',
  };

  it('校閲の検査では指示文を文字列のまま送る', async () => {
    const { createMessageFn, bodies } = fakeApi('[]');
    await inspectBatch([item], { createMessageFn });
    expect(typeof bodies[0].system).toBe('string');
  });

  it('校閲の修正では指示文を文字列のまま送る', async () => {
    const { createMessageFn, bodies } = fakeApi('[]');
    await reviseBatch([{ ...item, issues: ['x'] }], { createMessageFn });
    expect(typeof bodies[0].system).toBe('string');
  });

  it('記事の振り分けでは指示文を文字列のまま送る', async () => {
    const { createMessageFn, bodies } = fakeApi('[{"id":"1","score":3}]');
    await triageBatch([{ id: '1', title: 't', summaryRaw: 's' }], { profileText: 'p', createMessageFn });
    expect(typeof bodies[0].system).toBe('string');
  });

  it('重なりの判定では指示文を文字列のまま送る', async () => {
    const { createMessageFn, bodies } = fakeApi('[]');
    await dedupeBatch([
      { id: '1', headline: 'a', lead: 'a' },
      { id: '2', headline: 'b', lead: 'b' },
    ], { createMessageFn });
    expect(typeof bodies[0].system).toBe('string');
  });

  it('調べた結果の図への変換では指示文を文字列のまま送る', async () => {
    const html = `<!DOCTYPE html><html><body>${'x'.repeat(600)}</body></html>`;
    const { createMessageFn, bodies } = fakeApi(html);
    await convertReportToVisual('h', REPORT, { createMessageFn });
    expect(typeof bodies[0].system).toBe('string');
  });
});

describe('cachedSystem', () => {
  it('文はそのままで、読み出し用の区切りだけを付ける', () => {
    const blocks = cachedSystem('元の文');
    expect(blocks).toEqual([
      { type: 'text', text: '元の文', cache_control: { type: 'ephemeral' } },
    ]);
  });
});
