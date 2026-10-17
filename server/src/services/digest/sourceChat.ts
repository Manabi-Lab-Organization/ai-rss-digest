
import { clampDocumentText, decodeTextFile, extractDocxText } from './documentText.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestFeeds, digestSourceProposals } from '../../db/schema.js';
import {
  createMessage,
  messageText,
  getGenerateModel,
  getPremiumModel,
  getTriageModel,
  withConversationCacheBreakpoint,
  type AnthropicMessage,
  type AnthropicContentBlockParam,
  type AnthropicTextBlockParam,
  type CreateMessageFn,
} from './anthropicClient.js';
import { buildGoogleNewsFeedUrl } from './gnews.js';
import { fetchFeed } from './rss.js';
import { fetchArticleText } from './fetchArticle.js';
import { firstBalancedArray } from './triage.js';
import { coverageFactsForUserSafe } from './coverage.js';

const MAX_TOKENS = 4000;
const RECOVERY_MAX_TOKENS = 2000;
const MAX_WEB_SEARCHES = 6;
const MAX_WEB_SEARCHES_DEEP = 12;
export const MAX_PROPOSALS_PER_TURN = 12;

export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_MESSAGE_CHARS = 20_000;
export const MAX_URLS_PER_MESSAGE = 3;
export const MAX_URL_TEXT_CHARS = 4000;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const SOURCE_CHAT_SYSTEM_PROMPT = `あなたは「AI RSS Digest」の編集長AIです。
「AI RSS Digest」は読者一人ひとりのための情報ダイジェスト紙で、登録された情報源（RSSフィード / Googleニュース検索キーワード）から毎朝の紙面を自動編集します。
あなたの仕事は、読者の関心・仕事・追いたいテーマを会話で聞き取り、それを継続的に追うのに適した情報源を探して提案することです。

ルール（厳守）:
- 【最重要】「調べてみます」「探してみます」と宣言だけして応答を終えてはいけない。この会話に「あとで続きをやる」仕組みはなく、あなたの応答が終わった瞬間にすべての処理が止まる。情報源を探すと決めたら、同じ応答の中でWeb検索を実行し、proposals フェンスの提案まで出し切ってから応答を終える。例外は、提案の前に読者へ確認したいことがある場合のみ（そのときは具体的な質問で応答を終える）
- 提案には必ず「なぜこの情報源がその関心に合うか」の理由を付ける
- RSSフィードのURLは実在が確実なもののみ提案する（Web検索で実在を確認する。推測でURLをでっち上げない）
- 【信頼性基準・厳守】提案してよいのは信頼できる定評ある情報源のみ（大手報道機関・経済紙、業界で広く認知された専門メディア、政府・国際機関・業界団体・上場企業の公式発信、著名な調査会社）。個人ブログ・まとめサイト・アフィリエイトサイト・信頼性を確認できないサイトは提案しない
- 特定サイトの良いRSSが見つからないテーマは、Googleニュース検索のキーワード購読（kind: "gnews"）として提案する。その場合は url の代わりに keyword を返す
- 一度に提案するのは多くても10件。ただし出し惜しみもしない: 信頼性基準を満たす良い候補が見つかる限り、上限近くまで提案する
- 幅と創造力を持たせる: 企業・業界/市場・知識領域の3層、国内/海外、報道/一次情報（政府・業界団体）/調査データといった異なる角度を組み合わせて探す。読者が自分では思いつかないであろう情報源も1〜2件混ぜる（その場合は「なぜ役立つか」の理由を特に丁寧に書く）
- 数合わせはしない: 関連の薄い候補で埋めるくらいなら件数が少ない方がよい
- 提案はあなたが登録するのではなく、読者が承認して初めて登録される。会話でも「承認していただくと収集が始まります」という旨を明示する
- 会話は日本語で、簡潔かつ具体的に。読者の関心がまだ曖昧なら、提案の前に1〜2個の質問で絞り込んでよい
- 応答本文は会話調のプレーンテキストで書く。**太字**や見出し・記号による装飾などのマークダウン記法は使わない
- 情報源の候補（RSSのURLや検索キーワード）を応答本文に列挙してはいけない。候補は必ず応答末尾の proposals フェンスに入れる。フェンスに入れた候補の名前と理由の要約だけ本文で軽く触れてよい（URLは本文に書かない）
- 長い調査を行ったターンでも、候補があれば必ず proposals フェンスを出力してから応答を終える
- 添付資料（画像・PDF）やURLの内容（参考資料）が渡された場合は、その内容を分析して読者の関心・関係する企業・業界を読み取り、情報源の提案に反映する（資料の内容の要約を返答に含めてもよい）
- 【関係企業ルール】会話や添付資料から、読者が仕事で深く関わる特定の企業（読者が売り込み先・仕入れ先などとして挙げた企業）が分かったら、次の2点を必ずセットで提案する:
  ① その企業の公式ニュースリリース/IRページのRSS（Web検索で実在確認できた場合のみ。プレスリリース配信サービスにある企業別ページのRSS等でもよい）
  ② 社名のGoogleニュース検索フィード（kind: "gnews"、keyword に社名を指定）
  ただし対象は読者にとって最も重要な企業1〜2社に絞る。話に出た企業を片端からセット提案して、提案枠を企業だけで埋めない

提案の出力形式（厳守）:
- 情報源を提案するターンでは、応答本文の末尾に次の形式のコードフェンスを1つだけ出力する:
\`\`\`proposals
[{"title": "情報源の名前", "url": "RSSフィードのURL（http から始まる。keywordと排他）", "keyword": "検索キーワード（urlと排他）", "category": "分類（例: 食品業界）", "reason": "この情報源を提案する理由"}]
\`\`\`
- 提案がない会話ターン（質問への回答・絞り込みの質問など）では proposals フェンスを出力しない
- フェンス内は正しいJSON配列のみ。フェンスの外の本文では、提案内容を読者向けの言葉で説明する`;

