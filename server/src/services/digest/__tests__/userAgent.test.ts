import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { USER_AGENT, buildUserAgent } from '../userAgent.js';

describe('取得のときの名乗り', () => {
  it('アプリの名前と版と、このソフトの説明のページを名乗る', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));
    expect(USER_AGENT).toBe(
      `Mozilla/5.0 (compatible; AI-RSS-Digest/${version}; +https://github.com/Manabi-Lab-Organization/ai-rss-digest)`,
    );
  });

  it('ブラウザの名前を名乗らない', () => {
    expect(USER_AGENT).not.toMatch(/Chrome|Safari|Firefox|AppleWebKit|Gecko/);
  });

  it('版が分からないときは版を付けずに名乗る', () => {
    expect(buildUserAgent(null)).toBe(
      'Mozilla/5.0 (compatible; AI-RSS-Digest; +https://github.com/Manabi-Lab-Organization/ai-rss-digest)',
    );
  });
});
