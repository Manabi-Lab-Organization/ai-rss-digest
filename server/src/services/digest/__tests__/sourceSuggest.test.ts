
import { describe, it, expect } from 'vitest';
import {
  buildSuggestionUserMessage,
  runSuggestionLLM,
  SOURCE_SUGGEST_SYSTEM_PROMPT,
} from '../sourceSuggest.js';
import { getGenerateModel, getPremiumModel, type AnthropicMessageBody } from '../anthropicClient.js';

describe('buildSuggestionUserMessage', () => {
  it('渡した話題の文と、登録済みの情報源の一覧を含める', () => {
    const msg = buildSuggestionUserMessage('## 👍の多い話題\n- 会社: 株式会社サンプル', [
      { title: 'サンプル科学ニュース', xmlUrl: 'https://feed.example.com/science.xml' },
    ]);
    expect(msg).toContain('株式会社サンプル');
    expect(msg).toContain('既存の情報源一覧');
    expect(msg).toContain('サンプル科学ニュース（https://feed.example.com/science.xml）');
  });

  it('登録済みの情報源が無ければ、そのことを書く', () => {
    expect(buildSuggestionUserMessage('文脈', [])).toContain('まだ情報源が登録されていません');
  });

  it('登録済みの情報源に分類があれば、一覧に分類も書く', () => {
    const msg = buildSuggestionUserMessage('文脈', [
      { title: 'サンプル科学ニュース', xmlUrl: 'https://a.example.com/f', category: 'テクノロジー' },
      { title: '分類なし', xmlUrl: 'https://b.example.com/f' },
    ]);
    expect(msg).toContain('- サンプル科学ニュース（分類: テクノロジー / https://a.example.com/f）');
    expect(msg).toContain('- 分類なし（https://b.example.com/f）');
  });
});

describe('runSuggestionLLM', () => {
  it('ふだんのモデルと Web 検索で呼び出し、proposals 枠の中身を候補の形に直して返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return {
        content: [
          { type: 'server_tool_use' },
          {
            type: 'text',
            text: '評価の傾向から1件すすめます。\n```proposals\n[{"title": "サンプル園芸だより", "url": "https://example.com/garden.xml", "category": "暮らし", "reason": "家庭菜園の話題が多い（由来: 評価の傾向）"}]\n```',
          },
        ],
      };
    };
    const result = await runSuggestionLLM('## 話題\n- 家庭菜園', [{ title: '登録済み', xmlUrl: 'https://a.example.com/f' }], { createMessageFn, profileText: '' });
    expect(captured?.model).toBe(getGenerateModel());
    expect(captured?.system).toBe(SOURCE_SUGGEST_SYSTEM_PROMPT);
    expect(captured?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }]);
    expect(captured?.messages[0].content).toContain('登録済み（https://a.example.com/f）');
    expect(result.reply).toBe('評価の傾向から1件すすめます。');
    expect(result.candidates).toEqual([
      { title: 'サンプル園芸だより', xmlUrl: 'https://example.com/garden.xml', kind: 'rss', category: '暮らし', reason: '家庭菜園の話題が多い（由来: 評価の傾向）' },
    ]);
  });

  it('すすめる情報源が無い返事なら候補は空になる', async () => {
    const createMessageFn = async () => ({ content: [{ type: 'text', text: '今回すすめられる情報源はありません。' }] });
    const result = await runSuggestionLLM('文脈', [], { createMessageFn, profileText: '' });
    expect(result.candidates).toEqual([]);
  });

  it('premium を指定すると上位のモデルで呼び出す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: '今回すすめられる情報源はありません。' }] };
    };
    await runSuggestionLLM('文脈', [], { createMessageFn, premium: true, profileText: '' });
    expect(captured?.model).toBe(getPremiumModel());
  });
});

describe('編集方針を指示文に渡す', () => {
  const profile = '関心トピックの重み:\n  - トピック: 家庭菜園・園芸\n    重み: 高';

  it('編集方針を話題の文より前に入れる', () => {
    const msg = buildSuggestionUserMessage('文脈', [], [], profile);
    expect(msg).toContain('<editorial_profile>');
    expect(msg).toContain('家庭菜園・園芸');
    expect(msg.indexOf('<editorial_profile>')).toBeLessThan(msg.indexOf('文脈'));
  });

  it('方針が空ならタグごと入れない', () => {
    expect(buildSuggestionUserMessage('文脈', [])).not.toContain('<editorial_profile>');
    expect(buildSuggestionUserMessage('文脈', [], [], '   ')).not.toContain('<editorial_profile>');
  });

  it('runSuggestionLLM に渡した方針がモデルへの入力に入る', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: 'すすめる情報源はありません' }] };
    };
    await runSuggestionLLM('文脈', [], { createMessageFn, profileText: profile });
    expect(String(captured?.messages[0].content)).toContain('家庭菜園・園芸');
  });
});

describe('編集方針を提案の範囲の制限として使わせない指示', () => {
  it('方針の話題だけに絞らず、その外側も探すよう指示している', () => {
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('方針に書かれた話題だけに絞ってはならない');
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('提案してよい範囲の枠ではない');
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('関心の**外側**');
  });

  it('すすめる理由の出どころは評価の傾向とし、方針を出どころにしないよう指示している', () => {
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('由来は👍👎の傾向のまま');
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('「編集方針にあるから」を由来として書かない');
  });

  it('幅広く探すための指示が入っている', () => {
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('一段外側の輪');
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('読者が自分では思いつかないであろう情報源');
    expect(SOURCE_SUGGEST_SYSTEM_PROMPT).toContain('海外の一流メディアを積極的に');
  });
});
