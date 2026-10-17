import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  announcementReads,
  inviteRedemptions,
  digestFeeds,
  digestArticles,
  digestProfiles,
  digestEditions,
  digestSourceProposals,
  digestEditorialProposals,
  digestProposalMessages,
  digestFeedback,
  digestChatMessages,
  digestResearch,
  digestPodcasts,
} from '../db/schema.js';
import { invalidateAllUserAccess, type InvalidateReason } from './authSessionService.js';

export function isAnonymizedEmail(email: string): boolean {
  return email.startsWith('deleted+') && email.endsWith('@removed.local');
}

export async function deleteUserAccount(userId: number, reason: InvalidateReason = 'account.delete'): Promise<void> {
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return;

  if (isAnonymizedEmail(target.email)) return;

  await db.transaction(async (tx) => {
    await tx.delete(announcementReads).where(eq(announcementReads.userId, userId));
    await tx.delete(inviteRedemptions).where(eq(inviteRedemptions.userId, userId));

    await tx.delete(digestPodcasts).where(eq(digestPodcasts.userId, userId));
    await tx.delete(digestResearch).where(eq(digestResearch.userId, userId));
    await tx.delete(digestEditions).where(eq(digestEditions.userId, userId));
    await tx.delete(digestArticles).where(eq(digestArticles.userId, userId));
    await tx.delete(digestFeeds).where(eq(digestFeeds.userId, userId));
    await tx.delete(digestSourceProposals).where(eq(digestSourceProposals.userId, userId));
    await tx.delete(digestProposalMessages).where(eq(digestProposalMessages.userId, userId));
    await tx.delete(digestEditorialProposals).where(eq(digestEditorialProposals.userId, userId));
    await tx.delete(digestFeedback).where(eq(digestFeedback.userId, userId));
    await tx.delete(digestChatMessages).where(eq(digestChatMessages.userId, userId));
    await tx.delete(digestProfiles).where(eq(digestProfiles.userId, userId));

    await tx
      .update(users)
      .set({
        email: `deleted+${userId}@removed.local`,
        passwordHash: null,
        googleId: null,
        resetTokenHash: null,
        resetTokenExpiry: null,
        displayName: '削除済みユーザー',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await tx.execute(sql`
      DELETE FROM session
      WHERE (sess->>'userId')::int = ${userId}
    `);
  });

  await invalidateAllUserAccess(userId, reason);
}
