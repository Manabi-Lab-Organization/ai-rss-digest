
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestEditorialProposals, digestProposalMessages } from '../../db/schema.js';
import {
  createMessage,
  messageText,
  getGenerateModel,
  withConversationCacheBreakpoint,
  type CreateMessageFn,
} from './anthropicClient.js';
import { coverageFactsBlock } from './coverage.js';

const MAX_TOKENS = 8000;
export const MAX_MESSAGE_CHARS = 4000;
const HISTORY_LIMIT = 30;
const MIN_PROFILE_CHARS = 100;

const FENCE_RE = /```profile\s*\n?([\s\S]*?)```/g;

export function parseProfileFence(reply: string): { cleanReply: string; revisedProfile: string | null } {
  const matches = [...reply.matchAll(FENCE_RE)];
  if (matches.length === 0) return { cleanReply: reply.trim(), revisedProfile: null };

  const cleanReply = reply.replace(FENCE_RE, '').trim();
  const profile = matches[matches.length - 1][1].trim();
  return { cleanReply, revisedProfile: profile.length >= MIN_PROFILE_CHARS ? profile : null };
}

export interface ProposalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function normalizeTurns(turns: ProposalTurn[]): ProposalTurn[] {
  const out: ProposalTurn[] = [];
  for (const turn of turns) {
    if (out.length === 0 && turn.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${turn.content}`;
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}

export function buildRevisePrompt(
  currentProfile: string,
  draftProfile: string,
  history: ProposalTurn[],
  coverageText?: string | null,
): { system: string; messages: ProposalTurn[] } {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const facts = coverageFactsBlock(coverageText);
  const system = [
    'あなたは「AI RSS Digest」の編集委員です。読者（本紙の唯一の読者であり編集長）と、',
    '編集方針プロファイルの改定案について打ち合わせをしています。',
    '',
    '<current_profile>  # いま有効な編集方針。改定案が承認されるまでこれが使われる',
    currentProfile.trim(),
    '</current_profile>',
    '',
    '<draft_profile>  # 検討中の改定案。読者の意見に合わせてこれを直していく',
    draftProfile.trim(),
    '</draft_profile>',
    '',
    ...facts,
    'あなたの仕事:',
    '- 読者の指摘・注文を受けて、<draft_profile> を直した改定案を作る',
    '- 指摘が質問・確認の場合は答えるだけでよい（案は変えない）',
    '',
    '制約（厳守）:',
    '- 直すのは指摘された点とその周辺だけ。指摘の範囲を超えて勝手に書き換えない',
    '- プロファイルの構造（本紙の性格・関心トピックの重み・情報源の信頼度ティア・新規性・',
    '  既知性・良い/悪い選定の例）は保つ',
    '- 読者の指摘は具体例で語られることが多い。個別の記事名をそのまま方針に書き写すのではなく、',
    '  次号以降に再現できる判断ルールへ翻訳する',
    '- 確度の低い一般化はしない。読者の意図が複数に取れる場合は、書き換える前に確認を返す',
    ...(facts.length
      ? ['- 紙面の偏り・重複・再出現の指摘は <coverage_facts> の実測値を根拠にする。読者の印象と数字が'
        + '食い違うときは、数字を示したうえで「どの記事が該当するか」を確かめる。数字に無いことは断定しない']
      : []),
    '',
    '出力形式（厳守）:',
    '1) まず読者への返答を日本語で2〜5行。何をどう直したか（直さない場合はその理由）を',
    '   方針の言葉で具体的に書く。相槌や謝罪だけの返答はしない',
    '2) 案を直した場合のみ、続けて ```profile フェンスに**改定後のプロファイル全文**を出力する',
    '   - フェンスの中身は読者の承認後にそのまま編集方針として保存される。前置き・後書きは書かない',
    `   - 冒頭の「# 変更点(${today}): 〜」行は、今回の打ち合わせの結果を含む内容に必ず書き直す`,
    '3) 案を変えないターンでは ```profile フェンスを出さない（返答だけで終える）',
  ].join('\n');

  return { system, messages: normalizeTurns(history.slice(-HISTORY_LIMIT)) };
}

export interface ReviseResult {
  reply: string;
  revisedProfile: string | null;
}

export async function reviseProposal(
  {
    currentProfile,
    draftProfile,
    history,
    coverageText,
  }: { currentProfile: string; draftProfile: string; history: ProposalTurn[]; coverageText?: string | null },
  { createMessageFn = (body) => createMessage(body, { stage: 'profile-revise' }) }: { createMessageFn?: CreateMessageFn } = {},
): Promise<ReviseResult> {
  const { system, messages } = buildRevisePrompt(currentProfile, draftProfile, history, coverageText);
  if (messages.length === 0) throw new Error('会話が空のため案を見直せません');
  const response = await createMessageFn({
    model: getGenerateModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: withConversationCacheBreakpoint(messages),
  });
  const { cleanReply, revisedProfile } = parseProfileFence(messageText(response).trim());
  if (!cleanReply) throw new Error('編集委員から返答が返りませんでした');

  if (response.stop_reason === 'max_tokens' && revisedProfile) {
    return {
      reply: `${cleanReply}\n\n（改定案の出力が長さの上限で途切れたため、今回は案に反映していません。指摘を分けてもう一度お送りください）`,
      revisedProfile: null,
    };
  }
  return { reply: cleanReply, revisedProfile };
}

export interface ProposalMessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  revised: boolean;
  createdAt: Date;
}

