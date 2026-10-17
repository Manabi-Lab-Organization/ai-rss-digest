import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema.js';

export function parsePgTimestampUTC(val: string): Date {
  return new Date(val.replace(' ', 'T') + 'Z');
}
types.setTypeParser(types.builtins.TIMESTAMP, parsePgTimestampUTC);

const useSsl = process.env.DATABASE_SSL === 'true' || /[?&]sslmode=(require|verify-ca|verify-full)/.test(process.env.DATABASE_URL ?? '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(useSsl && {
    ssl: { rejectUnauthorized: false },
  }),
});

export const db = drizzle(pool, { schema });
export { pool };

export async function ensureTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" serial PRIMARY KEY,
        "email" varchar(255) NOT NULL UNIQUE,
        "password_hash" varchar(255),
        "display_name" varchar(100),
        "google_id" varchar(255) UNIQUE,
        "reset_token_hash" varchar(64),
        "reset_token_expiry" timestamp,
        "email_verified_at" timestamp,
        "role" varchar(20) NOT NULL DEFAULT 'user',
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "invite_codes" (
        "code"        varchar(64) PRIMARY KEY,
        "max_uses"    integer,
        "used_count"  integer NOT NULL DEFAULT 0,
        "expires_at"  timestamp,
        "note"        text,
        "is_active"   boolean NOT NULL DEFAULT true,
        "created_by"  integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at"  timestamp NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "invite_redemptions" (
        "id"          serial PRIMARY KEY,
        "user_id"     integer NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
        "code"        varchar(64) NOT NULL,
        "redeemed_at" timestamp NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "announcements" (
        "id" serial PRIMARY KEY,
        "title" varchar(200) NOT NULL,
        "body" text NOT NULL,
        "important" boolean NOT NULL DEFAULT false,
        "target_segment" varchar(20) NOT NULL DEFAULT 'all',
        "starts_at" timestamp NOT NULL DEFAULT now(),
        "ends_at" timestamp,
        "is_published" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "announcement_reads" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "announcement_id" integer NOT NULL REFERENCES "announcements"("id") ON DELETE CASCADE,
        "read_at" timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "announcement_reads_user_ann_idx" ON "announcement_reads"("user_id", "announcement_id");`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_feeds" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "title" text NOT NULL,
        "xml_url" text NOT NULL,
        "html_url" text,
        "kind" varchar(20) NOT NULL DEFAULT 'rss',
        "category" varchar(100),
        "tier" varchar(20) NOT NULL DEFAULT 'none',
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "etag" text,
        "last_modified" text,
        "last_fetched_at" timestamp,
        "last_published_at" timestamp,
        "last_error" text,
        "error_count" integer NOT NULL DEFAULT 0,
        "origin" varchar(20) NOT NULL DEFAULT 'manual',
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "digest_feeds_user_url_idx"
      ON "digest_feeds"("user_id", "xml_url");
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_articles" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "feed_id" integer REFERENCES "digest_feeds"("id") ON DELETE SET NULL,
        "url_hash" varchar(16) NOT NULL,
        "title" text NOT NULL,
        "url" text NOT NULL,
        "published_at" timestamp,
        "summary_raw" text,
        "content" text,
        "fetched_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "digest_articles_user_hash_idx"
      ON "digest_articles"("user_id", "url_hash");
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "digest_articles_feed_published_idx"
      ON "digest_articles"("feed_id", "published_at");
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "digest_articles_user_url_md5_idx"
      ON "digest_articles"("user_id", md5("url"));
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_profiles" (
        "user_id" integer PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
        "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "editorial_profile" text,
        "onboarded_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`ALTER TABLE "digest_feeds" ALTER COLUMN "tier" SET DEFAULT 'none';`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_editions" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "edition_date" varchar(10) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'generating',
        "format" varchar(20) NOT NULL DEFAULT 'brief',
        "title" text NOT NULL DEFAULT '',
        "content" jsonb,
        "article_count" integer NOT NULL DEFAULT 0,
        "is_first_issue" boolean NOT NULL DEFAULT false,
        "growing_notice" boolean NOT NULL DEFAULT false,
        "generated_at" timestamp,
        "mail_sent_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "digest_editions_user_date_idx"
      ON "digest_editions"("user_id", "edition_date");
    `);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "triage_score" integer;`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "section" varchar(50);`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "summary" text;`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "edition_id" integer REFERENCES "digest_editions"("id") ON DELETE SET NULL;`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "included" boolean NOT NULL DEFAULT false;`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "cluster_id" varchar(40);`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "source_name" text;`);
    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "source_url" text;`);

    await client.query(`ALTER TABLE "digest_articles" ADD COLUMN IF NOT EXISTS "human_rating" integer;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_source_proposals" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "origin" varchar(20) NOT NULL DEFAULT 'chat',
        "title" text NOT NULL,
        "xml_url" text NOT NULL,
        "kind" varchar(20) NOT NULL DEFAULT 'rss',
        "category" varchar(100),
        "reason" text NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'proposed',
        "created_at" timestamp DEFAULT now() NOT NULL,
        "decided_at" timestamp
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_editorial_proposals" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'proposed',
        "note" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "decided_at" timestamp
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_feedback" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "article_id" integer,
        "comment" text NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`ALTER TABLE "digest_profiles" ADD COLUMN IF NOT EXISTS "last_review_at" timestamp;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_proposal_messages" (
        "id" serial PRIMARY KEY,
        "proposal_id" integer NOT NULL REFERENCES "digest_editorial_proposals"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role" varchar(10) NOT NULL,
        "content" text NOT NULL,
        "revised_profile" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "digest_proposal_messages_proposal_id_idx"
      ON "digest_proposal_messages"("proposal_id", "id");
    `);

    await client.query(`ALTER TABLE "digest_profiles" ADD COLUMN IF NOT EXISTS "poll_status" varchar(20);`);
    await client.query(`ALTER TABLE "digest_profiles" ADD COLUMN IF NOT EXISTS "poll_finished_at" timestamp;`);
    await client.query(`ALTER TABLE "digest_profiles" ADD COLUMN IF NOT EXISTS "poll_result" jsonb;`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_research" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "article_id" integer NOT NULL REFERENCES "digest_articles"("id") ON DELETE CASCADE,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "report" text,
        "requested_at" timestamp DEFAULT now() NOT NULL,
        "completed_at" timestamp
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "digest_research_user_article_idx"
      ON "digest_research"("user_id", "article_id");
    `);
    await client.query(`
      ALTER TABLE "digest_research" ADD COLUMN IF NOT EXISTS "visual_status" varchar(20);
    `);
    await client.query(`
      ALTER TABLE "digest_research" ADD COLUMN IF NOT EXISTS "visual_html" text;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_chat_messages" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role" varchar(10) NOT NULL,
        "content" text NOT NULL,
        "proposal_ids" jsonb,
        "attachment_names" jsonb,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "digest_chat_messages_user_id_idx"
      ON "digest_chat_messages"("user_id", "id");
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_usage" (
        "id" serial PRIMARY KEY,
        "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE,
        "stage" varchar(40) NOT NULL,
        "model" varchar(100) NOT NULL,
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "cache_creation_input_tokens" integer NOT NULL DEFAULT 0,
        "cache_read_input_tokens" integer NOT NULL DEFAULT 0,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);
    await client.query(`
      ALTER TABLE "digest_usage" ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer NOT NULL DEFAULT 0;
    `);
    await client.query(`
      ALTER TABLE "digest_usage" ADD COLUMN IF NOT EXISTS "cache_read_input_tokens" integer NOT NULL DEFAULT 0;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "digest_podcasts" (
        "id" serial PRIMARY KEY,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "edition_id" integer NOT NULL UNIQUE REFERENCES "digest_editions"("id") ON DELETE CASCADE,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "script" text,
        "audio" bytea,
        "mime_type" varchar(40),
        "duration_sec" integer,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "completed_at" timestamp
      );
    `);
    await client.query(`ALTER TABLE "digest_podcasts" ALTER COLUMN "audio" SET STORAGE EXTERNAL;`);
    await client.query(`ALTER TABLE "digest_podcasts" ADD COLUMN IF NOT EXISTS "tts_model" varchar(80);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id" bigserial PRIMARY KEY,
        "ts" timestamptz NOT NULL DEFAULT now(),
        "app" text NOT NULL,
        "event" text NOT NULL,
        "result" text NOT NULL,
        "actor_id" text,
        "actor_email" text,
        "actor_role" text,
        "auth_method" text,
        "tenant_id" text,
        "target_type" text,
        "target_id" text,
        "ip" inet,
        "user_agent" text,
        "request_id" text,
        "detail" jsonb
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_ts_idx" ON "audit_log" ("ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_actor_ts_idx" ON "audit_log" ("actor_id", "ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_target_ts_idx" ON "audit_log" ("target_type", "target_id", "ts");`);
    await client.query(`CREATE INDEX IF NOT EXISTS "audit_log_event_ts_idx" ON "audit_log" ("event", "ts");`);
    await client.query(`
      CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_retention', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_log is append-only (% is not allowed)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS "audit_log_no_modify" ON "audit_log";`);
    await client.query(`
      CREATE TRIGGER "audit_log_no_modify" BEFORE UPDATE OR DELETE ON "audit_log"
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
    `);
    await client.query(`DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON "audit_log";`);
    await client.query(`
      CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log"
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "audit_export_state" (
        "day" date PRIMARY KEY,
        "object_key" text NOT NULL,
        "row_count" integer NOT NULL,
        "sha256" text,
        "exported_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
    console.log('[DB] データベースの準備ができました');
  } catch (err) {
    console.error('[DB] テーブル作成エラー:', err);
  } finally {
    client.release();
  }
}