export interface RawProposalItem {
  title?: unknown;
  url?: unknown;
  keyword?: unknown;
  category?: unknown;
  reason?: unknown;
}

export interface ProposalCandidate {
  title: string;
  xmlUrl: string;
  kind: 'rss' | 'gnews';
  category: string | null;
  reason: string;
}

const FENCE_RE = /```proposals\s*\n?([\s\S]*?)```/g;

export function parseProposalsFence(reply: string): { cleanReply: string; items: RawProposalItem[] } {
  const matches = [...reply.matchAll(FENCE_RE)];
  if (matches.length === 0) return { cleanReply: reply.trim(), items: [] };

  const cleanReply = reply.replace(FENCE_RE, '').trim();
  const jsonText = matches[matches.length - 1][1];
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return { cleanReply, items: [] };
    return { cleanReply, items: parsed.filter((it): it is RawProposalItem => Boolean(it) && typeof it === 'object') };
  } catch {
    return { cleanReply, items: [] };
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function normalizeProposalItems(items: RawProposalItem[]): ProposalCandidate[] {
  const out: ProposalCandidate[] = [];
  for (const it of items) {
    if (out.length >= MAX_PROPOSALS_PER_TURN) break;
    const title = str(it.title);
    const reason = str(it.reason);
    const keyword = str(it.keyword);
    const url = str(it.url);
    if (!title || !reason) continue;

    if (keyword) {
      out.push({ title, xmlUrl: buildGoogleNewsFeedUrl(keyword), kind: 'gnews', category: str(it.category) || null, reason });
    } else if (url && /^https?:\/\//.test(url)) {
      out.push({ title, xmlUrl: url, kind: 'rss', category: str(it.category) || null, reason });
    }
  }
  return out;
}

export function filterNewProposals(candidates: ProposalCandidate[], existingUrls: Set<string>): ProposalCandidate[] {
  const seen = new Set(existingUrls);
  const out: ProposalCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.xmlUrl)) continue;
    seen.add(c.xmlUrl);
    out.push(c);
  }
  return out;
}

