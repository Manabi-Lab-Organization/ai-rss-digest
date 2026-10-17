
import { describe, it, expect } from 'vitest';
import {
  extractUrls,
  base64DecodedBytes,
  validateAttachments,
  buildChatUserContent,
  buildChatMessages,
  runSourceChat,
  MAX_ATTACHMENTS,
  MAX_URL_TEXT_CHARS,
  SOURCE_CHAT_SYSTEM_PROMPT,
  type ChatAttachment,
} from '../sourceChat.js';
import type { AnthropicMessageBody, AnthropicContentBlockParam } from '../anthropicClient.js';

const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');

const image = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  kind: 'image',
  mediaType: 'image/png',
  dataBase64: b64(10),
  name: 'picture.png',
  ...over,
});

describe('extractUrls', () => {
  it('http と https の URL を重なりなしで3件まで取り出し、最後に付いた記号は外す', () => {
    const text = [
      'まず https://example.com/a をお願いします。',
      'それと https://example.com/a に http://example.com/b、',
      'さらに https://example.com/c) や https://example.com/d まで。',
    ].join('\n');
    expect(extractUrls(text)).toEqual([
      'https://example.com/a',
      'http://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('URL が無いときは空になり、http でも https でもないものは取り出さない', () => {
    expect(extractUrls('リンクなしの文です。ftp://example.com/f も入れない')).toEqual([]);
  });
});

describe('base64DecodedBytes', () => {
  it('末尾の埋め文字も考えて、元のバイト数を返す', () => {
    for (const n of [0, 1, 2, 3, 4, 100, 5 * 1024 * 1024]) {
      expect(base64DecodedBytes(b64(n))).toBe(n);
    }
  });
});

describe('validateAttachments', () => {
  it('添付が渡されないときや null のときは、添付なしとして受け付ける', () => {
    expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(validateAttachments(null)).toEqual({ ok: true, attachments: [] });
  });

  it('添付が4件より多いとエラーの文を返す', () => {
    const result = validateAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => image()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('添付できるファイルは最大4件までです');
  });

  it('画像は5MBまで、PDFは10MBまで受け付け、ちょうどの大きさは通し、超えるとエラーにする', () => {
    const okImage = image({ dataBase64: b64(5 * 1024 * 1024) });
    const okPdf: ChatAttachment = { kind: 'pdf', mediaType: 'application/pdf', dataBase64: b64(10 * 1024 * 1024), name: 'paper.pdf' };
    expect(validateAttachments([okImage, okPdf]).ok).toBe(true);

    const bigImage = validateAttachments([image({ dataBase64: b64(5 * 1024 * 1024 + 1) })]);
    expect(bigImage).toEqual({ ok: false, error: '画像は1枚5MB以下にしてください（picture.png）' });

    const bigPdf = validateAttachments([{ ...okPdf, dataBase64: b64(10 * 1024 * 1024 + 1) }]);
    expect(bigPdf).toEqual({ ok: false, error: 'PDFは1件10MB以下にしてください（paper.pdf）' });
  });

  it('受け付ける種類は png・jpeg・gif・webp・pdf だけで、ほかはエラーにする', () => {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(validateAttachments([image({ mediaType })]).ok).toBe(true);
    }
    const svg = validateAttachments([image({ mediaType: 'image/svg+xml', name: 'drawing.svg' })]);
    expect(svg.ok).toBe(false);
    if (!svg.ok) expect(svg.error).toContain('対応していないファイル形式です（drawing.svg）');
    expect(validateAttachments([{ kind: 'pdf', mediaType: 'image/png', dataBase64: b64(4), name: 'y' }]).ok).toBe(false);
  });

  it('中身のデータが無い添付はエラーにする', () => {
    const result = validateAttachments([{ kind: 'image', mediaType: 'image/png', name: 'empty.png' }]);
    expect(result).toEqual({ ok: false, error: '添付ファイルのデータが不正です（empty.png）' });
  });
});

describe('buildChatUserContent', () => {
  it('画像、PDF、URL の中身、利用者の文の順に並べる', () => {
    const pdf: ChatAttachment = { kind: 'pdf', mediaType: 'application/pdf', dataBase64: b64(4), name: 'paper.pdf' };
    const blocks = buildChatUserContent(
      'この二つを比べてください',
      [image(), pdf],
      [{ url: 'https://example.com/a', text: 'ページの中身' }],
    );
    expect(blocks.map((blk) => blk.type)).toEqual(['image', 'document', 'text', 'text']);
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image().dataBase64 } });
    expect(blocks[1]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.dataBase64 } });
    expect((blocks[2] as { text: string }).text).toContain('https://example.com/a');
    expect((blocks[2] as { text: string }).text).toContain('ページの中身');
    expect(blocks[3]).toEqual({ type: 'text', text: 'この二つを比べてください' });
  });

  it('URL の中身は1件ごとに決まった文字数までにする', () => {
    const blocks = buildChatUserContent('q', [], [{ url: 'https://example.com/a', text: 'x'.repeat(MAX_URL_TEXT_CHARS + 500) }]);
    const text = (blocks[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_URL_TEXT_CHARS + 100);
    expect(text.endsWith('x'.repeat(10))).toBe(true);
  });
});

