
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestArticles, digestResearch } from '../../db/schema.js';
import {
  createMessage,
  messageText,
  getGenerateModel,
  type CreateMessageFn,
} from './anthropicClient.js';
import { articleHeadline } from './research.js';

export function getVisualModel(): string {
  return process.env.DIGEST_VISUAL_MODEL || getGenerateModel();
}

const MAX_TOKENS = 16000;
const MIN_HTML_CHARS = 500;

export function buildVisualPrompt(headline: string, report: string): { system: string; user: string } {
  const system = `あなたは調査レポートを1枚のビジュアルレポート（HTML）に変換するデザイナー兼フロントエンドエンジニアです。

出力（厳守）:
- 出力はHTMLだけ。<!DOCTYPE html> で始まり </html> で終える。説明文・コードフェンス・前置きを一切付けない
- 完全に自己完結させる: 外部リソース（CDN・画像・Webフォント・外部CSS/JS）を一切参照しない。CSSは<style>にインライン。JavaScriptは使わない

内容（捏造ガード・厳守）:
- テキストレポートに存在する数値・固有名詞・日付・事実だけを使う。新しい事実・数値・引用を一切加えない
- レポートの全セクションの要点を漏らさず反映する（飾りのために情報を削りすぎない）
- 末尾に「主な出典」一覧（レポート内のURL）を必ず含める

デザイン:
- レイアウトと図表の形式（KPIバンド・タイムライン・比較表・賛否パネル・番号付きセクション等）は、レポートの内容に合わせて毎回自由に構成する（固定テンプレートにしない）
- 配色は白背景・本文はダークグレー（#1e293b系）・アクセントは青（#2563eb）。この控えめなトーンから逸脱しない（派手な多色・グラデーションの乱用をしない）
- フォントはシステムフォント（sans-serif中心。見出しにserifを使ってもよい）
- スマホでも読めるレスポンシブ（最大幅800px程度の中央寄せ・表は横スクロール可に）`;

  const user = `# 見出し\n${headline}\n\n# テキストレポート（この内容だけを使う）\n${report}\n\n上記をビジュアルレポートHTMLに変換してください。`;
  return { system, user };
}

export function extractHtml(text: string): string {
  const lower = text.toLowerCase();
  const start = (() => {
    const doc = lower.indexOf('<!doctype');
    if (doc >= 0) return doc;
    return lower.indexOf('<html');
  })();
  const end = lower.lastIndexOf('</html>');
  if (start < 0 || end <= start) throw new Error('変換結果にHTMLが見つかりません');
  const html = text.slice(start, end + '</html>'.length);
  if (html.length < MIN_HTML_CHARS) throw new Error(`変換結果が短すぎます（${html.length}字）`);
  return html;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function appendTextVersion(html: string, report: string): string {
  const details = `\n<details style="max-width:800px;margin:24px auto;padding:0 16px;color:#475569;font-size:13px;">` +
    `<summary style="cursor:pointer;">テキスト版全文（内容の正はこちら）</summary>` +
    `<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.8;">${escapeHtml(report)}</pre>` +
    `</details>\n`;
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx < 0) return html + details;
  return html.slice(0, idx) + details + html.slice(idx);
}

export async function convertReportToVisual(
  headline: string,
  report: string,
  { createMessageFn = (body) => createMessage(body, { stage: 'research-visual' }) }: { createMessageFn?: CreateMessageFn } = {},
): Promise<string> {
  const { system, user } = buildVisualPrompt(headline, report);
  const res = await createMessageFn({
    model: getVisualModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const html = extractHtml(messageText(res));
  return appendTextVersion(html, report);
}

export interface RunResearchVisualResult {
  researchId: number;
  htmlLength: number;
}

export async function runResearchVisual(
  userId: number,
  researchId: number,
  { createMessageFn }: { createMessageFn?: CreateMessageFn } = {},
): Promise<RunResearchVisualResult> {
  const [row] = await db
    .select({
      id: digestResearch.id,
      status: digestResearch.status,
      report: digestResearch.report,
      articleTitle: digestArticles.title,
      articleSummary: digestArticles.summary,
    })
    .from(digestResearch)
    .leftJoin(digestArticles, eq(digestResearch.articleId, digestArticles.id))
    .where(and(eq(digestResearch.id, researchId), eq(digestResearch.userId, userId)));
  if (!row) throw new Error(`レポートが見つかりません（researchId=${researchId}）`);
  if (row.status !== 'done' || !row.report) {
    throw new Error(`レポートがまだ完成していません（status=${row.status}）`);
  }

  await db
    .update(digestResearch)
    .set({ visualStatus: 'running' })
    .where(eq(digestResearch.id, researchId));

  try {
    const headline = articleHeadline(row.articleSummary, row.articleTitle ?? '');
    const html = await convertReportToVisual(headline, row.report, { createMessageFn });
    await db
      .update(digestResearch)
      .set({ visualStatus: 'done', visualHtml: html })
      .where(eq(digestResearch.id, researchId));
    console.log(`[Digest:research-visual] 完了: research=${researchId} ${Math.round(html.length / 1024)}KB`);
    return { researchId, htmlLength: html.length };
  } catch (err) {
    await db
      .update(digestResearch)
      .set({ visualStatus: 'failed' })
      .where(eq(digestResearch.id, researchId))
      .catch(() => {});
    throw err;
  }
}
