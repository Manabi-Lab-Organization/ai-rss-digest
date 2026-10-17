import fs from 'node:fs';

export const PROJECT_URL = 'https://github.com/Manabi-Lab-Organization/ai-rss-digest';
export const ROBOTS_TOKEN = 'AI-RSS-Digest';

function readVersion(): string | null {
  const candidates = [
    new URL('../../../../package.json', import.meta.url),
    `${process.cwd()}/package.json`,
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'ai-rss-digest' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      continue;
    }
  }
  return null;
}

export function buildUserAgent(version: string | null): string {
  const product = version ? `${ROBOTS_TOKEN}/${version}` : ROBOTS_TOKEN;
  return `Mozilla/5.0 (compatible; ${product}; +${PROJECT_URL})`;
}

export const USER_AGENT = buildUserAgent(readVersion());
