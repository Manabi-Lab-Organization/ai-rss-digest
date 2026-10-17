import { describe, it, expect } from 'vitest';
import {
  buildGoogleNewsFeedUrl,
  extractGoogleNewsKeyword,
  isGoogleNewsUrl,
} from '../gnews.js';

describe('buildGoogleNewsFeedUrl', () => {
  it('検索語をエンコードし、日本語版の検索フィード URL を作る', () => {
    const url = buildGoogleNewsFeedUrl('新素材 電池');
    expect(url).toBe(
      'https://news.google.com/rss/search?q=%E6%96%B0%E7%B4%A0%E6%9D%90%20%E9%9B%BB%E6%B1%A0&hl=ja&gl=JP&ceid=JP:ja',
    );
  });

  it('作った URL から元の検索語を取り出せる。検索フィード以外は null', () => {
    const url = buildGoogleNewsFeedUrl('商店街 イベント');
    expect(extractGoogleNewsKeyword(url)).toBe('商店街 イベント');
    expect(extractGoogleNewsKeyword('https://feed.example.com/rss')).toBeNull();
  });
});

describe('isGoogleNewsUrl', () => {
  it('記事へ転送する URL のときだけ true を返す', () => {
    expect(isGoogleNewsUrl('https://news.google.com/rss/articles/CBMiSAMPLE?oc=5')).toBe(true);
    expect(isGoogleNewsUrl('https://news.google.com/rss/search?q=x')).toBe(false);
    expect(isGoogleNewsUrl('https://news.example.com/')).toBe(false);
    expect(isGoogleNewsUrl('not a url')).toBe(false);
  });
});
