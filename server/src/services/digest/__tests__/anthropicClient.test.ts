import { describe, it, expect, afterEach } from 'vitest';
import {
  createMessage,
  stripLoneSurrogates,
  messageText,
  setUsageSink,
  getTriageModel,
  getGenerateModel,
  getDedupeModel,
  getPremiumModel,
  isRetryableAnthropicError,
  withConversationCacheBreakpoint,
  type AnthropicMessage,
  type FetchLike,
} from '../anthropicClient.js';

function mockFetch(status: number, json: unknown) {
  const calls: Array<{ url: string; options: Parameters<FetchLike>[1] }> = [];
  const fn: FetchLike = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };
  return { fn, calls };
}

describe('createMessage', () => {
  it('送信先・認証ヘッダー・本文が期待どおりで、応答の文字を取り出せる', async () => {
    const { fn, calls } = mockFetch(200, { content: [{ type: 'text', text: 'ok' }] });
    const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [] };
    const res = await createMessage(body, { apiKey: 'test-key', fetchFn: fn });
    const call = calls[0];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.options.headers['x-api-key']).toBe('test-key');
    expect(call.options.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(call.options.body)).toEqual(body);
    expect(messageText(res)).toBe('ok');
  });

  it('キーが渡されていなければ失敗する', async () => {
    const { fn } = mockFetch(200, {});
    await expect(
      createMessage({ model: 'm', max_tokens: 1, messages: [] }, { apiKey: undefined, fetchFn: fn }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('成功以外の応答コードなら、そのコードを含めて失敗する', async () => {
    const { fn } = mockFetch(429, { error: 'rate_limit' });
    await expect(
      createMessage({ model: 'm', max_tokens: 1, messages: [] }, { apiKey: 'k', fetchFn: fn }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it('使用量が返ってきたら、段階名・モデル・トークン数をログに出す', async () => {
    const { fn } = mockFetch(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    const logs: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      await createMessage(
        { model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [] },
        { apiKey: 'k', fetchFn: fn, stage: 'triage' },
      );
    } finally {
      console.log = original;
    }
    const usageLog = logs.find((args) => args[0] === '[Digest:usage]');
    expect(usageLog).toBeDefined();
    expect(JSON.parse(String(usageLog?.[1]))).toEqual({
      stage: 'triage',
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 12,
      outputTokens: 34,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('Web検索の回数は、通常の使用量とは別の記録として受け取り先に渡す', async () => {
    const { fn } = mockFetch(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 6 } },
    });
    const events: unknown[] = [];
    setUsageSink((u) => events.push(u));
    try {
      await createMessage(
        { model: 'claude-sonnet-5', max_tokens: 10, messages: [] },
        { apiKey: 'k', fetchFn: fn, stage: 'research' },
      );
    } finally {
      setUsageSink(null);
    }
    expect(events).toEqual([
      {
        stage: 'research', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      },
      { stage: 'research', model: 'web_search', inputTokens: 6, outputTokens: 0 },
    ]);
  });

  it('キャッシュの書き込み・読み出しのトークン数も受け取り先に渡す', async () => {
    const { fn } = mockFetch(200, {
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 30000,
      },
    });
    const events: unknown[] = [];
    setUsageSink((u) => events.push(u));
    try {
      await createMessage(
        { model: 'claude-opus-4-8', max_tokens: 10, messages: [] },
        { apiKey: 'k', fetchFn: fn, stage: 'source-chat' },
      );
    } finally {
      setUsageSink(null);
    }
    expect(events).toEqual([{
      stage: 'source-chat',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 30000,
    }]);
  });
});

describe('messageText', () => {
  it('文字のブロックだけをつなげて返す', () => {
    const res = {
      content: [
        { type: 'thinking', text: 'x' },
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    };
    expect(messageText(res)).toBe('ab');
  });
});

describe('使うモデルの決め方', () => {
  const saved = {
    triage: process.env.DIGEST_TRIAGE_MODEL,
    generate: process.env.DIGEST_GENERATE_MODEL,
    dedupe: process.env.DIGEST_DEDUPE_MODEL,
  };

  afterEach(() => {
    if (saved.triage === undefined) delete process.env.DIGEST_TRIAGE_MODEL;
    else process.env.DIGEST_TRIAGE_MODEL = saved.triage;
    if (saved.generate === undefined) delete process.env.DIGEST_GENERATE_MODEL;
    else process.env.DIGEST_GENERATE_MODEL = saved.generate;
    if (saved.dedupe === undefined) delete process.env.DIGEST_DEDUPE_MODEL;
    else process.env.DIGEST_DEDUPE_MODEL = saved.dedupe;
  });

  it('何も設定しなければ、それぞれの用途の既定のモデルになる', () => {
    delete process.env.DIGEST_TRIAGE_MODEL;
    delete process.env.DIGEST_GENERATE_MODEL;
    delete process.env.DIGEST_DEDUPE_MODEL;
    delete process.env.DIGEST_PREMIUM_MODEL;
    expect(getTriageModel()).toBe('claude-haiku-4-5-20251001');
    expect(getGenerateModel()).toBe('claude-sonnet-5');
    expect(getDedupeModel()).toBe(getTriageModel());
    expect(getPremiumModel()).toBe('claude-opus-4-8');
  });

  it('上位モデルは設定で差し替えられる', () => {
    process.env.DIGEST_PREMIUM_MODEL = 'premium-model-x';
    expect(getPremiumModel()).toBe('premium-model-x');
    delete process.env.DIGEST_PREMIUM_MODEL;
  });

  it('設定で差し替えられ、重複判定用は選別用の設定に合わせて変わる', () => {
    process.env.DIGEST_TRIAGE_MODEL = 'triage-model-x';
    process.env.DIGEST_GENERATE_MODEL = 'generate-model-x';
    delete process.env.DIGEST_DEDUPE_MODEL;
    expect(getTriageModel()).toBe('triage-model-x');
    expect(getGenerateModel()).toBe('generate-model-x');
    expect(getDedupeModel()).toBe('triage-model-x');
    process.env.DIGEST_DEDUPE_MODEL = 'dedupe-model-x';
    expect(getDedupeModel()).toBe('dedupe-model-x');
  });
});

describe('isRetryableAnthropicError', () => {
  it('通信そのものの失敗はやり直す', () => {
    expect(isRetryableAnthropicError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableAnthropicError(new Error('read ETIMEDOUT'))).toBe(true);
    expect(isRetryableAnthropicError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableAnthropicError(new Error('ECONNRESET'))).toBe(true);
  });

  it('混雑・時間切れ・相手側の不調を示すコードはやり直す', () => {
    for (const st of [408, 429, 500, 502, 503, 529]) {
      expect(isRetryableAnthropicError(new Error(`Anthropic API HTTP ${st}: x`))).toBe(true);
    }
  });

  it('送った側の誤りを示すコードはやり直さない', () => {
    for (const st of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableAnthropicError(new Error(`Anthropic API HTTP ${st}: x`))).toBe(false);
    }
  });

  it('原因が見分けられない失敗はやり直す', () => {
    expect(isRetryableAnthropicError(new Error('JSON配列が見つかりません'))).toBe(true);
    expect(isRetryableAnthropicError('うまくいきませんでした')).toBe(true);
    expect(isRetryableAnthropicError(undefined)).toBe(true);
  });
});

describe('withConversationCacheBreakpoint', () => {
  it('やり取りが一往復に満たない会話には目印を付けない', () => {
    const one: AnthropicMessage[] = [{ role: 'user', content: 'はじめまして' }];
    expect(withConversationCacheBreakpoint(one)).toBe(one);
    const two: AnthropicMessage[] = [
      { role: 'user', content: 'はじめまして' },
      { role: 'assistant', content: '気になっている話題を教えてください。' },
    ];
    expect(withConversationCacheBreakpoint(two)).toBe(two);
  });

  it('最新の発言のひとつ前にだけ目印を付け、元の配列は変えない', () => {
    const msgs: AnthropicMessage[] = [
      { role: 'user', content: '園芸の新しい道具について知りたい' },
      { role: 'assistant', content: '室内向けと屋外向け、どちらが気になりますか？' },
      { role: 'user', content: '室内向けでお願いします' },
    ];
    const out = withConversationCacheBreakpoint(msgs);
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '室内向けと屋外向け、どちらが気になりますか？', cache_control: { type: 'ephemeral' } }],
    });
    expect(out[0]).toEqual(msgs[0]);
    expect(out[2]).toEqual(msgs[2]);
    expect(msgs[1].content).toBe('室内向けと屋外向け、どちらが気になりますか？');
  });

  it('ブロックが複数あるときは最後の文字ブロックだけに目印を付ける', () => {
    const msgs: AnthropicMessage[] = [
      { role: 'user', content: 'この表を読んで' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ひとつめ' },
          { type: 'text', text: 'ふたつめ' },
        ],
      },
      { role: 'user', content: 'その先も' },
    ];
    const out = withConversationCacheBreakpoint(msgs);
    expect(out[1].content).toEqual([
      { type: 'text', text: 'ひとつめ' },
      { type: 'text', text: 'ふたつめ', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('最後のブロックが画像などの場合は目印を付けない', () => {
    const msgs: AnthropicMessage[] = [
      { role: 'user', content: 'これは何？' },
      {
        role: 'assistant',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
      },
      { role: 'user', content: 'その先も' },
    ];
    expect(withConversationCacheBreakpoint(msgs)).toBe(msgs);
  });
});

describe('stripLoneSurrogates', () => {
  const LONE_HIGH = '\uD83D';
  const LONE_LOW = '\uDE00';

  it('対になった絵文字はそのまま残す', () => {
    expect(stripLoneSurrogates('こんにちは😀ね')).toBe('こんにちは😀ね');
  });

  it('対になっていない片割れの文字を取り除く', () => {
    expect(stripLoneSurrogates(`お知らせ${LONE_HIGH}です`)).toBe('お知らせです');
    expect(stripLoneSurrogates(`お知らせ${LONE_LOW}です`)).toBe('お知らせです');
  });

  it('入れ子になったオブジェクトや配列の中も取り除く', () => {
    const body = {
      model: 'x',
      messages: [{ role: 'user', content: `文章${LONE_HIGH}` }],
      system: `指示${LONE_LOW}`,
    };
    const cleaned = stripLoneSurrogates(body) as typeof body;
    expect(cleaned.messages[0].content).toBe('文章');
    expect(cleaned.system).toBe('指示');
    expect(cleaned.model).toBe('x');
  });

  it('取り除いた後はJSONにして戻しても同じ内容になる', () => {
    const dirty = { text: `欠けた文字${LONE_HIGH}` };
    expect(JSON.stringify(dirty)).toContain('\\ud83d');
    const json = JSON.stringify(stripLoneSurrogates(dirty));
    expect(json).not.toContain('\\ud83d');
    expect(JSON.parse(json)).toEqual({ text: '欠けた文字' });
  });

  it('数値・真偽値・null は変えずに返す', () => {
    expect(stripLoneSurrogates(42)).toBe(42);
    expect(stripLoneSurrogates(true)).toBe(true);
    expect(stripLoneSurrogates(null)).toBe(null);
  });

  it('createMessage は送る前に片割れの文字を取り除いている', async () => {
    const { fn, calls } = mockFetch(200, { content: [{ type: 'text', text: 'ok' }] });
    await createMessage(
      {
        model: 'm',
        max_tokens: 1,
        messages: [{ role: 'user', content: `記事の終わり${LONE_HIGH}` }] as AnthropicMessage[],
      },
      { apiKey: 'k', fetchFn: fn },
    );
    const sent = calls[0].options.body as string;
    expect(sent).not.toContain('\\ud83d');
    expect(() => JSON.parse(sent)).not.toThrow();
    expect(JSON.parse(sent).messages[0].content).toBe('記事の終わり');
  });
});
