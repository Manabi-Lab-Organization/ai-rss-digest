import { describe, it, expect } from 'vitest';
import { fetchFeed } from '../rss.js';

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>サンプル町だより</title>
    <item>
      <title> 図書館の開館時間を延長 </title>
      <link>https://feed.example.org/notice/101</link>
      <pubDate>Sat, 18 Jul 2054 21:00:00 GMT</pubDate>
      <description>平日は夜8時まで開館します。</description>
      <content:encoded><![CDATA[<p>来月から平日の開館時間を延ばします。</p>]]></content:encoded>
    </item>
    <item>
      <title>リンクの無いお知らせ</title>
    </item>
    <item>
      <title>公園の遊具を新しくしました</title>
      <link>https://feed.example.org/notice/102</link>
    </item>
  </channel>
</rss>`;

function fetchReturning(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
}

const publicLookup = async () => ['93.184.216.34'];

describe('fetchFeed', () => {
  it('RSS を読み、リンクのある記事だけを題名・URL・日時・要約・本文つきで返す', async () => {
    const result = await fetchFeed('https://feed.example.org/rss', { fetchFn: fetchReturning(RSS_XML), lookupFn: publicLookup });
    expect(result.feedTitle).toBe('サンプル町だより');
    expect(result.items).toHaveLength(2);
    const [a1, a2] = result.items!;
    expect(a1.title).toBe('図書館の開館時間を延長');
    expect(a1.url).toBe('https://feed.example.org/notice/101');
    expect(new Date(a1.publishedAt!).toISOString()).toBe('2054-07-18T21:00:00.000Z');
    expect(a1.summaryRaw).toBe('平日は夜8時まで開館します。');
    expect(a1.content).toContain('来月から平日の開館時間を延ばします。');
    expect(a2.publishedAt).toBeNull();
  });

  it('304 が返ったら notModified を true にする', async () => {
    const fetchFn = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const result = await fetchFeed('https://feed.example.org/rss', { etag: 'W/"abc"', fetchFn, lookupFn: publicLookup });
    expect(result.notModified).toBe(true);
  });

  it('エラーのステータスが返ったら例外を投げる', async () => {
    await expect(
      fetchFeed('https://feed.example.org/rss', { fetchFn: fetchReturning('gone', { status: 410 }), lookupFn: publicLookup }),
    ).rejects.toThrow('HTTP 410');
  });

  it('ETag と最終更新日時を条件付き取得のヘッダとして送る', async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(RSS_XML, { status: 200 });
    }) as unknown as typeof fetch;
    await fetchFeed('https://feed.example.org/rss', { etag: 'W/"abc"', lastModified: 'Sat, 18 Jul 2054 00:00:00 GMT', fetchFn, lookupFn: publicLookup });
    expect(seenHeaders['If-None-Match']).toBe('W/"abc"');
    expect(seenHeaders['If-Modified-Since']).toBe('Sat, 18 Jul 2054 00:00:00 GMT');
    expect(seenHeaders['User-Agent']).toMatch(/^Mozilla\/5\.0 \(compatible; AI-RSS-Digest\/\d+\.\d+\.\d+; \+https:\/\/github\.com\/Manabi-Lab-Organization\/ai-rss-digest\)$/);
    expect(seenHeaders['User-Agent']).not.toContain('Chrome');
  });

  it('.internal で終わるホスト名は取得せずに拒否する', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response(RSS_XML, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchFeed('http://backend.service.internal/rss', { fetchFn })).rejects.toThrow(
      /内部ホスト/,
    );
    expect(called).toBe(false);
  });

  it('名前解決の結果が内部のアドレスなら取得せずに拒否する', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response(RSS_XML, { status: 200 });
    }) as unknown as typeof fetch;
    const internalLookup = async () => ['169.254.169.254'];
    await expect(
      fetchFeed('https://evil.example.com/rss', { fetchFn, lookupFn: internalLookup }),
    ).rejects.toThrow(/内部\/予約アドレス/);
    expect(called).toBe(false);
  });
});
