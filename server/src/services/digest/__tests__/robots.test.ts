import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseRobots, isPathAllowed, isAllowedByRobots, clearRobotsCache, ROBOTS_CACHE_MS, ROBOTS_ERROR_CACHE_MS, ROBOTS_DISALLOWED_REASON,
} from '../robots.js';
import { fetchArticleTextDetailed, GOOGLE_NEWS_SKIPPED_REASON } from '../fetchArticle.js';

const lookupFn = async () => ['93.184.216.34'];

function robotsServer(robots: string | { status: number } | Error, page = `<p>${'記事の文'.repeat(100)}</p>`) {
  const calls: string[] = [];
  const agents: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    agents.push(((init?.headers ?? {}) as Record<string, string>)['User-Agent'] ?? '');
    if (url.endsWith('/robots.txt')) {
      if (robots instanceof Error) throw robots;
      if (typeof robots !== 'string') return new Response('', { status: robots.status });
      return new Response(robots, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, agents };
}

beforeEach(() => clearRobotsCache());

describe('parseRobots と isPathAllowed', () => {
  it('すべてのロボットへの禁止に従う', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /private/\n');
    expect(isPathAllowed(groups, '/private/a.html')).toBe(false);
    expect(isPathAllowed(groups, '/news/a.html')).toBe(true);
  });

  it('このアプリあての指定があれば、そちらを使う', () => {
    const groups = parseRobots([
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: AI-RSS-Digest',
      'Disallow: /members/',
    ].join('\n'));
    expect(isPathAllowed(groups, '/news/a.html')).toBe(true);
    expect(isPathAllowed(groups, '/members/a.html')).toBe(false);
  });

  it('名前の一部が同じだけの別のロボットあての指定は使わない', () => {
    const groups = parseRobots('User-agent: AI\nDisallow: /\n\nUser-agent: *\nDisallow:\n');
    expect(isPathAllowed(groups, '/news/a.html')).toBe(true);
  });

  it('いちばん長く当てはまる規則を使い、同じ長さなら許可を優先する', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /news/\nAllow: /news/open/\n');
    expect(isPathAllowed(groups, '/news/open/a.html')).toBe(true);
    expect(isPathAllowed(groups, '/news/closed/a.html')).toBe(false);
  });

  it('* と $ の書き方を扱う', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?print=\n');
    expect(isPathAllowed(groups, '/files/a.pdf')).toBe(false);
    expect(isPathAllowed(groups, '/files/a.pdf.html')).toBe(true);
    expect(isPathAllowed(groups, '/news/a?print=1')).toBe(false);
  });

  it('空の Disallow は何も禁止しない', () => {
    expect(isPathAllowed(parseRobots('User-agent: *\nDisallow:\n'), '/a')).toBe(true);
  });
});

