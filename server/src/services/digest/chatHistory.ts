
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { digestChatMessages, digestSourceProposals } from '../../db/schema.js';

const HISTORY_LIMIT = 60;

export interface ChatHistoryProposal {
  id: number;
  title: string;
  xmlUrl: string;
  kind: string;
  category: string | null;
  reason: string;
  status: string;
}

export interface ChatHistoryItem {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  attachmentNames?: string[];
  proposals?: ChatHistoryProposal[];
  createdAt: Date;
}

export async function appendChatMessage(
  userId: number,
  msg: {
    role: 'user' | 'assistant';
    content: string;
    proposalIds?: number[];
    attachmentNames?: string[];
  },
): Promise<void> {
  await db.insert(digestChatMessages).values({
    userId,
    role: msg.role,
    content: msg.content,
    proposalIds: msg.proposalIds && msg.proposalIds.length > 0 ? msg.proposalIds : null,
    attachmentNames: msg.attachmentNames && msg.attachmentNames.length > 0 ? msg.attachmentNames : null,
  });
}

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const numArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];

export async function loadChatHistory(userId: number, limit: number = HISTORY_LIMIT): Promise<ChatHistoryItem[]> {
  const rows = await db
    .select()
    .from(digestChatMessages)
    .where(eq(digestChatMessages.userId, userId))
    .orderBy(desc(digestChatMessages.id))
    .limit(limit);
  rows.reverse();

  const allIds = [...new Set(rows.flatMap((r) => numArray(r.proposalIds)))];
  const proposalRows = allIds.length > 0
    ? await db
        .select({
          id: digestSourceProposals.id,
          title: digestSourceProposals.title,
          xmlUrl: digestSourceProposals.xmlUrl,
          kind: digestSourceProposals.kind,
          category: digestSourceProposals.category,
          reason: digestSourceProposals.reason,
          status: digestSourceProposals.status,
        })
        .from(digestSourceProposals)
        .where(and(eq(digestSourceProposals.userId, userId), inArray(digestSourceProposals.id, allIds)))
    : [];
  const byId = new Map(proposalRows.map((p) => [p.id, p]));

  return rows.map((r) => {
    const attachmentNames = strArray(r.attachmentNames);
    const proposals = numArray(r.proposalIds)
      .map((id) => byId.get(id))
      .filter((p): p is ChatHistoryProposal => Boolean(p));
    return {
      id: r.id,
      role: r.role === 'user' ? 'user' as const : 'assistant' as const,
      content: r.content,
      ...(attachmentNames.length > 0 ? { attachmentNames } : {}),
      ...(proposals.length > 0 ? { proposals } : {}),
      createdAt: r.createdAt,
    };
  });
}
