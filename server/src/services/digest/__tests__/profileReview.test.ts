
import { describe, it, expect } from 'vitest';
import {
  shouldRunReview,
  buildReviewPrompt,
  reviewProfile,
  REVIEW_THRESHOLD,
  type RatedSignal,
  type OpinionSignal,
} from '../profileReview.js';
import { getGenerateModel, type AnthropicMessageBody } from '../anthropicClient.js';

const rated: RatedSignal[] = [
  { rating: 1, headline: '架空の県が新しい補助制度', section: '行政・政策', included: true, sourceTitle: 'サンプル県庁だより' },
  { rating: -1, headline: '便利な小技まとめ', section: 'テクノロジー・AI', included: false, sourceTitle: 'サンプルブログ' },
];
const opinions: OpinionSignal[] = [
  { createdAt: '2054-07-15', comment: '天気と農業の記事をもう少し読みたい' },
];

describe('shouldRunReview', () => {
  it('評価の数が決めた数より少なければ見直さない', () => {
    expect(shouldRunReview(0)).toBe(false);
    expect(shouldRunReview(REVIEW_THRESHOLD - 1)).toBe(false);
  });
  it('決めた数以上なら見直す', () => {
    expect(shouldRunReview(REVIEW_THRESHOLD)).toBe(true);
    expect(shouldRunReview(100)).toBe(true);
  });
  it('決めた数は引数で変えられる', () => {
    expect(shouldRunReview(3, 3)).toBe(true);
    expect(shouldRunReview(2, 3)).toBe(false);
  });
});

describe('buildReviewPrompt', () => {
  it('今の方針・評価・意見を入れ、書き直した方針を全文で出すよう指示する', () => {
    const { system, user } = buildReviewPrompt('# 試しの方針\nversion: 1', rated, opinions);
    expect(system).toContain('<editorial_profile>');
    expect(system).toContain('# 試しの方針');
    expect(system).toContain('改定後のプロファイル全文');
    expect(user).toContain('👍 [本編/行政・政策] 架空の県が新しい補助制度（サンプル県庁だより）');
    expect(user).toContain('👎 [非採用/テクノロジー・AI] 便利な小技まとめ（サンプルブログ）');
    expect(user).toContain('天気と農業の記事をもう少し読みたい');
  });

  it('評価も意見も無いときは「（なし）」と書く', () => {
    const { user } = buildReviewPrompt('profile', [], []);
    expect(user).toContain('（なし）');
  });
});

describe('reviewProfile', () => {
  it('ふだんのモデルで呼び出し、書き直した方針の文を返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const revised = `# 変更点(2054-07-19): 農業の重みを「低」から「中」へ\n${'# 書き直した方針の中身\n'.repeat(10)}`;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: revised }] };
    };
    const result = await reviewProfile({ profileText: 'p', rated, opinions }, { createMessageFn });
    expect(captured?.model).toBe(getGenerateModel());
    expect(captured?.tools).toBeUndefined();
    expect(result).toBe(revised.trim());
  });

  it('返事が極端に短いときはエラーにする', async () => {
    const createMessageFn = async () => ({ content: [{ type: 'text', text: 'そのまま' }] });
    await expect(reviewProfile({ profileText: 'p', rated, opinions }, { createMessageFn })).rejects.toThrow(/短すぎます/);
  });
});

describe('buildReviewPrompt に入る評価の理由', () => {
  const withReason: RatedSignal[] = [
    {
      rating: -1,
      headline: '架空の電機メーカーA社が新しい電池',
      section: 'テクノロジー・AI',
      included: true,
      sourceTitle: 'サンプル技術ニュース',
      reason: '同じ話を二日続けて読んだ。新しいことが無いなら一度でよい',
    },
    { rating: 1, headline: '架空の県が新しい補助制度', section: '行政・政策', included: true, sourceTitle: 'サンプル県庁だより' },
  ];

  it('理由はその記事の評価の行のすぐ下に書く', () => {
    const { user } = buildReviewPrompt('# 方針', withReason, []);
    const lines = user.split('\n');
    const idx = lines.findIndex((l) => l.includes('架空の電機メーカーA社が新しい電池'));
    expect(lines[idx + 1]).toContain('理由（読者本人の記述）: 同じ話を二日続けて読んだ');
  });

  it('理由の無い評価には理由の行を書かない', () => {
    const { user } = buildReviewPrompt('# 方針', withReason, []);
    const lines = user.split('\n');
    const idx = lines.findIndex((l) => l.includes('架空の県が新しい補助制度'));
    expect(lines[idx + 1] ?? '').not.toContain('理由（読者本人の記述）');
  });

  it('理由の付いた評価の数を見出しに書く', () => {
    const { user } = buildReviewPrompt('# 方針', withReason, []);
    expect(user).toContain('うち1件は読者が理由を書いている');
  });

  it('理由の付いた評価が無いときは、見出しにその数を書かない', () => {
    const { user } = buildReviewPrompt('# 方針', rated, opinions);
    expect(user).not.toContain('読者が理由を書いている');
  });

  it('理由の付いた評価を先に扱い、記事の名前ではなく決まりごとに直すよう指示している', () => {
    const { system } = buildReviewPrompt('# 方針', withReason, []);
    expect(system).toContain('理由が書かれている評価は最優先で扱う');
    expect(system).toContain('再現できる判断ルールへ翻訳する');
    expect(system).toContain('理由の無い評価は、同じ傾向が複数件そろって初めてシグナル');
  });
});
