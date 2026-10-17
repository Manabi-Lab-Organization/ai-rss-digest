import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';

const h = vi.hoisted(() => ({
  deletedTables: [] as any[],
  targetUser: { id: 42, email: 'tanaka@example.com' },
}));

vi.mock('./authSessionService.js', () => ({ invalidateAllUserAccess: vi.fn(async () => {}) }));

vi.mock('../db/index.js', () => {
  const selectChain: any = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve([h.targetUser]),
  };
  const tx = {
    delete: (table: any) => {
      h.deletedTables.push(table);
      return { where: async () => {} };
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
    execute: async () => {},
  };
  return {
    db: { select: () => selectChain, transaction: async (cb: any) => cb(tx) },
    pool: {},
  };
});

import { deleteUserAccount } from './accountDeletionService.js';

const RETAINED = new Set(['digest_usage']);

let deletedNames: Set<string>;

beforeAll(async () => {
  await deleteUserAccount(42);
  deletedNames = new Set(h.deletedTables.map((t) => getTableConfig(t).name));
});

describe('deleteUserAccount', () => {
  it('ダイジェストまわりで本人が作ったデータを消す', () => {
    const mustDelete = [
      'digest_feeds',
      'digest_articles',
      'digest_profiles',
      'digest_editions',
      'digest_source_proposals',
      'digest_editorial_proposals',
      'digest_feedback',
      'digest_chat_messages',
      'digest_research',
      'digest_podcasts',
    ];
    for (const name of mustDelete) {
      expect(deletedNames.has(name), `${name} が削除の対象に入っていない`).toBe(true);
    }
  });

  it('利用者に直接ひもづくデータも消す', () => {
    const mustDelete = [
      'announcement_reads',
      'invite_redemptions',
    ];
    for (const name of mustDelete) {
      expect(deletedNames.has(name), `${name} が削除の対象に入っていない`).toBe(true);
    }
  });

  it('利用量の記録 digest_usage は消さずに残す', () => {
    expect(deletedNames.has('digest_usage')).toBe(false);
  });

  it('users を cascade で参照するテーブルは、すべて消すか残すかのどちらかに入っている', () => {
    const userCascadeTables: string[] = [];
    for (const val of Object.values(schema)) {
      let cfg;
      try {
        cfg = getTableConfig(val as any);
      } catch {
        continue;
      }
      for (const fk of cfg.foreignKeys) {
        const ref = fk.reference();
        if (getTableConfig(ref.foreignTable).name === 'users' && fk.onDelete === 'cascade') {
          userCascadeTables.push(cfg.name);
        }
      }
    }
    expect(userCascadeTables.length).toBeGreaterThan(0);

    for (const name of userCascadeTables) {
      const handled = deletedNames.has(name) || RETAINED.has(name);
      expect(
        handled,
        `テーブル "${name}" が扱われていない。deleteUserAccount で消すか、` +
          `残すなら RETAINED に入れる。`,
      ).toBe(true);
    }
  });
});
