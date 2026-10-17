import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema.js';

const ensureTablesSql = readFileSync(
  fileURLToPath(new URL('../../../db/index.ts', import.meta.url)),
  'utf8',
);

function allTables(): Array<{ name: string; columns: string[] }> {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return { name: cfg.name, columns: cfg.columns.map((c) => c.name) };
    });
}

describe('スキーマ定義と ensureTables の列が一致する', () => {
  const tables = allTables();

  it('スキーマ定義から主要なテーブルを含む十分な数のテーブルを読み取れる', () => {
    const names = tables.map((t) => t.name);
    expect(names).toContain('digest_profiles');
    expect(names).toContain('digest_feeds');
    expect(names).toContain('digest_editions');
    expect(names).toContain('users');
    expect(tables.length).toBeGreaterThanOrEqual(19);
  });

  it.each(tables.map((t) => [t.name, t.columns] as const))(
    '%s のすべての列名が ensureTables に書かれている',
    (tableName, columns) => {
      const missing = columns.filter((c) => !ensureTablesSql.includes(`"${c}"`));
      expect(
        missing,
        `${tableName}: ensureTables に見つからない列 → ${missing.join(', ')}\n`
        + 'db/index.ts に ALTER TABLE ... ADD COLUMN IF NOT EXISTS を追加してください',
      ).toEqual([]);
    },
  );
});
