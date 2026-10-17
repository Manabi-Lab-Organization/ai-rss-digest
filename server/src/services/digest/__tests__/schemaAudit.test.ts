import { describe, it, expect } from 'vitest';
import {
  expectedSchema, diffSchema, formatDriftReport, hasBlockingDrift,
  readActualSchema, auditSchemaDrift, shouldBlockStartup, blockingDriftMessage,
  type TableColumns, type SchemaDrift,
} from '../../../db/schemaAudit.js';

const expected: TableColumns[] = [
  { table: 'digest_profiles', columns: ['user_id', 'settings', 'last_viewed_at'] },
  { table: 'digest_feeds', columns: ['id', 'title'] },
];

describe('expectedSchema', () => {
  it('定義ファイルからテーブルと列の一覧を読み取れる', () => {
    const tables = expectedSchema();
    const profiles = tables.find((t) => t.table === 'digest_profiles');
    expect(profiles).toBeDefined();
    expect(profiles!.columns).toEqual(expect.arrayContaining(['user_id', 'settings', 'editorial_profile']));
    expect(tables.length).toBeGreaterThanOrEqual(19);
  });
});

describe('diffSchema', () => {
  it('定義と DB が同じなら差は無い', () => {
    const drift = diffSchema(expected, [
      { table: 'digest_profiles', columns: ['user_id', 'settings', 'last_viewed_at'] },
      { table: 'digest_feeds', columns: ['id', 'title'] },
    ]);
    expect(drift).toEqual({ missingTables: [], missingColumns: [], extraColumns: [] });
    expect(hasBlockingDrift(drift)).toBe(false);
  });

  it('DB に足りない列を挙げ、止めるべき差とみなす', () => {
    const drift = diffSchema(expected, [
      { table: 'digest_profiles', columns: ['user_id', 'settings'] },
      { table: 'digest_feeds', columns: ['id', 'title'] },
    ]);
    expect(drift.missingColumns).toEqual([{ table: 'digest_profiles', columns: ['last_viewed_at'] }]);
    expect(hasBlockingDrift(drift)).toBe(true);
  });

  it('DB に無いテーブルを挙げ、その列は別に挙げない', () => {
    const drift = diffSchema(expected, [{ table: 'digest_feeds', columns: ['id', 'title'] }]);
    expect(drift.missingTables).toEqual(['digest_profiles']);
    expect(drift.missingColumns).toEqual([]);
  });

  it('DB にだけある列も挙げるが、止めるべき差とはみなさない', () => {
    const drift = diffSchema(expected, [
      { table: 'digest_profiles', columns: ['user_id', 'settings', 'last_viewed_at', 'old_column'] },
      { table: 'digest_feeds', columns: ['id', 'title'] },
    ]);
    expect(drift.extraColumns).toEqual([{ table: 'digest_profiles', columns: ['old_column'] }]);
    expect(hasBlockingDrift(drift)).toBe(false);
  });

  it('定義に無いテーブルは比べる対象にしない', () => {
    const drift = diffSchema(expected, [
      { table: 'digest_profiles', columns: ['user_id', 'settings', 'last_viewed_at'] },
      { table: 'digest_feeds', columns: ['id', 'title'] },
      { table: 'drizzle_migrations', columns: ['hash'] },
    ]);
    expect(drift).toEqual({ missingTables: [], missingColumns: [], extraColumns: [] });
  });
});

describe('formatDriftReport', () => {
  it('差が無ければ1行だけ返す', () => {
    const lines = formatDriftReport({ missingTables: [], missingColumns: [], extraColumns: [] });
    expect(lines).toEqual(['[DB:audit] schema.ts と実DBは一致（ズレなし）']);
  });

  it('足りないテーブル・足りない列・余分な列を、件数と名前つきで全部書く', () => {
    const lines = formatDriftReport({
      missingTables: ['digest_x'],
      missingColumns: [{ table: 'digest_profiles', columns: ['a', 'b'] }],
      extraColumns: [{ table: 'users', columns: ['old'] }],
    });
    expect(lines[0]).toContain('欠落テーブル1件');
    expect(lines[0]).toContain('欠落列2件');
    expect(lines[0]).toContain('余剰列1件');
    expect(lines.join('\n')).toContain('欠落列: digest_profiles → a, b');
    expect(lines.join('\n')).toContain('欠落テーブル: digest_x');
    expect(lines.join('\n')).toContain('余剰列（DBにのみ存在）: users → old');
  });
});