export interface ChatAttachment {
  kind: 'image' | 'pdf' | 'text';
  mediaType: string;
  dataBase64: string;
  name: string;
  text?: string;
}

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function base64DecodedBytes(b64: string): number {
  const s = b64.replace(/\s+/g, '');
  if (s.length === 0) return 0;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

export type AttachmentValidationResult =
  | { ok: true; attachments: ChatAttachment[] }
  | { ok: false; error: string };

export function validateAttachments(input: unknown): AttachmentValidationResult {
  if (input == null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'attachments は配列で指定してください' };
  if (input.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `添付できるファイルは最大${MAX_ATTACHMENTS}件までです` };
  }
  const out: ChatAttachment[] = [];
  for (const raw of input) {
    const a = raw as { kind?: unknown; mediaType?: unknown; dataBase64?: unknown; name?: unknown };
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : 'ファイル';
    if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0 || typeof a.mediaType !== 'string') {
      return { ok: false, error: `添付ファイルのデータが不正です（${name}）` };
    }
    const bytes = base64DecodedBytes(a.dataBase64);
    if (a.kind === 'image' && ALLOWED_IMAGE_TYPES.has(a.mediaType)) {
      if (bytes > MAX_IMAGE_BYTES) return { ok: false, error: `画像は1枚5MB以下にしてください（${name}）` };
      out.push({ kind: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64, name });
    } else if (a.kind === 'pdf' && a.mediaType === 'application/pdf') {
      if (bytes > MAX_PDF_BYTES) return { ok: false, error: `PDFは1件10MB以下にしてください（${name}）` };
      out.push({ kind: 'pdf', mediaType: a.mediaType, dataBase64: a.dataBase64, name });
    } else if (
      (a.kind === 'text' && (TEXT_TYPES.has(a.mediaType) || /\.(txt|md|markdown)$/i.test(name)))
      || (a.kind === 'docx' && (a.mediaType === DOCX_TYPE || /\.docx$/i.test(name)))
    ) {
      if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, error: `テキスト・Word のファイルは1件5MB以下にしてください（${name}）` };
      const buf = Buffer.from(a.dataBase64, 'base64');
      const text = a.kind === 'docx' ? extractDocxText(buf) : decodeTextFile(buf);
      if (text == null) return { ok: false, error: `Word のファイルを読み取れませんでした（${name}）。.docx 形式で保存し直してください` };
      if (!text.trim()) return { ok: false, error: `ファイルに文字がありません（${name}）` };
      out.push({ kind: 'text', mediaType: 'text/plain', dataBase64: '', name, text: clampDocumentText(text) });
    } else {
      return {
        ok: false,
        error: `対応していないファイル形式です（${name}）。画像（PNG/JPEG/GIF/WebP）・PDF・テキスト（.txt/.md）・Word（.docx）を添付できます`,
      };
    }
  }
  return { ok: true, attachments: out };
}

export function extractUrls(text: string, max: number = MAX_URLS_PER_MESSAGE): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'）」】]+/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const url = m.replace(/[).,、。]+$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

export function buildChatUserContent(
  text: string,
  attachments: ChatAttachment[],
  urlContents: Array<{ url: string; text: string }>,
): AnthropicContentBlockParam[] {
  const blocks: AnthropicContentBlockParam[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 } });
    } else if (a.kind === 'text') {
      blocks.push({ type: 'text', text: `添付ファイルの内容（${a.name}）:\n${a.text ?? ''}` });
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.dataBase64 } });
    }
  }
  for (const u of urlContents) {
    blocks.push({
      type: 'text',
      text: `添付URLの内容（参考資料）: ${u.url}\n${u.text.slice(0, MAX_URL_TEXT_CHARS)}`,
    });
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

type FetchArticleTextFn = (url: string) => Promise<string | null>;

export async function buildChatMessages(
  messages: AnthropicMessage[],
  attachments: ChatAttachment[],
  { deep = false, fetchArticleTextFn = fetchArticleText }: { deep?: boolean; fetchArticleTextFn?: FetchArticleTextFn } = {},
): Promise<AnthropicMessage[]> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') return messages;

  const urls = deep ? extractUrls(last.content) : [];
  const results = await Promise.allSettled(urls.map((u) => fetchArticleTextFn(u)));
  const urlContents: Array<{ url: string; text: string }> = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && typeof r.value === 'string' && r.value.length > 0) {
      urlContents.push({ url: urls[i], text: r.value });
    }
  });
  if (attachments.length === 0 && urlContents.length === 0) return messages;

  return [
    ...messages.slice(0, -1),
    { role: 'user', content: buildChatUserContent(last.content, attachments, urlContents) },
  ];
}