describe('buildChatMessages', () => {
  it('deep が true なら、最後の利用者の発言にある URL だけを読み込み、前の発言はそのままにする', async () => {
    const fetched: string[] = [];
    const messages = [
      { role: 'user' as const, content: 'さっきの話 https://example.com/old' },
      { role: 'assistant' as const, content: 'わかりました' },
      { role: 'user' as const, content: 'こちらもお願い https://example.com/a' },
    ];
    const out = await buildChatMessages(messages, [], {
      deep: true,
      fetchArticleTextFn: async (url) => {
        fetched.push(url);
        return '読み込んだ中身';
      },
    });
    expect(fetched).toEqual(['https://example.com/a']);
    expect(out[0]).toEqual(messages[0]);
    expect(out[1]).toEqual(messages[1]);
    const content = out[2].content as AnthropicContentBlockParam[];
    expect(content.map((blk) => blk.type)).toEqual(['text', 'text']);
    expect((content[0] as { text: string }).text).toContain('読み込んだ中身');
    expect((content[1] as { text: string }).text).toBe('こちらもお願い https://example.com/a');
  });

  it('deep が true でも読み込めなかった URL は飛ばし、足すものが無ければ元の発言をそのまま返す', async () => {
    const messages = [{ role: 'user' as const, content: 'https://a.example.com/x と https://b.example.com/y' }];
    const out = await buildChatMessages(messages, [], {
      deep: true,
      fetchArticleTextFn: async (url) => {
        if (url.includes('a.example.com')) throw new Error('timeout');
        return null;
      },
    });
    expect(out).toBe(messages);
  });

  it('添付は deep でなくても加える', async () => {
    const out = await buildChatMessages([{ role: 'user', content: 'この写真をどう思う' }], [image()], {
      fetchArticleTextFn: async () => {
        throw new Error('ここは通らない');
      },
    });
    const content = out[0].content as AnthropicContentBlockParam[];
    expect(content.map((blk) => blk.type)).toEqual(['image', 'text']);
  });

  it('deep が false なら URL があっても読み込まない', async () => {
    const fetched: string[] = [];
    const messages = [{ role: 'user' as const, content: 'こちらもお願い https://example.com/a' }];
    const out = await buildChatMessages(messages, [], {
      fetchArticleTextFn: async (url) => {
        fetched.push(url);
        return '読み込んだ中身';
      },
    });
    expect(fetched).toEqual([]);
    expect(out).toBe(messages);
  });

  it('deep が false で添付と URL の両方があるときは、添付だけを加える', async () => {
    const out = await buildChatMessages(
      [{ role: 'user', content: 'この写真と https://example.com/a について' }],
      [image()],
      {
        fetchArticleTextFn: async () => {
          throw new Error('ここは通らない');
        },
      },
    );
    const content = out[0].content as AnthropicContentBlockParam[];
    expect(content.map((blk) => blk.type)).toEqual(['image', 'text']);
  });
});

describe('runSourceChat のウェブ検索の回数', () => {
  const capture = () => {
    const holder: { body?: AnthropicMessageBody } = {};
    const createMessageFn = async (body: AnthropicMessageBody) => {
      holder.body = body;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };
    return { holder, createMessageFn };
  };

  it('deep が true なら検索の上限は12回', async () => {
    const { holder, createMessageFn } = capture();
    await runSourceChat([{ role: 'user', content: 'q' }], { createMessageFn, deep: true });
    expect(holder.body?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }]);
  });

  it('deep を指定しなければ検索の上限は6回', async () => {
    const { holder, createMessageFn } = capture();
    await runSourceChat([{ role: 'user', content: 'q' }], { createMessageFn });
    expect(holder.body?.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }]);
  });
});

describe('特定の会社を追うときの提案の決まり', () => {
  it.each([
    ['sourceChat', SOURCE_CHAT_SYSTEM_PROMPT],
  ])('%s の指示文に、会社の発表とニュース検索を組で勧める決まりがある', (_name, prompt) => {
    expect(prompt).toContain('関係企業ルール');
    expect(prompt).toContain('公式ニュースリリース/IRページのRSS');
    expect(prompt).toContain('Googleニュース検索フィード');
    expect(prompt).toContain('keyword に社名');
  });
});
