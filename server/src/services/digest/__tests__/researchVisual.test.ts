import { describe, expect, it } from 'vitest';
import {
  buildVisualPrompt,
  extractHtml,
  appendTextVersion,
  convertReportToVisual,
  getVisualModel,
} from '../researchVisual.js';
import type { AnthropicMessageBody } from '../anthropicClient.js';

const SAMPLE_HTML =
  '<!DOCTYPE html><html><head><style>body{color:#1e293b}</style></head><body>' +
  '<h1>架空の港町の朝市</h1><p>新鮮な魚が並ぶ。</p>'.repeat(30) +
  '</body></html>';

describe('buildVisualPrompt', () => {
  it('事実を足さない・外部ファイルを使わない・配色の指示が入り、見出しと本文が渡る', () => {
    const { system, user } = buildVisualPrompt('サンプル見出し', 'サンプル本文');
    expect(system).toContain('新しい事実・数値・引用を一切加えない');
    expect(system).toContain('外部リソース');
    expect(system).toContain('#2563eb');
    expect(user).toContain('サンプル見出し');
    expect(user).toContain('サンプル本文');
  });
});

describe('extractHtml', () => {
  it('説明文やコードブロックの囲みを除いて HTML だけを返す', () => {
    const wrapped = 'できあがりました。\n```html\n' + SAMPLE_HTML + '\n```\n以上です。';
    expect(extractHtml(wrapped)).toBe(SAMPLE_HTML);
  });

  it('HTML が含まれない、または短すぎるときは例外を投げる', () => {
    expect(() => extractHtml('作れませんでした')).toThrow();
    expect(() => extractHtml('<html><body>少し</body></html>')).toThrow(/短すぎ/);
  });
});

describe('appendTextVersion', () => {
  it('文字だけの版をエスケープして </body> の前に details 要素で入れる', () => {
    const out = appendTextVersion(SAMPLE_HTML, '本文 <script>alert(1)</script>');
    expect(out).toContain('テキスト版全文');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>alert');
    expect(out.indexOf('テキスト版全文')).toBeLessThan(out.toLowerCase().lastIndexOf('</body>'));
  });

  it('</body> が無いときは末尾に追加する', () => {
    const out = appendTextVersion('<html>x</html>', 'サンプル');
    expect(out.endsWith('</details>\n')).toBe(true);
  });
});

describe('convertReportToVisual', () => {
  it('ツールを付けずに図解用のモデルを呼び、取り出した HTML に文字だけの版を足して返す', async () => {
    let captured: AnthropicMessageBody | undefined;
    const createMessageFn = async (body: AnthropicMessageBody) => {
      captured = body;
      return { content: [{ type: 'text', text: '```html\n' + SAMPLE_HTML + '\n```' }] };
    };
    const out = await convertReportToVisual('架空の港町の朝市', '朝市についての調べた内容', { createMessageFn });
    expect(captured?.model).toBe(getVisualModel());
    expect(captured?.tools).toBeUndefined();
    expect(out).toContain('<h1>架空の港町の朝市</h1>');
    expect(out).toContain('朝市についての調べた内容');
    expect(out).toContain('テキスト版全文');
  });
});
