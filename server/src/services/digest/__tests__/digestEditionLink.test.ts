import { describe, it, expect } from 'vitest';
import {
  digestEditionUrl,
  buildDigestEditionEmailHtml,
  buildDigestPodcastEmailHtml,
} from '../../emailService.js';

describe('digestEditionUrl', () => {
  it('号の番号をクエリに付けたアプリの URL を返す', () => {
    expect(digestEditionUrl('https://app.example.com', 124)).toBe('https://app.example.com/digest?edition=124');
  });

  it('号の番号が違えば URL も違う', () => {
    expect(digestEditionUrl('https://web.example.org', 124)).not.toBe(digestEditionUrl('https://web.example.org', 125));
  });
});

const editionParams = {
  editionId: 124,
  title: 'サンプル号',
  content: {
    format: 'paper' as const,
    sections: [{
      name: '総合',
      articles: [{ headline: '架空の町で花火大会', lead: '週末に開かれる予定。', url: 'https://news.example.com/1', sourceTitle: 'サンプル新報' }],
    }],
  },
  isFirstIssue: false,
  growingNotice: false,
};

describe('紙面のお知らせメールに入るリンク', () => {
  it('アプリで読むリンクがその号の URL になっている', () => {
    const html = buildDigestEditionEmailHtml(editionParams, 'https://app.example.com');
    expect(html).toContain('href="https://app.example.com/digest?edition=124"');
  });

  it('号の番号が付かないリンクは含まれない', () => {
    const html = buildDigestEditionEmailHtml(editionParams, 'https://app.example.com');
    expect(html).not.toContain('href="https://app.example.com/digest"');
  });

  it('号が違えばメールの本文も違い、その号の番号が入る', () => {
    const a = buildDigestEditionEmailHtml(editionParams, 'https://app.example.com');
    const b = buildDigestEditionEmailHtml({ ...editionParams, editionId: 125 }, 'https://app.example.com');
    expect(a).not.toBe(b);
    expect(b).toContain('edition=125');
  });
});

describe('音声版のお知らせメールに入るリンク', () => {
  const podcastParams = { editionId: 124, editionTitle: 'サンプル号', durationSec: 796 };

  it('アプリで聴くリンクがその号の URL になっている', () => {
    const html = buildDigestPodcastEmailHtml(podcastParams, 'https://app.example.com');
    expect(html).toContain('href="https://app.example.com/digest?edition=124"');
  });

  it('号の番号が付かないリンクは含まれない', () => {
    const html = buildDigestPodcastEmailHtml(podcastParams, 'https://app.example.com');
    expect(html).not.toContain('href="https://app.example.com/digest"');
  });
});
