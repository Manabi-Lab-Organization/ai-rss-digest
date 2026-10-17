
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestFeeds, digestProfiles, digestSourceProposals, users } from '../../db/schema.js';
import {
  createMessage,
  messageText,
  getGenerateModel,
  getPremiumModel,
  getTriageModel,
  type CreateMessageFn,
} from './anthropicClient.js';
import {
  parseProposalsFence,
  normalizeProposalItems,
  filterNewProposals,
  replyLooksLikeSourceList,
  parseRecoveredProposals,
  PROPOSAL_RECOVERY_SYSTEM_PROMPT,
  type ProposalCandidate,
} from './sourceChat.js';
import { fetchFeed } from './rss.js';
import { collectSuggestionContext, type SuggestionContext } from './suggestionContext.js';
import { DEFAULT_EDITORIAL_PROFILE } from './editorialProfile.js';
import { sendDigestSourceSuggestionEmail } from '../emailService.js';

const MAX_TOKENS = 4000;
const MAX_WEB_SEARCHES = 10;

export const SOURCE_SUGGEST_SYSTEM_PROMPT = `あなたは「AI RSS Digest」の編集長AIです。
「AI RSS Digest」は読者一人ひとりのための情報ダイジェスト紙で、登録された情報源（RSSフィード / Googleニュース検索キーワード）から毎朝の紙面を自動編集します。
今回のあなたの仕事は、読者が紙面の記事に付けた👍👎の傾向から、その動向把握・将来推察に役立つ情報源を探して提案することです。

ルール（厳守）:
- 提案には必ず理由を付け、理由には**由来**を明記する（どの👍👎評価の傾向から、が読者に分かるように書く）
- 渡された「既存の情報源一覧」と重複する情報源は提案しない（同じURL・実質同じ媒体の別URLも避ける）
- RSSフィードのURLは実在が確実なもののみ提案する（Web検索で実在を確認する。推測でURLをでっち上げない）
- 特定サイトの良いRSSが見つからないテーマは、Googleニュース検索のキーワード購読（kind: "gnews"）として提案する。その場合は url の代わりに keyword を返す
- 提案は評価された記事に出た企業そのものに限らず、対象領域の「周辺」まで創造的に広げて検討する。探索軸の例:
  ① 企業: 対象企業・主要な競合のIR/公式ニュースリリース＋社名のGoogleニュース検索
  ② 業界・市場: その業界・市場の動向を追える定評ある専門メディア・業界団体・調査会社
  ③ サプライチェーン: 対象領域の上流・下流の業界（例: パン屋なら小麦の産地・製粉・包装資材・配送）
  ④ 規制・制度: 監督官庁・規制当局・標準化団体・国際機関の公式発信
  ⑤ 知識領域: 記事に出た技術・テーマの最新動向を追える国内外の主要メディア・学会・研究機関（海外の一流メディアを積極的に）
  ⑥ データ・統計: 政府統計・業界統計・著名調査会社の定点データ
  ⑦ キーパーソン: その領域で広く認知された専門家・実務家の発信（信頼性基準を満たす場合に限る）
- 「既存の情報源一覧」は読者がすでにカバーしている中心と考え、同じものを避けるだけでなく、その一段外側の輪を狙って提案する
- 【バランス規律・厳守】提案の前に「既存の情報源一覧」の構成を軸別（企業由来/業界・市場/技術・知識領域/手法・思考法/データ・統計/規制など）に見立てる。
  既存に偏りがあれば、提案は手薄な軸を優先して埋める（例: 既存が業界の専門メディアばかりなら、統計・規制・技術の切り口を中心に提案する）。
  読者が求めているのは登録済みの延長ではなく、まだカバーできていない角度である。今回の提案全体でも企業由来（IR・社名のニュース検索）が過半を占めないようにする
- 【信頼性基準・厳守】提案してよいのは、ビジネスパーソンの情報収集に耐える信頼できる定評ある情報源のみ:
  大手報道機関・経済紙、業界で広く認知された専門メディア、政府・国際機関・業界団体・上場企業の公式発信、著名な調査会社。
  個人ブログ・まとめサイト・アフィリエイトサイト・信頼性を確認できないサイトは提案しない
- 【編集方針の使い方・厳守】読者の編集方針（<editorial_profile>）は、提案の良し悪しを判断するための**背景**として使う。
  方針に書かれた話題だけに絞ってはならない。方針は「読者が何を大事にしているか」を示すものであって、提案してよい範囲の枠ではない。
  方針から読み取れる関心の**外側**にある、読者がまだ気づいていない情報源を出すことこそが提案の値打ちである（上の探索軸・バランス規律を優先する）。
  また、提案の理由に書く**由来は👍👎の傾向のまま**とし、「編集方針にあるから」を由来として書かない
- 一度に提案するのは多くても10件。ただし出し惜しみもしない: 信頼性基準を満たす良い候補が見つかる限り、上限近くまで提案する。読者が自分では思いつかないであろう情報源も1〜2件混ぜる（その場合は「なぜ役立つか」の理由を特に丁寧に書く）
- 数合わせはしない: 関連の薄い候補で埋めるくらいなら件数が少ない方がよい。適切な提案が無ければ提案しなくてよい
- 提案はあなたが登録するのではなく、読者が承認して初めて登録される

提案の出力形式（厳守）:
- 情報源を提案する場合は、応答本文の末尾に次の形式のコードフェンスを1つだけ出力する:
\`\`\`proposals
[{"title": "情報源の名前", "url": "RSSフィードのURL（http から始まる。keywordと排他）", "keyword": "検索キーワード（urlと排他）", "category": "分類（例: 食品業界）", "reason": "この情報源を提案する理由（由来を明記）"}]
\`\`\`
- 提案が無い場合は proposals フェンスを出力しない
- フェンス内は正しいJSON配列のみ。フェンスの外の本文では、提案内容を読者向けの言葉で簡潔に説明する`;

