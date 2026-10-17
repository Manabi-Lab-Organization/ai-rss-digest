import { describe, it, expect } from 'vitest';
import { isSameGoogleNewsArticle, formatSameArticle } from '../poller.js';
import { parseRssSource } from '../rss.js';

describe('isSameGoogleNewsArticle：同じ見出しと発行元の記事が既にあるか', () => {
  const gnews = 'https://news.google.com/rss/articles/CBMiSAMPLE?oc=5';
  const item = { url: gnews, title: ' 架空の電機メーカーA社、新しい電池を発表 ', sourceName: 'サンプル新報' };

  it('既にあれば true を返し、前後の空白を除いた見出しと発行元で問い合わせる', async () => {
    const seen: Array<[string, string | null]> = [];
    const r = await isSameGoogleNewsArticle(item, async (t, s) => { seen.push([t, s]); return true; });
    expect(r).toBe(true);
    expect(seen).toEqual([['架空の電機メーカーA社、新しい電池を発表', 'サンプル新報']]);
  });

  it('まだ無ければ false を返す', async () => {
    expect(await isSameGoogleNewsArticle(item, async () => false)).toBe(false);
  });

  it('Googleニュース以外の URL では問い合わせずに false を返す', async () => {
    let calls = 0;
    const r = await isSameGoogleNewsArticle({ ...item, url: 'https://news.example.com/a' }, async () => { calls++; return true; });
    expect(r).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('parseRssSource：RSS の発行元の読み取り', () => {
  it('属性つきの形から、空白を除いた名前と URL を取り出す', () => {
    expect(parseRssSource({ _: ' サンプル放送 ', $: { url: 'https://broadcast.example.com' } }))
      .toEqual({ sourceName: 'サンプル放送', sourceUrl: 'https://broadcast.example.com' });
  });

  it('配列で渡されたら最初の要素を使う', () => {
    expect(parseRssSource([{ _: 'サンプル省', $: { url: 'https://ministry.example.org' } }]))
      .toEqual({ sourceName: 'サンプル省', sourceUrl: 'https://ministry.example.org' });
  });

  it('文字列だけなら名前のみ、値が無ければ両方とも null', () => {
    expect(parseRssSource('サンプル省')).toEqual({ sourceName: 'サンプル省', sourceUrl: null });
    expect(parseRssSource(undefined)).toEqual({ sourceName: null, sourceUrl: null });
  });

  it('http・https 以外の URL は null にする', () => {
    expect(parseRssSource({ _: 'x', $: { url: 'javascript:alert(1)' } })).toEqual({ sourceName: 'x', sourceUrl: null });
  });
});

describe('formatSameArticle', () => {
  it('0件なら空文字、1件以上なら件数入りの文を返す', () => {
    expect(formatSameArticle(0)).toBe('');
    expect(formatSameArticle(2)).toBe(' / URLが変わっただけの集め済み記事2件（保存せず）');
  });
});
