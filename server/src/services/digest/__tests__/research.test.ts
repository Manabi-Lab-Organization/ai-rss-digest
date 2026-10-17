import { describe, it, expect } from 'vitest';
import {
  buildResearchPrompt,
  researchArticle,
  articleHeadline,
  getResearchModel,
} from '../research.js';
import type { AnthropicMessageBody, CreateMessageFn } from '../anthropicClient.js';

const article = {
  title: '架空の電機メーカーA社が新しい電池を発表',
  url: 'https://news.example.com/articles/42',
  feedTitle: 'サンプル新報',
  publishedAt: '2054-07-18T21:00:00.000Z',
  summary: '新電池を発表｜充電時間が半分に｜来春から出荷',
};

describe('buildResearchPrompt', () => {
  it('システム指示に媒体名と調査レポートの見出し・文字数の指定が入る', () => {
    const { system } = buildResearchPrompt(article);
    expect(system).toMatch(/^あなたは「[^」]+」の調査記者です/);
    expect(system).toContain('AI RSS Digest');
    for (const h of ['【何が起きたか】', '【背景・経緯】', '【関連する動き・各所の反応】', '【多角的な視点】', '【読者の事業への示唆】', '【主な出典】']) {
      expect(system).toContain(h);
    }
    expect(system).toContain('1000〜2000字');
  });

  it('ユーザーメッセージに記事の題名・出典と URL・要約が入る', () => {
    const { user } = buildResearchPrompt(article);
    expect(user).toContain('架空の電機メーカーA社が新しい電池を発表');
    expect(user).toContain('サンプル新報 https://news.example.com/articles/42');
    expect(user).toContain('新電池を発表 / 充電時間が半分に / 来春から出荷');
  });

  it('記事の本文を渡すと、4000字までに切って添える', () => {
    const fullText = 'あ'.repeat(5000);
    const { user } = buildResearchPrompt(article, { fullText });
    expect(user).toContain('## 元記事の本文（抜粋）');
    expect(user).not.toContain('あ'.repeat(4001));
    expect(user).toContain('あ'.repeat(4000));
  });

  it('本文を渡さなければ本文の欄は入らない', () => {
    const { user } = buildResearchPrompt(article);
    expect(user).not.toContain('元記事の本文');
  });
});

describe('researchArticle', () => {
  function mockCreateMessage(text: string) {
    const calls: AnthropicMessageBody[] = [];
    const fn: CreateMessageFn = async (body) => {
      calls.push(body);
      return { content: [{ type: 'text', text }] };
    };
    return { fn, calls };
  }

  it('調査用モデルと検索ツール（最大6回）で1回呼び出し、前後の空白を除いたレポートを返す', async () => {
    const report = '【何が起きたか】' + 'か'.repeat(300);
    const { fn, calls } = mockCreateMessage(`  ${report}  `);
    const result = await researchArticle(article, { createMessageFn: fn });
    expect(result).toBe(report);
    expect(calls).toHaveLength(1);
    const body = calls[0];
    expect(body.model).toBe(getResearchModel());
    expect(body.max_tokens).toBe(4000);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]);
    expect(body.messages[0].content).toContain('架空の電機メーカーA社が新しい電池を発表');
  });

  it('レポートが200字に満たなければ例外を投げる', async () => {
    const { fn } = mockCreateMessage('とても短い');
    await expect(researchArticle(article, { createMessageFn: fn })).rejects.toThrow('レポートが短すぎます');
  });
});

describe('articleHeadline', () => {
  it('要約の最初の区切りまでを見出しとして使う', () => {
    expect(articleHeadline('朝市が再開｜三年ぶり｜港の広場で', '元の題名')).toBe('朝市が再開');
  });

  it('要約が無い、または見出し部分が空なら元の題名を使う', () => {
    expect(articleHeadline(null, '元の題名')).toBe('元の題名');
    expect(articleHeadline('', '元の題名')).toBe('元の題名');
    expect(articleHeadline('  ｜続きだけ', '元の題名')).toBe('元の題名');
  });
});
