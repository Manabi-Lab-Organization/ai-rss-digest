import { describe, it, expect } from 'vitest';
import {
  enrichWithFullText, formatEnrichFailures, fetchArticleTextDetailed, type EnrichableRep,
} from '../fetchArticle.js';

const rep = (over: { url?: string | null; content?: string | null; title?: string | null } = {}): EnrichableRep => ({
  rep: { url: 'https://example.com/a', content: null, ...over },
});

describe('enrichWithFullText', () => {
  it('取りに行った数・取れた数・取れなかった数を分けて返す', async () => {
    const reps = [rep({ url: 'https://ok.example.com/1' }), rep({ url: 'https://ng.example.com/2' })];
    const r = await enrichWithFullText(reps, {
      fetchTextFn: async (url) => (url.includes('ok.') ? 'あ'.repeat(1000) : null),
    });
    expect(r.attempted).toBe(2);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('取れた本文だけを記事に入れ、取れなかった記事は元の文のままにする', async () => {
    const ok = rep({ url: 'https://ok.example.com/1' });
    const ng = rep({ url: 'https://ng.example.com/2', content: '短いあらまし' });
    await enrichWithFullText([ok, ng], {
      fetchTextFn: async (url) => (url.includes('ok.') ? 'あ'.repeat(1000) : null),
    });
    expect(ok.rep.content).toHaveLength(1000);
    expect(ng.rep.content).toBe('短いあらまし');
  });

  it('すでに十分な長さの本文がある記事は取りに行かない', async () => {
    let calls = 0;
    const r = await enrichWithFullText([rep({ content: 'あ'.repeat(900) })], {
      fetchTextFn: async () => { calls++; return null; },
    });
    expect(calls).toBe(0);
    expect(r.attempted).toBe(0);
  });

  it('URL の無い記事は取りに行かない', async () => {
    const r = await enrichWithFullText([rep({ url: null })], { fetchTextFn: async () => 'x' });
    expect(r.attempted).toBe(0);
  });

  it('Googleニュースの記事ページは取りに行かず、RSS の文のままにする', async () => {
    let calls = 0;
    const g = rep({ url: 'https://news.google.com/rss/articles/CBMiSAMPLE?oc=5', content: 'RSS のあらまし' });
    const r = await enrichWithFullText([g], { fetchTextFn: async () => { calls++; return 'あ'.repeat(1000); } });
    expect(calls).toBe(0);
    expect(r.attempted).toBe(0);
    expect(g.rep.content).toBe('RSS のあらまし');
  });

  it('すべて取れなくてもエラーにはしない', async () => {
    const r = await enrichWithFullText([rep(), rep()], { fetchTextFn: async () => null });
    expect(r).toMatchObject({ attempted: 2, succeeded: 0, failed: 2 });
    expect(r.failures).toHaveLength(2);
  });
});

describe('enrichWithFullText の取れなかった記事の一覧', () => {
  it('取れなかった記事の見出し・URL・理由をまとめて返す', async () => {
    const r = await enrichWithFullText(
      [rep({ title: '取れない記事', url: 'https://www.news.example.com/x' }), rep({ title: '取れた記事', url: 'https://ok.example.com/y' })],
      {
        fetchTextFn: async (url) => url.includes('news.example.com')
          ? { text: null, reason: '本文を抽出できず（120字）' }
          : { text: 'あ'.repeat(400) },
      },
    );
    expect(r.succeeded).toBe(1);
    expect(r.failures).toEqual([{ title: '取れない記事', url: 'https://www.news.example.com/x', reason: '本文を抽出できず（120字）' }]);
  });

  it('理由の無い null が返ったときは「理由不明」にする', async () => {
    const r = await enrichWithFullText([rep()], { fetchTextFn: async () => null });
    expect(r.failures[0].reason).toBe('理由不明');
  });
});

describe('formatEnrichFailures', () => {
  it('取れなかった記事が無ければ空の配列を返す', () => {
    expect(formatEnrichFailures([])).toEqual([]);
  });

  it('最初の行に理由ごとの数を多い順に書き、続けて記事ごとに見出し・ドメイン・理由を書く', () => {
    const lines = formatEnrichFailures([
      { title: 'A', url: 'https://www.news.example.com/a', reason: '本文を抽出できず（120字）' },
      { title: 'B', url: 'https://www.news.example.com/b', reason: '本文を抽出できず（80字）' },
      { title: 'C', url: 'https://c.example.org/c', reason: 'HTTP 403' },
    ]);
    expect(lines[0]).toContain('本文を抽出できず×2 / HTTP 403×1');
    expect(lines[1]).toContain('「A」（news.example.com）— 本文を抽出できず（120字）');
    expect(lines[3]).toContain('「C」（c.example.org）— HTTP 403');
  });
});

describe('fetchArticleTextDetailed の取れなかった理由', () => {
  const lookupFn = async () => ['93.184.216.34'];
  const respond = (status: number, body: string, type = 'text/html') =>
    (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;

  it('HTTP でエラーが返ったら、その番号を理由にする', async () => {
    const r = await fetchArticleTextDetailed('https://page.example.com/', { fetchFn: respond(403, ''), lookupFn });
    expect(r).toEqual({ text: null, reason: 'HTTP 403' });
  });

  it('HTML でないときは、その種類を理由にする', async () => {
    const r = await fetchArticleTextDetailed('https://page.example.com/', { fetchFn: respond(200, '%PDF', 'application/pdf'), lookupFn });
    expect(r.reason).toBe('HTML以外（application/pdf）');
  });

  it('本文が短すぎるときは「本文を抽出できず」と字数を理由にする', async () => {
    const r = await fetchArticleTextDetailed('https://page.example.com/', { fetchFn: respond(200, '<p>続きは登録後に</p>'), lookupFn });
    expect(r.text).toBeNull();
    expect(r.reason).toMatch(/^本文を抽出できず（\d+字）$/);
  });

  it('本文が取れたときは理由を付けない', async () => {
    const r = await fetchArticleTextDetailed('https://page.example.com/', { fetchFn: respond(200, `<p>${'記事の文'.repeat(100)}</p>`), lookupFn });
    expect(r.text).toContain('記事の文');
    expect(r.reason).toBeUndefined();
  });
});

describe('fetchArticleTextDetailed で取得が止められたとき', () => {
  it('内側の番地へ取りに行くときは、理由を付けて失敗にする', async () => {
    const r = await fetchArticleTextDetailed('https://intranet.example.com/', {
      fetchFn: (async () => new Response('x')) as unknown as typeof fetch,
      lookupFn: async () => ['10.0.0.1'],
    });
    expect(r.text).toBeNull();
    expect(r.reason).toContain('内部');
  });
});