describe('readActualSchema / auditSchemaDrift', () => {
  const client = (rows: Array<{ table_name: string; column_name: string }>) => ({
    query: async () => ({ rows }),
  });

  it('列の一覧の行をテーブルごとにまとめる', async () => {
    const actual = await readActualSchema(client([
      { table_name: 'digest_feeds', column_name: 'id' },
      { table_name: 'digest_feeds', column_name: 'title' },
      { table_name: 'users', column_name: 'id' },
    ]));
    expect(actual).toEqual([
      { table: 'digest_feeds', columns: ['id', 'title'] },
      { table: 'users', columns: ['id'] },
    ]);
  });

  it('比べた結果を記録に書く', async () => {
    const lines: string[] = [];
    await auditSchemaDrift(client([]), (l) => lines.push(l));
    expect(lines.join('\n')).toContain('[DB:audit]');
  });

  it('比べる処理が失敗しても例外を投げず null を返す', async () => {
    const lines: string[] = [];
    const broken = { query: async () => { throw new Error('connection refused'); } };
    const drift = await auditSchemaDrift(broken, (l) => lines.push(l));
    expect(drift).toBeNull();
    expect(lines.join('\n')).toContain('検査に失敗（起動は続行）');
  });
});

const clean: SchemaDrift = { missingTables: [], missingColumns: [], extraColumns: [] };

describe('shouldBlockStartup', () => {
  it('差が無ければ起動を続ける', () => {
    expect(shouldBlockStartup(clean, {})).toBe(false);
  });

  it('足りない列があれば起動を止める', () => {
    expect(shouldBlockStartup(
      { ...clean, missingColumns: [{ table: 'digest_profiles', columns: ['last_viewed_at'] }] },
      {},
    )).toBe(true);
  });

  it('足りないテーブルがあれば起動を止める', () => {
    expect(shouldBlockStartup({ ...clean, missingTables: ['digest_x'] }, {})).toBe(true);
  });

  it('余分な列だけなら起動を止めない', () => {
    expect(shouldBlockStartup(
      { ...clean, extraColumns: [{ table: 'users', columns: ['old'] }] },
      {},
    )).toBe(false);
  });

  it('比べる処理そのものが失敗したときは起動を止めない', () => {
    expect(shouldBlockStartup(null, {})).toBe(false);
  });

  it('SCHEMA_AUDIT_ENFORCE を false にすると止めなくなる', () => {
    const drift = { ...clean, missingTables: ['digest_x'] };
    expect(shouldBlockStartup(drift, { SCHEMA_AUDIT_ENFORCE: 'false' })).toBe(false);
    expect(shouldBlockStartup(drift, { SCHEMA_AUDIT_ENFORCE: 'true' })).toBe(true);
    expect(shouldBlockStartup(drift, {})).toBe(true);
  });
});

describe('blockingDriftMessage', () => {
  const lines = blockingDriftMessage({
    ...clean, missingColumns: [{ table: 'digest_profiles', columns: ['a'] }],
  });

  it('直し方と足りない場所の両方を書く', () => {
    const text = lines.join('\n');
    expect(text).toContain('起動を中止します');
    expect(text).toContain('同じ版のアプリ');
    expect(text).toContain('欠落列: digest_profiles → a');
  });

  it('止めないようにする設定の名前も書く', () => {
    expect(lines.join('\n')).toContain('SCHEMA_AUDIT_ENFORCE=false');
  });
});
