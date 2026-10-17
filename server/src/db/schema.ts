import { pgTable, serial, varchar, text, timestamp, integer, boolean, jsonb, uniqueIndex, bigserial, inet, index, date } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  displayName: varchar('display_name', { length: 100 }),
  googleId: varchar('google_id', { length: 255 }).unique(),
  resetTokenHash: varchar('reset_token_hash', { length: 64 }),
  resetTokenExpiry: timestamp('reset_token_expiry'),
  emailVerifiedAt: timestamp('email_verified_at'),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const inviteCodes = pgTable('invite_codes', {
  code: varchar('code', { length: 64 }).primaryKey(),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at'),
  note: text('note'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inviteRedemptions = pgTable('invite_redemptions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  code: varchar('code', { length: 64 }).notNull(),
  redeemedAt: timestamp('redeemed_at').defaultNow().notNull(),
});

export const announcements = pgTable('announcements', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  important: boolean('important').notNull().default(false),
  targetSegment: varchar('target_segment', { length: 20 }).notNull().default('all'),
  startsAt: timestamp('starts_at').defaultNow().notNull(),
  endsAt: timestamp('ends_at'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const announcementReads = pgTable('announcement_reads', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  announcementId: integer('announcement_id').references(() => announcements.id, { onDelete: 'cascade' }).notNull(),
  readAt: timestamp('read_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('announcement_reads_user_ann_idx').on(table.userId, table.announcementId),
]);

export const digestFeeds = pgTable('digest_feeds', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  xmlUrl: text('xml_url').notNull(),
  htmlUrl: text('html_url'),
  kind: varchar('kind', { length: 20 }).notNull().default('rss'),
  category: varchar('category', { length: 100 }),
  tier: varchar('tier', { length: 20 }).notNull().default('none'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  lastFetchedAt: timestamp('last_fetched_at'),
  lastPublishedAt: timestamp('last_published_at'),
  lastError: text('last_error'),
  errorCount: integer('error_count').notNull().default(0),
  origin: varchar('origin', { length: 20 }).notNull().default('manual'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('digest_feeds_user_url_idx').on(table.userId, table.xmlUrl),
]);

export const digestArticles = pgTable('digest_articles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  feedId: integer('feed_id').references(() => digestFeeds.id, { onDelete: 'set null' }),
  urlHash: varchar('url_hash', { length: 16 }).notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  publishedAt: timestamp('published_at'),
  summaryRaw: text('summary_raw'),
  content: text('content'),
  triageScore: integer('triage_score'),
  section: varchar('section', { length: 50 }),
  summary: text('summary'),
  editionId: integer('edition_id'),
  included: boolean('included').notNull().default(false),
  clusterId: varchar('cluster_id', { length: 40 }),
  humanRating: integer('human_rating'),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  sourceName: text('source_name'),
  sourceUrl: text('source_url'),
}, (table) => [
  uniqueIndex('digest_articles_user_hash_idx').on(table.userId, table.urlHash),
]);

export const digestProfiles = pgTable('digest_profiles', {
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  settings: jsonb('settings').notNull().default({}),
  editorialProfile: text('editorial_profile'),
  onboardedAt: timestamp('onboarded_at'),
  lastReviewAt: timestamp('last_review_at'),
  pollStatus: varchar('poll_status', { length: 20 }),
  pollFinishedAt: timestamp('poll_finished_at'),
  pollResult: jsonb('poll_result'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const digestEditions = pgTable('digest_editions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  editionDate: varchar('edition_date', { length: 10 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('generating'),
  format: varchar('format', { length: 20 }).notNull().default('brief'),
  title: text('title').notNull().default(''),
  content: jsonb('content'),
  articleCount: integer('article_count').notNull().default(0),
  isFirstIssue: boolean('is_first_issue').notNull().default(false),
  growingNotice: boolean('growing_notice').notNull().default(false),
  generatedAt: timestamp('generated_at'),
  mailSentAt: timestamp('mail_sent_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const digestSourceProposals = pgTable('digest_source_proposals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  origin: varchar('origin', { length: 20 }).notNull().default('chat'),
  title: text('title').notNull(),
  xmlUrl: text('xml_url').notNull(),
  kind: varchar('kind', { length: 20 }).notNull().default('rss'),
  category: varchar('category', { length: 100 }),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('proposed'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
});

export const digestEditorialProposals = pgTable('digest_editorial_proposals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  content: text('content').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('proposed'),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  decidedAt: timestamp('decided_at'),
});

export const digestProposalMessages = pgTable('digest_proposal_messages', {
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id')
    .references(() => digestEditorialProposals.id, { onDelete: 'cascade' })
    .notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: varchar('role', { length: 10 }).notNull(),
  content: text('content').notNull(),
  revisedProfile: text('revised_profile'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const digestFeedback = pgTable('digest_feedback', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  articleId: integer('article_id'),
  comment: text('comment').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const digestChatMessages = pgTable('digest_chat_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: varchar('role', { length: 10 }).notNull(),
  content: text('content').notNull(),
  proposalIds: jsonb('proposal_ids'),
  attachmentNames: jsonb('attachment_names'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const digestResearch = pgTable('digest_research', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  articleId: integer('article_id').references(() => digestArticles.id, { onDelete: 'cascade' }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  report: text('report'),
  visualStatus: varchar('visual_status', { length: 20 }),
  visualHtml: text('visual_html'),
  requestedAt: timestamp('requested_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (table) => [
  uniqueIndex('digest_research_user_article_idx').on(table.userId, table.articleId),
]);

export const digestUsage = pgTable('digest_usage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  stage: varchar('stage', { length: 40 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
  cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const digestPodcasts = pgTable('digest_podcasts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  editionId: integer('edition_id').references(() => digestEditions.id, { onDelete: 'cascade' }).notNull().unique(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  script: text('script'),
  audio: bytea('audio'),
  mimeType: varchar('mime_type', { length: 40 }),
  durationSec: integer('duration_sec'),
  ttsModel: varchar('tts_model', { length: 80 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  app: text('app').notNull(),
  event: text('event').notNull(),
  result: text('result').notNull(),
  actorId: text('actor_id'),
  actorEmail: text('actor_email'),
  actorRole: text('actor_role'),
  authMethod: text('auth_method'),
  tenantId: text('tenant_id'),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestId: text('request_id'),
  detail: jsonb('detail'),
}, (table) => [
  index('audit_log_ts_idx').on(table.ts),
  index('audit_log_actor_ts_idx').on(table.actorId, table.ts),
  index('audit_log_target_ts_idx').on(table.targetType, table.targetId, table.ts),
  index('audit_log_event_ts_idx').on(table.event, table.ts),
]);

export const auditExportState = pgTable('audit_export_state', {
  day: date('day').primaryKey(),
  objectKey: text('object_key').notNull(),
  rowCount: integer('row_count').notNull(),
  sha256: text('sha256'),
  exportedAt: timestamp('exported_at', { withTimezone: true }).defaultNow().notNull(),
});
