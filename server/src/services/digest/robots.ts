import { readTextLimited, safeFetch, type LookupFn } from './safeFetch.js';
import { ROBOTS_TOKEN, USER_AGENT } from './userAgent.js';

const MAX_ROBOTS_BYTES = 500 * 1024;
const ROBOTS_TIMEOUT_MS = 8000;
export const ROBOTS_CACHE_MS = 6 * 3600_000;
export const ROBOTS_ERROR_CACHE_MS = 3600_000;
const MAX_CACHE_ENTRIES = 1000;

export const ROBOTS_DISALLOWED_REASON = 'サイトの設定で取得が許可されていない';

interface Rule {
  allow: boolean;
  path: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      if (key === 'disallow' && value === '') continue;
      current.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function selectRules(groups: Group[], token: string): Rule[] {
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a.split('/')[0].trim() === t));
  if (own.length > 0) return own.flatMap((g) => g.rules);
  return groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
}

export function matchesPattern(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!target.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return anchored ? pos === target.length : true;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = target.indexOf(parts[i], pos);
    if (found < 0) return false;
    pos = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  if (anchored) return target.length - last.length >= pos && target.endsWith(last);
  return target.indexOf(last, pos) >= 0;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function isPathAllowed(groups: Group[], pathWithQuery: string, token: string = ROBOTS_TOKEN): boolean {
  const rules = selectRules(groups, token);
  const target = safeDecode(pathWithQuery);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matchesPattern(safeDecode(rule.path), target)) continue;
    if (
      !best
      || rule.path.length > best.path.length
      || (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

interface CacheEntry {
  groups: Group[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearRobotsCache(): void {
  cache.clear();
}

const DISALLOW_ALL: Group[] = [{ agents: ['*'], rules: [{ allow: false, path: '/' }] }];

async function loadRobots(
  origin: string,
  { fetchFn, lookupFn }: { fetchFn?: typeof fetch; lookupFn?: LookupFn },
): Promise<{ groups: Group[]; ttl: number }> {
  try {
    const res = await safeFetch(
      `${origin}/robots.txt`,
      { headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, */*' }, signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS) },
      { fetchFn, lookupFn },
    );
    if (res.status >= 500) return { groups: DISALLOW_ALL, ttl: ROBOTS_ERROR_CACHE_MS };
    if (!res.ok) return { groups: [], ttl: ROBOTS_CACHE_MS };
    return { groups: parseRobots(await readTextLimited(res, MAX_ROBOTS_BYTES)), ttl: ROBOTS_CACHE_MS };
  } catch {
    return { groups: DISALLOW_ALL, ttl: ROBOTS_ERROR_CACHE_MS };
  }
}

export async function isAllowedByRobots(
  url: string,
  { fetchFn, lookupFn, now = Date.now() }: { fetchFn?: typeof fetch; lookupFn?: LookupFn; now?: number } = {},
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const origin = u.origin;
  let entry = cache.get(origin);
  if (!entry || entry.expiresAt <= now) {
    const { groups, ttl } = await loadRobots(origin, { fetchFn, lookupFn });
    entry = { groups, expiresAt: now + ttl };
    cache.delete(origin);
    cache.set(origin, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return isPathAllowed(entry.groups, `${u.pathname}${u.search}`);
}
