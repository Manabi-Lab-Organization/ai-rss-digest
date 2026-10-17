import { describe, it, expect } from 'vitest';
import {
  parseProposalsFence,
  normalizeProposalItems,
  filterNewProposals,
  replyLooksLikeSourceList,
  parseRecoveredProposals,
  replyPromisesWorkWithoutResult,
  CONTINUE_NUDGE,
  buildChatSystemPrompt,
  runSourceChat,
  MAX_PROPOSALS_PER_TURN,
  SOURCE_CHAT_SYSTEM_PROMPT,
  PROPOSAL_RECOVERY_SYSTEM_PROMPT,
  type RawProposalItem,
} from '../sourceChat.js';
import { buildGoogleNewsFeedUrl } from '../gnews.js';
import { getGenerateModel, getPremiumModel, getTriageModel, type AnthropicMessageBody } from '../anthropicClient.js';

const systemText = (system: AnthropicMessageBody['system']): string =>
  typeof system === 'string' ? system : (system ?? []).map((b) => b.text).join('\n\n');

describe('parseProposalsFence', () => {
  it('最後の候補ブロックを取り出し、本文からは消す', () => {
    const reply = [
      'お好みに合いそうなものを2つ挙げます。よければ追加してください。',
      '```proposals',
      '[{"title": "サンプル園芸通信", "url": "https://garden.example.com/rss.xml", "category": "暮らし", "reason": "季節の手入れが分かる"},',
      ' {"title": "家庭菜園 道具", "keyword": "家庭菜園 道具", "category": "暮らし", "reason": "新しい道具の話題を拾う"}]',
      '```',
    ].join('\n');
    const { cleanReply, items } = parseProposalsFence(reply);
    expect(cleanReply).toBe('お好みに合いそうなものを2つ挙げます。よければ追加してください。');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('サンプル園芸通信');
    expect(items[1].keyword).toBe('家庭菜園 道具');
  });

  it('候補ブロックがなければ本文はそのままで、候補は空', () => {
    const { cleanReply, items } = parseProposalsFence('どんな話題を読みたいですか？');
    expect(cleanReply).toBe('どんな話題を読みたいですか？');
    expect(items).toEqual([]);
  });

  it('中身のJSONが壊れていても、ブロックは本文から消して候補は空にする', () => {
    const reply = 'いくつか挙げます。\n```proposals\n[{"title": "こわれた,,,]\n```';
    const { cleanReply, items } = parseProposalsFence(reply);
    expect(cleanReply).toBe('いくつか挙げます。');
    expect(items).toEqual([]);
  });

  it('配列でないJSONや、オブジェクトでない要素は捨てる', () => {
    expect(parseProposalsFence('x\n```proposals\n{"title": "obj"}\n```').items).toEqual([]);
    expect(parseProposalsFence('x\n```proposals\n["str", 1, {"title": "ok"}]\n```').items).toEqual([{ title: 'ok' }]);
  });
});

describe('normalizeProposalItems', () => {
  it('検索語の候補はGoogleニュース検索のフィードに変える', () => {
    const [p] = normalizeProposalItems([
      { title: '町の祭り', keyword: '秋祭り 架空町', category: '地域', reason: '近所の催しを知る' },
    ]);
    expect(p.kind).toBe('gnews');
    expect(p.xmlUrl).toBe(buildGoogleNewsFeedUrl('秋祭り 架空町'));
    expect(p.xmlUrl).toContain('news.google.com/rss/search');
  });

  it('URLの候補はそのまま使い、httpでないもの・名前や理由がないものは捨てる', () => {
    const out = normalizeProposalItems([
      { title: 'A', url: 'https://example.com/feed.xml', reason: 'r' },
      { title: 'B', url: 'ftp://example.com/feed.xml', reason: 'r' },
      { title: '', url: 'https://example.com/2.xml', reason: 'r' },
      { title: 'D', url: 'https://example.com/3.xml', reason: '' },
      { title: 'E', reason: 'r' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'A', xmlUrl: 'https://example.com/feed.xml', kind: 'rss', category: null });
  });

  it('1回に返す候補は上限の数までにする', () => {
    const items: RawProposalItem[] = Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`, url: `https://example.com/${i}.xml`, reason: 'r',
    }));
    expect(normalizeProposalItems(items)).toHaveLength(MAX_PROPOSALS_PER_TURN);
  });
});

