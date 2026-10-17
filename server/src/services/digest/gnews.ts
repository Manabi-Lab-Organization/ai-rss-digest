export function buildGoogleNewsFeedUrl(keyword: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(keyword.trim())}&hl=ja&gl=JP&ceid=JP:ja`;
}

export function extractGoogleNewsKeyword(xmlUrl: string): string | null {
  try {
    const u = new URL(xmlUrl);
    if (u.hostname === 'news.google.com' && u.pathname === '/rss/search') {
      return u.searchParams.get('q');
    }
  } catch {  }
  return null;
}

export function isGoogleNewsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'news.google.com' && u.pathname.startsWith('/rss/articles/');
  } catch {
    return false;
  }
}