export function buildSuggestionUserMessage(
  contextText: string,
  existingFeeds: Array<{ title: string; xmlUrl: string; category?: string | null }>,
  rejected: Array<{ title: string }> = [],
  profileText = '',
): string {
  return [
    ...(profileText.trim()
      ? ['<editorial_profile>', profileText.trim(), '</editorial_profile>', '']
      : []),
    '以下は、この読者の直近30日の評価の傾向です。',
    'これをもとに、動向把握・将来推察に役立つ情報源を探して提案してください。',
    '',
    contextText,
    '',
    '## 既存の情報源一覧（カバー済みの中心。重複する提案はせず、構成の偏りを見立てて手薄な軸を埋める）',
    ...(existingFeeds.length
      ? existingFeeds.map((f) => `- ${f.title}（${f.category ? `分類: ${f.category} / ` : ''}${f.xmlUrl}）`)
      : ['（まだ情報源が登録されていません）']),
    ...(rejected.length
      ? ['', '## 見送り済みの提案（読者が不要と判断したもの。同じもの・実質同じものは再提案しない）',
         ...rejected.map((r) => `- ${r.title}`)]
      : []),
  ].join('\n');
}

export async function runSuggestionLLM(
  contextText: string,
  existingFeeds: Array<{ title: string; xmlUrl: string }>,
  {
    createMessageFn = (body) => createMessage(body, { stage: 'source-suggest' }),
    rejected = [],
    premium = false,
    profileText,
  }: {
    createMessageFn?: CreateMessageFn;
    rejected?: Array<{ title: string }>;
    premium?: boolean;
    profileText: string;
  },
): Promise<{ reply: string; candidates: ProposalCandidate[] }> {
  const response = await createMessageFn({
    model: premium ? getPremiumModel() : getGenerateModel(),
    max_tokens: MAX_TOKENS,
    system: SOURCE_SUGGEST_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildSuggestionUserMessage(contextText, existingFeeds, rejected, profileText),
    }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES }],
  });
  const { cleanReply, items } = parseProposalsFence(messageText(response));
  let candidates = normalizeProposalItems(items);

  if (candidates.length === 0 && replyLooksLikeSourceList(cleanReply)) {
    try {
      const recovered = await createMessageFn({
        model: getTriageModel(),
        max_tokens: 2000,
        system: PROPOSAL_RECOVERY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: cleanReply }],
      });
      candidates = normalizeProposalItems(parseRecoveredProposals(messageText(recovered)));
      if (candidates.length > 0) {
        console.log(`[Digest:source-suggest] フェンス欠落をリカバリ抽出で回収（${candidates.length}件）`);
      }
    } catch (err) {
      console.log(`[Digest:source-suggest] リカバリ抽出に失敗（続行）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { reply: cleanReply, candidates };
}

export type SourceSuggestionResult =
  | { status: 'skipped'; reason: 'no_signals' }
  | { status: 'proposed'; count: number; ids: number[] };

type FetchFeedFn = (xmlUrl: string) => Promise<unknown>;

export async function runSourceSuggestion(
  userId: number,
  {
    createMessageFn,
    fetchFeedFn = (xmlUrl) => fetchFeed(xmlUrl),
    collectContextFn = collectSuggestionContext,
    premium = false,
  }: {
    createMessageFn?: CreateMessageFn;
    fetchFeedFn?: FetchFeedFn;
    collectContextFn?: (userId: number) => Promise<SuggestionContext>;
    premium?: boolean;
  } = {},
): Promise<SourceSuggestionResult> {
  const context = await collectContextFn(userId);
  if (context.signalCount === 0) {
    console.log(`[Digest:source-suggest] user=${userId} 材料なし（評価0件）のためスキップ`);
    return { status: 'skipped', reason: 'no_signals' };
  }

  const feedRows = await db
    .select({ title: digestFeeds.title, xmlUrl: digestFeeds.xmlUrl, category: digestFeeds.category })
    .from(digestFeeds)
    .where(eq(digestFeeds.userId, userId));
  const proposalRows = await db
    .select({ xmlUrl: digestSourceProposals.xmlUrl })
    .from(digestSourceProposals)
    .where(and(
      eq(digestSourceProposals.userId, userId),
      inArray(digestSourceProposals.status, ['proposed', 'approved']),
    ));
  const existingUrls = new Set([...feedRows, ...proposalRows].map((r) => r.xmlUrl));

  const rejectedRows = await db
    .select({ title: digestSourceProposals.title })
    .from(digestSourceProposals)
    .where(and(
      eq(digestSourceProposals.userId, userId),
      eq(digestSourceProposals.status, 'rejected'),
    ))
    .orderBy(desc(digestSourceProposals.id))
    .limit(30);

  const [profile] = await db
    .select({ editorialProfile: digestProfiles.editorialProfile })
    .from(digestProfiles)
    .where(eq(digestProfiles.userId, userId));
  const profileText = profile?.editorialProfile || DEFAULT_EDITORIAL_PROFILE;

  const { candidates } = await runSuggestionLLM(context.text, feedRows, {
    createMessageFn, rejected: rejectedRows, premium, profileText,
  });
  const fresh = filterNewProposals(candidates, existingUrls);
  const dupRemoved = candidates.length - fresh.length;
  if (dupRemoved > 0) {
    console.log(`[Digest:source-suggest] 既存の情報源・提案と重複する候補を${dupRemoved}件除外（user=${userId}）`);
  }

  const checks = await Promise.allSettled(fresh.map((c) => fetchFeedFn(c.xmlUrl)));
  const alive = fresh.filter((_, i) => checks[i].status === 'fulfilled');
  const dead = fresh.length - alive.length;
  if (dead > 0) console.log(`[Digest:source-suggest] 生存確認で${dead}件の提案を除外（user=${userId}）`);

  const inserted: Array<{ id: number; title: string; reason: string }> = [];
  for (const c of alive) {
    const [row] = await db
      .insert(digestSourceProposals)
      .values({
        userId,
        origin: 'suggest',
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
        reason: digestSourceProposals.reason,
      });
    if (row) inserted.push(row);
  }

  if (inserted.length > 0) {
    try {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (user?.email && !user.email.startsWith('deleted+')) {
        await sendDigestSourceSuggestionEmail({ to: user.email, proposals: inserted });
      }
    } catch (err) {
      console.error(`[Digest:source-suggest] メール送信失敗（提案${inserted.length}件は起票済み）: ${String((err as Error).message || err).slice(0, 200)}`);
    }
  }

  console.log(`[Digest:source-suggest] user=${userId} 評価${context.signalCount}件 → 提案${inserted.length}件を起票`);
  return { status: 'proposed', count: inserted.length, ids: inserted.map((r) => r.id) };
}