export interface ProposalThread {
  proposalId: number;
  status: string;
  draft: string;
  revisionId: number;
  revisionCount: number;
  messages: ProposalMessageRow[];
}

export async function loadProposalThread(userId: number, proposalId: number): Promise<ProposalThread | null> {
  const [proposal] = await db
    .select()
    .from(digestEditorialProposals)
    .where(and(eq(digestEditorialProposals.id, proposalId), eq(digestEditorialProposals.userId, userId)));
  if (!proposal) return null;

  const rows = await db
    .select()
    .from(digestProposalMessages)
    .where(eq(digestProposalMessages.proposalId, proposalId))
    .orderBy(asc(digestProposalMessages.id));

  const revisions = rows.filter((r) => r.revisedProfile !== null);
  const latest = revisions[revisions.length - 1];

  return {
    proposalId,
    status: proposal.status,
    draft: latest?.revisedProfile ?? proposal.content,
    revisionId: latest?.id ?? 0,
    revisionCount: revisions.length,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: r.content,
      revised: r.revisedProfile !== null,
      createdAt: r.createdAt,
    })),
  };
}

export async function appendProposalMessage(
  userId: number,
  proposalId: number,
  msg: { role: 'user' | 'assistant'; content: string; revisedProfile?: string | null },
): Promise<number> {
  const [inserted] = await db
    .insert(digestProposalMessages)
    .values({
      userId,
      proposalId,
      role: msg.role,
      content: msg.content,
      revisedProfile: msg.revisedProfile ?? null,
    })
    .returning({ id: digestProposalMessages.id });
  return inserted.id;
}

export function toTurns(messages: ProposalMessageRow[]): ProposalTurn[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export interface ProfileVersion {
  proposalId: number;
  content: string;
  approvedAt: Date | null;
  note: string | null;
  chars: number;
}

export async function listProfileVersions(userId: number, limit = 20): Promise<ProfileVersion[]> {
  const approved = await db
    .select()
    .from(digestEditorialProposals)
    .where(and(
      eq(digestEditorialProposals.userId, userId),
      eq(digestEditorialProposals.status, 'approved'),
    ))
    .orderBy(desc(digestEditorialProposals.decidedAt))
    .limit(limit);
  if (approved.length === 0) return [];

  const rows = await db
    .select()
    .from(digestProposalMessages)
    .where(inArray(digestProposalMessages.proposalId, approved.map((p) => p.id)))
    .orderBy(asc(digestProposalMessages.id));

  const latestByProposal = new Map<number, string>();
  for (const r of rows) {
    if (r.revisedProfile !== null) latestByProposal.set(r.proposalId, r.revisedProfile);
  }
  return approved.map((p) => {
    const content = latestByProposal.get(p.id) ?? p.content;
    return {
      proposalId: p.id,
      content,
      approvedAt: p.decidedAt,
      note: p.note,
      chars: content.length,
    };
  });
}