describe('filterNewProposals', () => {
  const c = (xmlUrl: string) => ({ title: xmlUrl, xmlUrl, kind: 'rss' as const, category: null, reason: 'r' });

  it('すでにあるURLと、同じ回の中の重複を除く', () => {
    const out = filterNewProposals(
      [
        c('https://feed-a.example.com/f'),
        c('https://feed-b.example.com/f'),
        c('https://feed-a.example.com/f'),
        c('https://feed-c.example.com/f'),
      ],
      new Set(['https://feed-b.example.com/f']),
    );
    expect(out.map((p) => p.xmlUrl)).toEqual(['https://feed-a.example.com/f', 'https://feed-c.example.com/f']);
  });

  it('すでにあるものがなければ全部残す', () => {
    expect(filterNewProposals([c('https://feed-a.example.com/f')], new Set())).toHaveLength(1);
  });
});

describe('runSourceChat', () => {
  it('文章生成用のモデルとWeb検索の道具で呼び、文字以外のブロックは読み飛ばして候補を返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return {
        content: [
          { type: 'server_tool_use' },
          { type: 'web_search_tool_result' },
          { type: 'text', text: 'ひとつ挙げます。\n```proposals\n[{"title": "T", "url": "https://example.com/f.xml", "reason": "r"}]\n```' },
        ],
      };
    };
    const result = await runSourceChat([{ role: 'user', content: '料理の新しい話題を読みたい' }], { createMessageFn });
    expect(captured?.model).toBe(getGenerateModel());
    expect(captured?.system).toEqual([
      { type: 'text', text: SOURCE_CHAT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect(captured?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]);
    expect(result.reply).toBe('ひとつ挙げます。');
    expect(result.candidates).toEqual([
      { title: 'T', xmlUrl: 'https://example.com/f.xml', kind: 'rss', category: null, reason: 'r' },
    ]);
  });

  it('候補がない返事なら、本文だけを返す', async () => {
    const createMessageFn = async () => ({ content: [{ type: 'text', text: 'どんな話題を読みたいですか？' }] });
    const result = await runSourceChat([{ role: 'user', content: 'はじめまして' }], { createMessageFn });
    expect(result.reply).toBe('どんな話題を読みたいですか？');
    expect(result.candidates).toEqual([]);
  });

  it('上位モードを指定すると上位のモデルで呼ぶ', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: 'どんな話題を読みたいですか？' }] };
    };
    await runSourceChat([{ role: 'user', content: '料理の新しい話題を読みたい' }], { createMessageFn, premium: true });
    expect(captured?.model).toBe(getPremiumModel());
  });
});