describe('isAllowedByRobots', () => {
  it('サイトの robots.txt を、このアプリの名乗りで読みに行く', async () => {
    const server = robotsServer('User-agent: *\nDisallow: /private/\n');
    expect(await isAllowedByRobots('https://news.example.com/private/a', { fetchFn: server.fetchFn, lookupFn })).toBe(false);
    expect(server.calls).toEqual(['https://news.example.com/robots.txt']);
    expect(server.agents[0]).toContain('AI-RSS-Digest');
  });

  it('同じサイトの robots.txt は一定時間ためて、読み直さない', async () => {
    const server = robotsServer('User-agent: *\nDisallow: /private/\n');
    const now = 1_000_000;
    await isAllowedByRobots('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn, now });
    await isAllowedByRobots('https://news.example.com/b', { fetchFn: server.fetchFn, lookupFn, now: now + 1000 });
    expect(server.calls).toHaveLength(1);
    await isAllowedByRobots('https://news.example.com/c', { fetchFn: server.fetchFn, lookupFn, now: now + ROBOTS_CACHE_MS + 1 });
    expect(server.calls).toHaveLength(2);
  });

  it('robots.txt が無いときは取得してよい', async () => {
    const server = robotsServer({ status: 404 });
    expect(await isAllowedByRobots('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn })).toBe(true);
  });

  it('robots.txt に接続できないときは、しばらく取得しない', async () => {
    const server = robotsServer(new Error('接続できません'));
    expect(await isAllowedByRobots('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn })).toBe(false);
  });

  it('robots.txt がサーバの障害（5xx）で返らないときは、しばらく取得せず、1時間で読み直す', async () => {
    const server = robotsServer({ status: 503 });
    const now = 1_000_000;
    expect(await isAllowedByRobots('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn, now })).toBe(false);
    await isAllowedByRobots('https://news.example.com/b', { fetchFn: server.fetchFn, lookupFn, now: now + ROBOTS_ERROR_CACHE_MS + 1 });
    expect(server.calls).toHaveLength(2);
  });

  it('robots.txt も内側の番地へは取りに行かない', async () => {
    const server = robotsServer('User-agent: *\nDisallow: /\n');
    await isAllowedByRobots('https://intranet.example.com/a', { fetchFn: server.fetchFn, lookupFn: async () => ['10.0.0.1'] });
    expect(server.calls).toHaveLength(0);
  });
});

describe('記事の本文の取得と robots.txt', () => {
  it('禁止されたページは取りに行かず、理由を付けて失敗にする', async () => {
    const server = robotsServer('User-agent: *\nDisallow: /\n');
    const r = await fetchArticleTextDetailed('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn });
    expect(r).toEqual({ text: null, reason: ROBOTS_DISALLOWED_REASON });
    expect(server.calls).toEqual(['https://news.example.com/robots.txt']);
  });

  it('許可されたページは取りに行く', async () => {
    const server = robotsServer('User-agent: *\nDisallow: /private/\n');
    const r = await fetchArticleTextDetailed('https://news.example.com/a', { fetchFn: server.fetchFn, lookupFn });
    expect(r.text).toContain('記事の文');
    expect(server.calls).toEqual(['https://news.example.com/robots.txt', 'https://news.example.com/a']);
  });

  it('Googleニュースの記事ページは取りに行かない', async () => {
    const server = robotsServer('');
    const r = await fetchArticleTextDetailed('https://news.google.com/rss/articles/abc', { fetchFn: server.fetchFn, lookupFn });
    expect(r).toEqual({ text: null, reason: GOOGLE_NEWS_SKIPPED_REASON });
    expect(server.calls).toHaveLength(0);
  });
});

describe('robots.txt の書き方で、照合が遅くならない', () => {
  it('* がたくさんある行でも、すぐに答えを返す', () => {
    const groups = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(30)}*b\n`);
    const started = Date.now();
    expect(isPathAllowed(groups, `/${'a'.repeat(5000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('* と末尾の $ を robots.txt の決まりどおりに扱う', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/cache\n');
    expect(isPathAllowed(groups, '/files/a.pdf')).toBe(false);
    expect(isPathAllowed(groups, '/files/a.pdf?x=1')).toBe(true);
    expect(isPathAllowed(groups, '/tmp1/cache/x')).toBe(false);
    expect(isPathAllowed(groups, '/tmp1/other')).toBe(true);
  });
});

describe('転送された先の robots.txt', () => {
  it('記事のリンクが別のサイトへ転送されたら、転送先の robots.txt にも従う', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url === 'https://short.example.com/robots.txt') return new Response('', { status: 404 });
      if (url === 'https://news.example.org/robots.txt') {
        return new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      if (url === 'https://short.example.com/x') return new Response('', { status: 302, headers: { location: 'https://news.example.org/a' } });
      return new Response(`<p>${'記事の文'.repeat(100)}</p>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const r = await fetchArticleTextDetailed('https://short.example.com/x', { fetchFn, lookupFn });
    expect(r).toEqual({ text: null, reason: ROBOTS_DISALLOWED_REASON });
    expect(calls).not.toContain('https://news.example.org/a');
  });
});
