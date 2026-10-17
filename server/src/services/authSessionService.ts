import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { audit } from './audit/audit.js';

export async function deleteWebSessions(userId: number): Promise<number> {
  const result = await db.execute(sql`DELETE FROM session WHERE (sess->>'userId')::int = ${userId}`);
  return result.rowCount ?? 0;
}

export type InvalidateReason =
  | 'password.change'
  | 'password.reset'
  | 'account.delete'
  | 'admin.user_delete'
  | 'admin.suspend'
  | 'admin.password_reset'
  | 'invalidate_all_access';

export async function invalidateAllUserAccess(userId: number, reason: InvalidateReason = 'invalidate_all_access'): Promise<void> {
  const deletedSessions = await deleteWebSessions(userId);
  await audit('session.revoke', {
    target: { type: 'user', id: userId },
    detail: { reason, scope: 'all', deletedSessions },
  });
}

export async function logoutOtherDevices(userId: number, currentSessionId: string): Promise<{ deletedSessions: number }> {
  const result = await db.execute(sql`
    DELETE FROM session
    WHERE (sess->>'userId')::int = ${userId}
      AND sid <> ${currentSessionId}
  `);
  return { deletedSessions: result.rowCount ?? 0 };
}