describe('buildChatSystemPrompt', () => {
  it('追加の情報がなければ、基本の指示文ひとつだけになる', () => {
    expect(buildChatSystemPrompt()).toEqual([
      { type: 'text', text: SOURCE_CHAT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('登録済みの情報源があれば、種類つきの一覧と足りない分野を補う方針を加える', () => {
    const out = systemText(buildChatSystemPrompt(
      [
        { title: 'サンプル園芸通信', category: '暮らし', kind: 'rss' },
        { title: '架空電機 ニュース', category: null, kind: 'gnews' },
      ],
      ['挙げたままの候補A'],
    ));
    expect(out).toContain('登録済みの情報源一覧');
    expect(out).toContain('- サンプル園芸通信（分類: 暮らし / RSS）');
    expect(out).toContain('- 架空電機 ニュース（Googleニュース検索）');
    expect(out).toContain('提案済みで未回答の候補: 挙げたままの候補A');
    expect(out).toContain('手薄な軸を優先して埋める');
  });

  it('キャッシュの目印は共通の指示文にだけ付け、人ごとの情報はその後ろに分ける', () => {
    const blocks = buildChatSystemPrompt(
      [{ title: 'サンプル園芸通信', category: '暮らし', kind: 'rss' }],
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(SOURCE_CHAT_SYSTEM_PROMPT);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0].text).not.toContain('サンプル園芸通信');
    expect(blocks[1].text).toContain('サンプル園芸通信');
    expect(blocks[1].cache_control).toBeUndefined();
  });
});

describe('replyPromisesWorkWithoutResult', () => {
  it('「これから調べる」と言うだけで候補がない返事を見つける', () => {
    expect(replyPromisesWorkWithoutResult('近い分野も含めて情報源を調べてみます。', 0)).toBe(true);
    expect(replyPromisesWorkWithoutResult('よさそうなものを探します。しばらくお待ちください。', 0)).toBe(true);
  });

  it('候補がある返事・問いかけで終わる返事・ふつうの説明は対象にしない', () => {
    expect(replyPromisesWorkWithoutResult('調べてみます。', 2)).toBe(false);
    expect(replyPromisesWorkWithoutResult('どの分野から先に調べますか？', 0)).toBe(false);
    expect(replyPromisesWorkWithoutResult('3つ挙げました。追加すると集め始めます。', 0)).toBe(false);
    expect(replyPromisesWorkWithoutResult('', 0)).toBe(false);
  });
});

describe('runSourceChat（言うだけで終わった返事の続き）', () => {
  it('言うだけの返事のあと、同じ呼び出しの中で続きを頼み、候補まで出させる', async () => {
    const bodies: AnthropicMessageBody[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      bodies.push(body);
      if (bodies.length === 1) {
        return { content: [{ type: 'text', text: '資料を読みました。近い分野も含めて情報源を調べてみます。' }] };
      }
      return {
        content: [{
          type: 'text',
          text: '2つ挙げます。\n```proposals\n[{"title": "T", "url": "https://example.com/f.xml", "reason": "r"}]\n```',
        }],
      };
    };
    const result = await runSourceChat([{ role: 'user', content: '資料をもとに広く集めて' }], { createMessageFn });

    expect(bodies).toHaveLength(2);
    const contMessages = bodies[1].messages;
    expect(contMessages[contMessages.length - 2]).toEqual({
      role: 'assistant',
      content: [{
        type: 'text',
        text: '資料を読みました。近い分野も含めて情報源を調べてみます。',
        cache_control: { type: 'ephemeral' },
      }],
    });
    expect(contMessages[contMessages.length - 1]).toEqual({ role: 'user', content: CONTINUE_NUDGE });

    expect(result.reply).toBe('資料を読みました。近い分野も含めて情報源を調べてみます。\n\n2つ挙げます。');
    expect(result.candidates).toEqual([
      { title: 'T', xmlUrl: 'https://example.com/f.xml', kind: 'rss', category: null, reason: 'r' },
    ]);
  });

  it('続きの呼び出しが失敗しても、最初の返事は返す', async () => {
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      if (calls === 1) return { content: [{ type: 'text', text: '情報源を探してみます。' }] };
      throw new Error('api down');
    };
    const result = await runSourceChat([{ role: 'user', content: '旅行の話題を読みたい' }], { createMessageFn });
    expect(result.reply).toBe('情報源を探してみます。');
    expect(result.candidates).toEqual([]);
  });

  it('問いかけで終わる返事なら続きを頼まず、1回だけ呼ぶ', async () => {
    let calls = 0;
    const createMessageFn = async () => {
      calls++;
      return { content: [{ type: 'text', text: 'どの分野から先に調べますか？' }] };
    };
    await runSourceChat([{ role: 'user', content: '幅広く読みたい' }], { createMessageFn });
    expect(calls).toBe(1);
  });
});

describe('SOURCE_CHAT_SYSTEM_PROMPT', () => {
  it('飾り記号を使わず、候補は本文に並べずに専用のブロックで出すよう指示している', () => {
    expect(SOURCE_CHAT_SYSTEM_PROMPT).toContain('マークダウン記法は使わない');
    expect(SOURCE_CHAT_SYSTEM_PROMPT).toContain('本文に列挙してはいけない');
    expect(SOURCE_CHAT_SYSTEM_PROMPT).toContain('必ず proposals フェンスを出力してから応答を終える');
  });
});

describe('replyLooksLikeSourceList', () => {
  it('URLを含む本文は候補の一覧とみなす', () => {
    expect(replyLooksLikeSourceList('候補: https://example.com/feed.xml です')).toBe(true);
    expect(replyLooksLikeSourceList('候補: http://example.com/feed.xml です')).toBe(true);
  });

  it('URLがなくても、配信形式への言及が2回以上あれば候補の一覧とみなす', () => {
    expect(replyLooksLikeSourceList('A社のRSSとB社のRSSが候補です')).toBe(true);
    expect(replyLooksLikeSourceList('Googleニュースのフィードを使うのはどうでしょう')).toBe(true);
  });

  it('URLも言及もないふつうの会話は候補の一覧とみなさない', () => {
    expect(replyLooksLikeSourceList('どんな話題を読みたいですか？')).toBe(false);
    expect(replyLooksLikeSourceList('RSSという配り方があります')).toBe(false);
  });
});

describe('parseRecoveredProposals', () => {
  it('むき出しのJSON配列を読み、オブジェクトでない要素は捨てる', () => {
    const items = parseRecoveredProposals('[{"title": "T", "url": "https://feed.example.org/f", "reason": "r"}, "str", 1]');
    expect(items).toEqual([{ title: 'T', url: 'https://feed.example.org/f', reason: 'r' }]);
  });

  it('前後に余計な文があっても、最初に閉じている配列を拾う', () => {
    const items = parseRecoveredProposals('取り出しました。\n[{"title": "T", "reason": "r"}]\nおしまい [1,2]');
    expect(items).toEqual([{ title: 'T', reason: 'r' }]);
  });

  it('壊れたJSON・配列なし・配列以外では空を返し、例外は出さない', () => {
    expect(parseRecoveredProposals('[{"title": broken]')).toEqual([]);
    expect(parseRecoveredProposals('挙げるものはありません')).toEqual([]);
    expect(parseRecoveredProposals('{"title": "obj"}')).toEqual([]);
  });
});

describe('runSourceChat（候補ブロックがないときの取り出し直し）', () => {
  const REPLY_WITH_URLS = [
    'いろいろな候補を紹介します。',
    '- サンプル園芸通信: https://garden.example.com/rss.xml',
    '- 架空料理ジャーナル: https://cooking.example.org/feed.rdf',
  ].join('\n');

  it('ブロックがなくURLがある返事は、軽いモデルで候補を取り出し直し、いつもと同じ形で返す', async () => {
    const calls: AnthropicMessageBody[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      calls.push(body);
      if (calls.length === 1) return { content: [{ type: 'text', text: REPLY_WITH_URLS }] };
      return {
        content: [{
          type: 'text',
          text: '[{"title": "サンプル園芸通信", "url": "https://garden.example.com/rss.xml", "category": "暮らし", "reason": "季節の手入れが分かる"}, {"title": "家庭菜園 道具", "keyword": "家庭菜園 道具", "category": "暮らし", "reason": "道具の話題"}]',
        }],
      };
    };
    const result = await runSourceChat(
      [{ role: 'user', content: 'もっといろいろな分野から挙げて' }],
      { createMessageFn, deep: true },
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].model).toBe(getTriageModel());
    expect(calls[1].max_tokens).toBe(2000);
    expect(calls[1].system).toBe(PROPOSAL_RECOVERY_SYSTEM_PROMPT);
    expect(calls[1].messages).toEqual([{ role: 'user', content: REPLY_WITH_URLS }]);
    expect(calls[1].tools).toBeUndefined();
    expect(result.reply).toBe(REPLY_WITH_URLS);
    expect(result.candidates).toEqual([
      { title: 'サンプル園芸通信', xmlUrl: 'https://garden.example.com/rss.xml', kind: 'rss', category: '暮らし', reason: '季節の手入れが分かる' },
      { title: '家庭菜園 道具', xmlUrl: buildGoogleNewsFeedUrl('家庭菜園 道具'), kind: 'gnews', category: '暮らし', reason: '道具の話題' },
    ]);
  });

  it('ブロックがある返事では取り出し直しをしない', async () => {
    const calls: AnthropicMessageBody[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      calls.push(body);
      return {
        content: [{
          type: 'text',
          text: 'ひとつ挙げます。\n```proposals\n[{"title": "T", "url": "https://example.com/f.xml", "reason": "r"}]\n```',
        }],
      };
    };
    const result = await runSourceChat([{ role: 'user', content: 'q' }], { createMessageFn });
    expect(calls).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  it('URLも言及もない会話では取り出し直しをしない', async () => {
    const calls: AnthropicMessageBody[] = [];
    const createMessageFn = async (body: AnthropicMessageBody) => {
      calls.push(body);
      return { content: [{ type: 'text', text: 'どんな話題を読みたいですか？' }] };
    };
    const result = await runSourceChat([{ role: 'user', content: 'はじめまして' }], { createMessageFn });
    expect(calls).toHaveLength(1);
    expect(result.candidates).toEqual([]);
  });

  it('取り出し直しの返事が壊れていても失敗にせず、候補なしで本文を返す', async () => {
    let call = 0;
    const createMessageFn = async () => {
      call++;
      if (call === 1) return { content: [{ type: 'text', text: REPLY_WITH_URLS }] };
      return { content: [{ type: 'text', text: 'すみません、[{"title": こわれた' }] };
    };
    const result = await runSourceChat([{ role: 'user', content: 'q' }], { createMessageFn });
    expect(call).toBe(2);
    expect(result.reply).toBe(REPLY_WITH_URLS);
    expect(result.candidates).toEqual([]);
  });

  it('取り出し直しの呼び出しが例外で失敗しても、その回は成功として返す', async () => {
    let call = 0;
    const createMessageFn = async () => {
      call++;
      if (call === 1) return { content: [{ type: 'text', text: REPLY_WITH_URLS }] };
      throw new Error('Anthropic API HTTP 529');
    };
    const result = await runSourceChat([{ role: 'user', content: 'q' }], { createMessageFn });
    expect(call).toBe(2);
    expect(result.reply).toBe(REPLY_WITH_URLS);
    expect(result.candidates).toEqual([]);
  });
});