export const PROPOSAL_RECOVERY_SYSTEM_PROMPT = `あなたはアシスタントの返答テキストから情報源の候補を抽出する係です。
渡されたテキストを読み、そこに列挙されている情報源の候補（RSSフィード / Googleニュース検索キーワード）だけを、次の形のJSON配列で出力してください:
[{"title": "情報源の名前", "url": "RSSフィードのURL（http から始まる。keywordと排他）", "keyword": "検索キーワード（urlと排他）", "category": "分類（例: 食品業界）", "reason": "この情報源を提案する理由"}]
ルール（厳守）:
- 出力はJSON配列のみ。コードフェンスや説明文を一切付けない
- テキストに書かれている候補だけを抽出する（新しい候補を発明しない）
- 実在が怪しいURL・テキスト中に無いURLは含めない
- 候補が無ければ [] を出力する`;

export function replyLooksLikeSourceList(reply: string): boolean {
  if (/https?:\/\//.test(reply)) return true;
  const mentions = reply.match(/RSS|フィード|Googleニュース/g)?.length ?? 0;
  return mentions >= 2;
}

export function parseRecoveredProposals(text: string): RawProposalItem[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    const balanced = firstBalancedArray(text);
    if (!balanced) return [];
    try {
      parsed = JSON.parse(balanced);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((it): it is RawProposalItem => Boolean(it) && typeof it === 'object');
}

export interface SourceChatResult {
  reply: string;
  candidates: ProposalCandidate[];
}

export interface ExistingSourceSummary {
  title: string;
  category: string | null;
  kind: string;
}

export function buildChatSystemPrompt(
  existingSources: ExistingSourceSummary[] = [],
  proposedTitles: string[] = [],
  coverageFacts = '',
): AnthropicTextBlockParam[] {
  const parts: string[] = [];

  if (coverageFacts.trim()) {
    parts.push([
      '# 参考情報: 読者の直近の紙面の実績（実測）',
      coverageFacts.trim(),
      '',
      '実績の使い方（厳守）:',
      '- 紙面の偏り・重複・再出現について読者が触れたら、この数字を根拠に答える。数字に無いことは断定しない',
      '- 面の本数が少ない・特定の出典に寄っている、といった偏りが見えるときは、その面や角度を埋める情報源を優先して提案する',
      '- 読者が紙面の話をしていないときに、この数字を無理に持ち出さない',
    ].join('\n'));
  }

  if (existingSources.length > 0 || proposedTitles.length > 0) {
    const kindLabel = (k: string) => (k === 'gnews' ? 'Googleニュース検索' : 'RSS');
    parts.push([
      '# 参考情報: 読者の登録済みの情報源一覧',
      ...existingSources.map(
        (s) => `- ${s.title}（${s.category ? `分類: ${s.category} / ` : ''}${kindLabel(s.kind)}）`,
      ),
      ...(proposedTitles.length > 0
        ? [`提案済みで未回答の候補: ${proposedTitles.join('、')}`]
        : []),
      '',
      '登録済み一覧の使い方（厳守）:',
      '- 一覧や提案済み候補と同じ媒体・実質同じ切り口の提案はしない（重複はサーバー側で除外され、読者には件数が減って見えるだけ）',
      '- 提案の前に一覧の構成を軸別に見立てる: 企業由来（IR・社名のニュース検索）/業界・市場/技術・知識領域/手法・思考法/データ・統計/規制・制度 のどれが手薄かを判断し、手薄な軸を優先して埋める',
      '- 既存が特定の軸（例: データ・統計）に偏っているなら、提案は既存と違う切り口を中心にする。読者が求めているのは登録済みの延長ではなく、まだカバーできていない角度である',
    ].join('\n'));
  }

  const shared: AnthropicTextBlockParam = {
    type: 'text',
    text: SOURCE_CHAT_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  };
  if (parts.length === 0) return [shared];
  return [shared, { type: 'text', text: parts.join('\n\n') }];
}

export function replyPromisesWorkWithoutResult(reply: string, candidateCount: number): boolean {
  if (candidateCount > 0) return false;
  const trimmed = reply.trim();
  if (trimmed === '' || /[?？]\s*$/.test(trimmed)) return false;
  return /(調べ|探し|検索し|調査し|確認し)(て(み)?)?ま(す|しょう)|お待ちください/.test(trimmed.slice(-200));
}

export const CONTINUE_NUDGE =
  '（システムからの自動催促: この会話に後続処理はありません。直前に宣言した調査をいまこのターンで実行し、' +
  '候補があれば proposals フェンスまで出し切ってください。読者に確認したいことがある場合だけ、具体的な質問で終えてください）';

export async function runSourceChat(
  messages: AnthropicMessage[],
  {
    createMessageFn = (body) => createMessage(body, { stage: 'source-chat' }),
    deep = false,
    premium = false,
    existingSources = [],
    proposedTitles = [],
    coverageFacts = '',
  }: {
    createMessageFn?: CreateMessageFn;
    deep?: boolean;
    premium?: boolean;
    existingSources?: ExistingSourceSummary[];
    proposedTitles?: string[];
    coverageFacts?: string;
  } = {},
): Promise<SourceChatResult> {
  const system = buildChatSystemPrompt(existingSources, proposedTitles, coverageFacts);
  const callOnce = async (msgs: AnthropicMessage[]): Promise<SourceChatResult> => {
    const response = await createMessageFn({
      model: premium ? getPremiumModel() : getGenerateModel(),
      max_tokens: MAX_TOKENS,
      system,
      messages: withConversationCacheBreakpoint(msgs),
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: deep ? MAX_WEB_SEARCHES_DEEP : MAX_WEB_SEARCHES,
      }],
    });
    const { cleanReply, items } = parseProposalsFence(messageText(response));
    let candidates = normalizeProposalItems(items);

    if (candidates.length === 0 && replyLooksLikeSourceList(cleanReply)) {
      try {
        const recovered = await createMessageFn({
          model: getTriageModel(),
          max_tokens: RECOVERY_MAX_TOKENS,
          system: PROPOSAL_RECOVERY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: cleanReply }],
        });
        candidates = normalizeProposalItems(parseRecoveredProposals(messageText(recovered)));
        if (candidates.length > 0) {
          console.log(`[Digest:source-chat] フェンス欠落をリカバリ抽出で回収（${candidates.length}件）`);
        }
      } catch (err) {
        console.log(`[Digest:source-chat] リカバリ抽出に失敗（続行）: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { reply: cleanReply, candidates };
  };

  const first = await callOnce(messages);
  if (!replyPromisesWorkWithoutResult(first.reply, first.candidates.length)) return first;

  console.log('[Digest:source-chat] 宣言だけの応答を検知 → 同一リクエスト内で続行させる');
  try {
    const cont = await callOnce([
      ...messages,
      { role: 'assistant', content: first.reply },
      { role: 'user', content: CONTINUE_NUDGE },
    ]);
    if (cont.reply === '' && cont.candidates.length === 0) return first;
    return {
      reply: [first.reply, cont.reply].filter(Boolean).join('\n\n'),
      candidates: cont.candidates,
    };
  } catch (err) {
    console.log(`[Digest:source-chat] 続行に失敗（最初の応答を返す）: ${err instanceof Error ? err.message : String(err)}`);
    return first;
  }
}

export interface InsertedProposal {
  id: number;
  title: string;
  xmlUrl: string;
  kind: string;
  category: string | null;
  reason: string;
  status: string;
}

export interface ChatTurnResult {
  reply: string;
  proposals: InsertedProposal[];
}

type FetchFeedFn = (xmlUrl: string) => Promise<unknown>;

export async function chatTurn(
  userId: number,
  messages: AnthropicMessage[],
  {
    createMessageFn,
    fetchFeedFn = (xmlUrl) => fetchFeed(xmlUrl),
    fetchArticleTextFn,
    deep = false,
    premium = false,
    attachments = [],
    collectCoverageFn = coverageFactsForUserSafe,
  }: {
    createMessageFn?: CreateMessageFn;
    fetchFeedFn?: FetchFeedFn;
    fetchArticleTextFn?: FetchArticleTextFn;
    deep?: boolean;
    premium?: boolean;
    attachments?: ChatAttachment[];
    collectCoverageFn?: (userId: number) => Promise<string>;
  } = {},
): Promise<ChatTurnResult> {
  const coverageFacts = await collectCoverageFn(userId).catch(() => '');

  const feedRows = await db
    .select({
      title: digestFeeds.title,
      xmlUrl: digestFeeds.xmlUrl,
      category: digestFeeds.category,
      kind: digestFeeds.kind,
    })
    .from(digestFeeds)
    .where(eq(digestFeeds.userId, userId));
  const proposalRows = await db
    .select({ title: digestSourceProposals.title, xmlUrl: digestSourceProposals.xmlUrl })
    .from(digestSourceProposals)
    .where(and(
      eq(digestSourceProposals.userId, userId),
      inArray(digestSourceProposals.status, ['proposed', 'approved']),
    ));

  const prepared = await buildChatMessages(messages, attachments, { deep, fetchArticleTextFn });
  const { reply, candidates } = await runSourceChat(prepared, {
    createMessageFn,
    deep,
    premium,
    existingSources: feedRows.map((f) => ({ title: f.title, category: f.category, kind: f.kind })),
    proposedTitles: proposalRows.map((p) => p.title),
    coverageFacts,
  });
  if (candidates.length === 0) return { reply, proposals: [] };

  const existing = new Set([...feedRows, ...proposalRows].map((r) => r.xmlUrl));
  const fresh = filterNewProposals(candidates, existing);

  const checks = await Promise.allSettled(fresh.map((c) => fetchFeedFn(c.xmlUrl)));
  const alive = fresh.filter((_, i) => checks[i].status === 'fulfilled');
  const dead = fresh.length - alive.length;
  if (dead > 0) console.log(`[Digest:source-chat] 生存確認で${dead}件の提案を除外（user=${userId}）`);

  const proposals: InsertedProposal[] = [];
  for (const c of alive) {
    const [inserted] = await db
      .insert(digestSourceProposals)
      .values({
        userId,
        origin: 'chat',
        title: c.title,
        xmlUrl: c.xmlUrl,
        kind: c.kind,
        category: c.category,
        reason: c.reason,
        status: 'proposed',
      })
      .returning({
        id: digestSourceProposals.id,
        title: digestSourceProposals.title,
        xmlUrl: digestSourceProposals.xmlUrl,
        kind: digestSourceProposals.kind,
        category: digestSourceProposals.category,
        reason: digestSourceProposals.reason,
        status: digestSourceProposals.status,
      });
    if (inserted) proposals.push(inserted);
  }

  const removed = candidates.length - proposals.length;
  if (removed > 0 && proposals.length > 0) {
    return {
      reply: `${reply}\n\n（候補のうち${removed}件は、登録済み・提案済みの情報源と重複するか、配信の生存確認ができなかったため除いています）`,
      proposals,
    };
  }
  return { reply, proposals };
}
