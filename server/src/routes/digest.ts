
import { serverFeatures } from '../services/features.js';
import { Router } from 'express';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  digestFeeds, digestArticles, digestProfiles, digestEditions,
  digestSourceProposals, digestEditorialProposals, digestFeedback,
  digestResearch, digestUsage, digestPodcasts,
} from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchFeed } from '../services/digest/rss.js';
import { feedHealthWarning, latestPublishedAt, nextLastPublishedAt } from '../services/digest/feedHealth.js';
import { isFeedTier } from '../services/digest/feedTier.js';
import { buildGoogleNewsFeedUrl } from '../services/digest/gnews.js';
import { runDigestJob } from '../services/digest/jobRunner.js';
import { digestAiLimiter, feedWriteLimiter } from '../middleware/rateLimit.js';
import { chatTurn, validateAttachments, MAX_CHAT_MESSAGE_CHARS } from '../services/digest/sourceChat.js';
import { appendChatMessage, loadChatHistory } from '../services/digest/chatHistory.js';
import { countReviewSignals, REVIEW_THRESHOLD } from '../services/digest/profileReview.js';
import {
  appendProposalMessage, loadProposalThread, reviseProposal, toTurns, MAX_MESSAGE_CHARS,
  listProfileVersions,
} from '../services/digest/proposalChat.js';
import { coverageFactsForUser, coverageFactsForUserSafe, DEFAULT_COVERAGE_DAYS } from '../services/digest/coverage.js';
import { DEFAULT_EDITORIAL_PROFILE } from '../services/digest/editorialProfile.js';
import { validateProfile, constitutionDiff, describeProfile } from '../services/digest/profileGuard.js';
import { articleHeadline } from '../services/digest/research.js';
import { parseRange, byteaSliceParams } from '../services/digest/httpRange.js';
import {
  installDbUsageSink, setUsageUser, buildUsageSummary, jstMonthStart, type UsageAggRow,
} from '../services/digest/usage.js';
import { authUserId } from '../middleware/authContext.js';

installDbUsageSink();

const router = Router();
router.use(requireAuth);

function feedErrorMessage(err: unknown): string {
  const msg = String((err as Error)?.message || err);
  if (/^HTTP \d{3}$/.test(msg)) return msg;
  if (/[ぁ-んァ-ヶ一-龠]/.test(msg)) return msg.slice(0, 120);
  if ((err as Error)?.name === 'TimeoutError' || /timeout|aborted/i.test(msg)) return '時間切れ';
  return 'RSS・Atom として読めませんでした';
}

interface DigestSettings {
  deliveryHour: number;
  frequency: 'daily' | 'weekly3' | 'weekly1';
  emailEnabled: boolean;
  sourceSuggestFrequency: 'off' | 'monthly' | 'weekly';
}

const DEFAULT_SETTINGS: DigestSettings = {
  deliveryHour: 6,
  frequency: 'daily',
  emailEnabled: true,
  sourceSuggestFrequency: 'monthly',
};

function normalizeSettings(raw: unknown): DigestSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<DigestSettings>;
  const deliveryHour = Number.isInteger(s.deliveryHour) && (s.deliveryHour as number) >= 0 && (s.deliveryHour as number) <= 23
    ? (s.deliveryHour as number)
    : DEFAULT_SETTINGS.deliveryHour;
  const frequency = s.frequency === 'weekly3' || s.frequency === 'weekly1' ? s.frequency : 'daily';
  const emailEnabled = typeof s.emailEnabled === 'boolean' ? s.emailEnabled : DEFAULT_SETTINGS.emailEnabled;
  const sourceSuggestFrequency = s.sourceSuggestFrequency === 'off' || s.sourceSuggestFrequency === 'weekly'
    ? s.sourceSuggestFrequency
    : DEFAULT_SETTINGS.sourceSuggestFrequency;
  return { deliveryHour, frequency, emailEnabled, sourceSuggestFrequency };
}

const RECENT_ARTICLES_FOR_CADENCE = 20;

async function articleCountsByFeed(
  userId: number,
): Promise<Map<number, { total: number; adopted: number; recentCount: number; recentSpanDays: number | null }>> {
  const rows = await db
    .select({
      feedId: digestArticles.feedId,
      total: sql<number>`count(*)::int`,
      adopted: sql<number>`(count(*) FILTER (WHERE ${digestArticles.included}))::int`,
    })
    .from(digestArticles)
    .where(and(eq(digestArticles.userId, userId), isNotNull(digestArticles.feedId)))
    .groupBy(digestArticles.feedId);

  const recent = await db.execute(sql`
    WITH ranked AS (
      SELECT ${digestArticles.feedId} AS feed_id,
             ${digestArticles.publishedAt} AS published_at,
             row_number() OVER (
               PARTITION BY ${digestArticles.feedId}
               ORDER BY ${digestArticles.publishedAt} DESC
             ) AS rn
      FROM ${digestArticles}
      WHERE ${digestArticles.userId} = ${userId}
        AND ${digestArticles.feedId} IS NOT NULL
        AND ${digestArticles.publishedAt} IS NOT NULL
    )
    SELECT feed_id,
           count(*)::int AS recent_count,
           EXTRACT(EPOCH FROM (max(published_at) - min(published_at))) / 86400.0 AS recent_span_days
    FROM ranked
    WHERE rn <= ${RECENT_ARTICLES_FOR_CADENCE}
    GROUP BY feed_id
  `);
  const recentRows = (recent as unknown as { rows?: any[] }).rows ?? (recent as unknown as any[]);
  const cadence = new Map<number, { count: number; spanDays: number | null }>(
    recentRows.map((r: any) => [
      Number(r.feed_id),
      {
        count: Number(r.recent_count),
        spanDays: r.recent_span_days == null ? null : Number(r.recent_span_days),
      },
    ]),
  );

  return new Map(
    rows.map((r) => {
      const c = cadence.get(r.feedId as number);
      return [
        r.feedId as number,
        {
          total: r.total,
          adopted: r.adopted,
          recentCount: c?.count ?? 0,
          recentSpanDays: c?.spanDays ?? null,
        },
      ];
    }),
  );
}

router.get('/feeds', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const rows = await db
      .select({
        id: digestFeeds.id,
        title: digestFeeds.title,
        xmlUrl: digestFeeds.xmlUrl,
        htmlUrl: digestFeeds.htmlUrl,
        kind: digestFeeds.kind,
        category: digestFeeds.category,
        tier: digestFeeds.tier,
        status: digestFeeds.status,
        lastFetchedAt: digestFeeds.lastFetchedAt,
        lastPublishedAt: digestFeeds.lastPublishedAt,
        lastError: digestFeeds.lastError,
        errorCount: digestFeeds.errorCount,
        createdAt: digestFeeds.createdAt,
      })
      .from(digestFeeds)
      .where(eq(digestFeeds.userId, userId))
      .orderBy(desc(digestFeeds.createdAt));
    const counts = await articleCountsByFeed(userId);
    res.json(rows.map((r) => {
      const c = counts.get(r.id);
      return {
        ...r,
        articleCount: c?.total ?? 0,
        adoptedCount: c?.adopted ?? 0,
        healthWarning: feedHealthWarning({
          ...r,
          articleCount: c?.recentCount ?? 0,
          spanDays: c?.recentSpanDays ?? null,
        }),
      };
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/feeds', feedWriteLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { url, keyword, title, category, tier } = (req.body ?? {}) as {
      url?: string; keyword?: string; title?: string; category?: string; tier?: unknown;
    };
    if (tier !== undefined && !isFeedTier(tier)) {
      res.status(400).json({ error: '種別は none（分類しない）か primary（一次情報）を指定してください' });
      return;
    }

    const hasUrl = typeof url === 'string' && url.trim() !== '';
    const hasKeyword = typeof keyword === 'string' && keyword.trim() !== '';
    if (hasUrl === hasKeyword) {
      res.status(400).json({ error: 'url（RSSのURL）または keyword（Googleニュース検索）のどちらか一方を指定してください' });
      return;
    }

    const kind = hasKeyword ? 'gnews' : 'rss';
    const xmlUrl = hasKeyword ? buildGoogleNewsFeedUrl(keyword!.trim()) : url!.trim();
    if (!/^https?:\/\//.test(xmlUrl)) {
      res.status(400).json({ error: 'URLは http(s) で始まる必要があります' });
      return;
    }

    let fetched;
    try {
      fetched = await fetchFeed(xmlUrl);
    } catch (err) {
      res.status(422).json({ error: `フィードを取得できませんでした: ${feedErrorMessage(err)}` });
      return;
    }

    const feedTitle =
      (title && title.trim()) ||
      (kind === 'gnews' ? `Googleニュース: ${keyword!.trim()}` : fetched.feedTitle) ||
      xmlUrl;

    const [inserted] = await db
      .insert(digestFeeds)
      .values({
        userId,
        title: feedTitle,
        xmlUrl,
        kind,
        category: category?.trim() || null,
        tier: tier ?? 'none',
        origin: 'manual',
        lastFetchedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      res.status(409).json({ error: 'この情報源はすでに登録されています' });
      return;
    }
    res.status(201).json({ ...inserted, itemCount: fetched.items?.length ?? 0 });
  } catch (err) {
    next(err);
  }
});

router.patch('/feeds/:id', feedWriteLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const { url, title, category, tier } = (req.body ?? {}) as {
      url?: string; title?: string; category?: string; tier?: unknown;
    };
    if (tier !== undefined && !isFeedTier(tier)) {
      res.status(400).json({ error: '種別は none（分類しない）か primary（一次情報）を指定してください' });
      return;
    }

    const [feed] = await db
      .select()
      .from(digestFeeds)
      .where(and(eq(digestFeeds.id, id), eq(digestFeeds.userId, userId)));
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (typeof title === 'string' && title.trim()) patch.title = title.trim();
    if (typeof category === 'string') patch.category = category.trim() || null;
    if (tier !== undefined && tier !== feed.tier) patch.tier = tier;

    const wantsUrlChange = typeof url === 'string' && url.trim() !== '' && url.trim() !== feed.xmlUrl;
    if (wantsUrlChange) {
      const xmlUrl = url!.trim();
      if (!/^https?:\/\//.test(xmlUrl)) {
        res.status(400).json({ error: 'URLは http(s) で始まる必要があります' });
        return;
      }

      let fetched;
      try {
        fetched = await fetchFeed(xmlUrl);
      } catch (err) {
        res.status(422).json({
          error: `フィードを取得できませんでした: ${feedErrorMessage(err)}`,
        });
        return;
      }

      patch.xmlUrl = xmlUrl;
      patch.etag = null;
      patch.lastModified = null;
      patch.lastError = null;
      patch.errorCount = 0;
      if (feed.status === 'dead_candidate') patch.status = 'active';
      patch.lastFetchedAt = new Date();
      const candidate = latestPublishedAt((fetched.items ?? []).map((it) => it.publishedAt));
      const nextPublished = nextLastPublishedAt(feed.lastPublishedAt, candidate);
      if (nextPublished) patch.lastPublishedAt = nextPublished;
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: '変更する項目がありません' });
      return;
    }

    const [updated] = await db
      .update(digestFeeds)
      .set(patch)
      .where(and(eq(digestFeeds.id, id), eq(digestFeeds.userId, userId)))
      .returning();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

for (const [action, status] of [['pause', 'paused'], ['activate', 'active']] as const) {
  router.post(`/feeds/:id/${action}`, async (req, res, next) => {
    try {
      const userId = authUserId(req);
      const id = Number(req.params.id);
      const [updated] = await db
        .update(digestFeeds)
        .set({ status })
        .where(and(eq(digestFeeds.id, id), eq(digestFeeds.userId, userId)))
        .returning();
      if (!updated) {
        res.status(404).json({ error: 'Feed not found' });
        return;
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
}

router.delete('/feeds/:id', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [deleted] = await db
      .delete(digestFeeds)
      .where(and(eq(digestFeeds.id, id), eq(digestFeeds.userId, userId)))
      .returning({ id: digestFeeds.id });
    if (!deleted) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/articles', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const feedId = req.query.feedId ? Number(req.query.feedId) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = feedId
      ? and(eq(digestArticles.userId, userId), eq(digestArticles.feedId, feedId))
      : eq(digestArticles.userId, userId);

    const rows = await db
      .select({
        id: digestArticles.id,
        feedId: digestArticles.feedId,
        feedTitle: digestFeeds.title,
        title: digestArticles.title,
        url: digestArticles.url,
        publishedAt: digestArticles.publishedAt,
        summaryRaw: digestArticles.summaryRaw,
        fetchedAt: digestArticles.fetchedAt,
      })
      .from(digestArticles)
      .leftJoin(digestFeeds, eq(digestArticles.feedId, digestFeeds.id))
      .where(where)
      .orderBy(desc(sql`COALESCE(${digestArticles.publishedAt}, ${digestArticles.fetchedAt})`))
      .limit(limit)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(digestArticles)
      .where(where);

    res.json({ articles: rows, total: count });
  } catch (err) {
    next(err);
  }
});

router.get('/articles/ratings', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    const ratings: Record<number, 1 | -1> = {};
    if (ids.length > 0) {
      const rows = await db
        .select({ id: digestArticles.id, humanRating: digestArticles.humanRating })
        .from(digestArticles)
        .where(and(eq(digestArticles.userId, userId), inArray(digestArticles.id, ids)));
      for (const row of rows) {
        if (row.humanRating === 1 || row.humanRating === -1) ratings[row.id] = row.humanRating;
      }
    }
    res.json({ ratings });
  } catch (err) {
    next(err);
  }
});

const POLL_STALE_MS = 15 * 60_000;

router.post('/poll', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const profile = await getOrCreateProfile(userId);
    if (profile.pollStatus === 'running') {
      const startedAt = (profile.pollResult as { startedAt?: string } | null)?.startedAt;
      const stale = !startedAt || Date.now() - new Date(startedAt).getTime() > POLL_STALE_MS;
      if (!stale) {
        res.status(409).json({ error: '収集は実行中です', status: 'running' });
        return;
      }
    }
    await db.update(digestProfiles)
      .set({ pollStatus: 'running', pollResult: { startedAt: new Date().toISOString() } })
      .where(eq(digestProfiles.userId, userId));
    void runDigestJob('poll', [String(userId)], 15 * 60_000);
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

router.get('/poll-status', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const profile = await getOrCreateProfile(userId);
    const raw = profile.pollResult as Record<string, unknown> | null;
    res.json({
      status: profile.pollStatus ?? 'none',
      finishedAt: profile.pollFinishedAt,
      result: raw && typeof raw === 'object' && raw.feedCount != null
        ? {
            feedCount: Number(raw.feedCount) || 0,
            added: Number(raw.added) || 0,
            reattached: Number(raw.reattached) || 0,
            notModified: Number(raw.notModified) || 0,
            errorCount: Number(raw.errorCount) || 0,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/poll-debug', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const [articleCounts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        attached: sql<number>`(count(*) FILTER (WHERE ${digestArticles.feedId} IS NOT NULL))::int`,
        orphaned: sql<number>`(count(*) FILTER (WHERE ${digestArticles.feedId} IS NULL))::int`,
      })
      .from(digestArticles)
      .where(eq(digestArticles.userId, userId));
    const feedRows = await db
      .select({
        id: digestFeeds.id,
        title: digestFeeds.title,
        kind: digestFeeds.kind,
        status: digestFeeds.status,
        hasEtag: sql<boolean>`(${digestFeeds.etag} IS NOT NULL OR ${digestFeeds.lastModified} IS NOT NULL)`,
        lastFetchedAt: digestFeeds.lastFetchedAt,
        lastError: digestFeeds.lastError,
      })
      .from(digestFeeds)
      .where(eq(digestFeeds.userId, userId))
      .orderBy(desc(digestFeeds.createdAt));
    const counts = await articleCountsByFeed(userId);
    const feeds = feedRows.map((r) => ({ ...r, articleCount: counts.get(r.id)?.total ?? 0 }));
    const recentArticles = await db
      .select({
        id: digestArticles.id,
        feedId: digestArticles.feedId,
        title: digestArticles.title,
        fetchedAt: digestArticles.fetchedAt,
      })
      .from(digestArticles)
      .where(eq(digestArticles.userId, userId))
      .orderBy(desc(digestArticles.id))
      .limit(10);
    res.json({ userId, articleCounts, feeds, recentArticles });
  } catch (err) {
    next(err);
  }
});

router.get('/editions', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const rows = await db
      .select({
        id: digestEditions.id,
        editionDate: digestEditions.editionDate,
        status: digestEditions.status,
        format: digestEditions.format,
        title: digestEditions.title,
        articleCount: digestEditions.articleCount,
        isFirstIssue: digestEditions.isFirstIssue,
        growingNotice: digestEditions.growingNotice,
        generatedAt: digestEditions.generatedAt,
        createdAt: digestEditions.createdAt,
      })
      .from(digestEditions)
      .where(eq(digestEditions.userId, userId))
      .orderBy(desc(digestEditions.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/editions/latest', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const [row] = await db
      .select()
      .from(digestEditions)
      .where(and(eq(digestEditions.userId, userId), eq(digestEditions.status, 'done')))
      .orderBy(desc(digestEditions.createdAt))
      .limit(1);
    res.json(row ?? null);
  } catch (err) {
    next(err);
  }
});

router.get('/editions/:id', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(digestEditions)
      .where(and(eq(digestEditions.id, id), eq(digestEditions.userId, userId)));
    if (!row) {
      res.status(404).json({ error: 'Edition not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/editions/run', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const first = req.body?.first === true;
    const [{ count: feedCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(digestFeeds)
      .where(and(eq(digestFeeds.userId, userId), eq(digestFeeds.status, 'active')));
    if (feedCount === 0) {
      res.status(400).json({ error: '情報源がまだ登録されていません。先に情報源を追加してください' });
      return;
    }
    void runDigestJob('edition', first ? [String(userId), '--first'] : [String(userId)], 30 * 60_000);
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

async function getOrCreateProfile(userId: number) {
  const [existing] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
  if (existing) return existing;
  const [created] = await db
    .insert(digestProfiles)
    .values({ userId, settings: DEFAULT_SETTINGS })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
  return raced;
}

router.get('/profile', async (req, res, next) => {
  try {
    const profile = await getOrCreateProfile(authUserId(req));
    res.json({
      settings: normalizeSettings(profile.settings),
      onboardedAt: profile.onboardedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/profile', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const profile = await getOrCreateProfile(userId);
    const merged = normalizeSettings({ ...normalizeSettings(profile.settings), ...(req.body?.settings ?? {}) });
    const [updated] = await db
      .update(digestProfiles)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(digestProfiles.userId, userId))
      .returning();
    res.json({ settings: normalizeSettings(updated.settings), onboardedAt: updated.onboardedAt });
  } catch (err) {
    next(err);
  }
});

router.post('/articles/:id/rate', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const rating = (req.body ?? {}).rating;
    if (rating !== 1 && rating !== -1 && rating !== 0) {
      res.status(400).json({ error: 'rating は 1（👍）・-1（👎）・0（取り消し）のいずれかです' });
      return;
    }
    const reason = rating === 0 ? null : normalizeNote(req.body?.reason);
    const [updated] = await db
      .update(digestArticles)
      .set({ humanRating: rating === 0 ? null : rating })
      .where(and(eq(digestArticles.id, id), eq(digestArticles.userId, userId)))
      .returning({ id: digestArticles.id, humanRating: digestArticles.humanRating });
    if (!updated) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    if (reason) {
      try {
        await db.insert(digestFeedback).values({ userId, articleId: id, comment: reason });
      } catch (err) {
        console.error(`[Digest:rate] 評価理由の保存に失敗（評価は保存済み・article=${id}）:`, err);
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/chat', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const body = (req.body ?? {}) as { messages?: unknown; deep?: unknown; premium?: unknown; attachments?: unknown };
    const messages = body.messages;
    const valid = Array.isArray(messages)
      && messages.length > 0
      && messages.length <= 30
      && messages.every((m: unknown) => {
        const msg = m as { role?: unknown; content?: unknown };
        return (msg.role === 'user' || msg.role === 'assistant')
          && typeof msg.content === 'string'
          && msg.content.length > 0
          && msg.content.length <= MAX_CHAT_MESSAGE_CHARS;
      });
    if (!valid) {
      res.status(400).json({ error: `messages は {role: user|assistant, content: ${MAX_CHAT_MESSAGE_CHARS}字以内} の配列（1〜30件）で指定してください` });
      return;
    }
    const deep = body.deep === true;
    const premium = body.premium === true;
    const validated = validateAttachments(body.attachments);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    setUsageUser(userId);
    try {
      const result = await chatTurn(userId, messages, { deep, premium, attachments: validated.attachments });
      try {
        const lastUser = messages[messages.length - 1] as { role: string; content: string };
        if (lastUser?.role === 'user') {
          await appendChatMessage(userId, {
            role: 'user',
            content: lastUser.content,
            attachmentNames: validated.attachments.map((a) => a.name),
          });
        }
        await appendChatMessage(userId, {
          role: 'assistant',
          content: result.reply,
          proposalIds: result.proposals.map((p) => p.id),
        });
      } catch (err) {
        console.error('[Digest:chat] 会話履歴の保存に失敗（返答は返す）:', err);
      }
      res.json(result);
    } finally {
      setUsageUser(null);
    }
  } catch (err) {
    next(err);
  }
});

router.get('/coverage', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const raw = Number(req.query.days);
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(365, Math.floor(raw)) : DEFAULT_COVERAGE_DAYS;
    const text = await coverageFactsForUser(userId, { days });
    res.json({ days, text });
  } catch (err) {
    next(err);
  }
});

router.get('/chat/history', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    res.json(await loadChatHistory(userId));
  } catch (err) {
    next(err);
  }
});

router.get('/proposals', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where = status
      ? and(eq(digestSourceProposals.userId, userId), eq(digestSourceProposals.status, status))
      : eq(digestSourceProposals.userId, userId);
    const rows = await db
      .select()
      .from(digestSourceProposals)
      .where(where)
      .orderBy(desc(digestSourceProposals.createdAt));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/proposals/:id/approve', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [proposal] = await db
      .select()
      .from(digestSourceProposals)
      .where(and(eq(digestSourceProposals.id, id), eq(digestSourceProposals.userId, userId)));
    if (!proposal) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    if (proposal.status !== 'proposed') {
      res.status(409).json({ error: 'この提案はすでに処理済みです' });
      return;
    }

    try {
      await fetchFeed(proposal.xmlUrl);
    } catch (err) {
      res.status(422).json({ error: `フィードを取得できませんでした: ${feedErrorMessage(err)}` });
      return;
    }

    const [feed] = await db
      .insert(digestFeeds)
      .values({
        userId,
        title: proposal.title,
        xmlUrl: proposal.xmlUrl,
        kind: proposal.kind,
        category: proposal.category,
        tier: 'none',
        origin: 'proposal',
        lastFetchedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (!feed) {
      res.status(409).json({ error: 'この情報源はすでに登録されています' });
      return;
    }

    const [updated] = await db
      .update(digestSourceProposals)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(digestSourceProposals.id, id))
      .returning();

    const [profile] = await db.select().from(digestProfiles).where(eq(digestProfiles.userId, userId));
    if (!profile) {
      await db.insert(digestProfiles)
        .values({ userId, settings: {}, onboardedAt: new Date() })
        .onConflictDoNothing();
    } else if (!profile.onboardedAt) {
      await db.update(digestProfiles)
        .set({ onboardedAt: new Date(), updatedAt: new Date() })
        .where(eq(digestProfiles.userId, userId));
    }

    res.json({ proposal: updated, feed });
  } catch (err) {
    next(err);
  }
});

router.post('/proposals/:id/reject', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [updated] = await db
      .update(digestSourceProposals)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(and(
        eq(digestSourceProposals.id, id),
        eq(digestSourceProposals.userId, userId),
        eq(digestSourceProposals.status, 'proposed'),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: '未処理の提案が見つかりません' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.get('/review-status', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const signals = await countReviewSignals(userId);
    const [latest] = await db
      .select({
        id: digestEditorialProposals.id,
        status: digestEditorialProposals.status,
        createdAt: digestEditorialProposals.createdAt,
      })
      .from(digestEditorialProposals)
      .where(eq(digestEditorialProposals.userId, userId))
      .orderBy(desc(digestEditorialProposals.createdAt))
      .limit(1);
    res.json({
      signalsSinceLastReview: signals.total,
      threshold: REVIEW_THRESHOLD,
      lastReviewAt: signals.lastReviewAt,
      latestProposal: latest ?? null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/editorial-proposals', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const rows = await db
      .select()
      .from(digestEditorialProposals)
      .where(eq(digestEditorialProposals.userId, userId))
      .orderBy(desc(digestEditorialProposals.createdAt));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

async function decideEditorialProposal(
  userId: number,
  id: number,
  decision: 'approved' | 'dismissed',
  note: string | null,
) {
  const [updated] = await db
    .update(digestEditorialProposals)
    .set({ status: decision, note, decidedAt: new Date() })
    .where(and(
      eq(digestEditorialProposals.id, id),
      eq(digestEditorialProposals.userId, userId),
      eq(digestEditorialProposals.status, 'proposed'),
    ))
    .returning();
  if (updated && note) {
    await db.insert(digestFeedback).values({
      userId,
      comment: `【編集方針提案#${id}への修正意見（${decision === 'approved' ? '承認' : '見送り'}時）】${note}`,
    });
  }
  return updated;
}

function normalizeNote(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 4000) : null;
}

async function currentEditorialProfile(userId: number): Promise<string> {
  const [profile] = await db
    .select({ editorialProfile: digestProfiles.editorialProfile })
    .from(digestProfiles)
    .where(eq(digestProfiles.userId, userId));
  return profile?.editorialProfile || DEFAULT_EDITORIAL_PROFILE;
}

router.get('/editorial-proposals/:id/thread', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const thread = await loadProposalThread(userId, Number(req.params.id));
    if (!thread) {
      res.status(404).json({ error: '提案が見つかりません' });
      return;
    }
    const currentProfile = await currentEditorialProfile(userId);
    res.json({
      ...thread,
      constitutionDiff: constitutionDiff(thread.draft, currentProfile),
      problems: validateProfile(thread.draft, currentProfile),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/editorial-profile/versions', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const versions = await listProfileVersions(userId);
    const current = await currentEditorialProfile(userId);
    res.json({
      current: { content: current, ...describeProfile(current) },
      versions: versions.map((v) => ({ ...v, ...describeProfile(v.content) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/editorial-profile/restore', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const proposalId = Number(req.body?.proposalId);
    if (!Number.isInteger(proposalId)) {
      res.status(400).json({ error: '戻す版を指定してください' });
      return;
    }
    const versions = await listProfileVersions(userId, 100);
    const target = versions.find((v) => v.proposalId === proposalId);
    if (!target) {
      res.status(404).json({ error: 'その版が見つかりません' });
      return;
    }
    const problems = validateProfile(target.content, '');
    if (problems.length > 0) {
      res.status(422).json({ error: 'この版には戻せません', problems });
      return;
    }
    await db.update(digestProfiles)
      .set({ editorialProfile: target.content, updatedAt: new Date() })
      .where(eq(digestProfiles.userId, userId));
    console.log(`[Digest:editorial] 編集方針を過去の版に戻した user=${userId} proposal=${proposalId}`);
    res.json({ ok: true, restoredFrom: proposalId, chars: target.content.length });
  } catch (err) {
    next(err);
  }
});

router.post('/editorial-proposals/:id/messages', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE_CHARS) {
      res.status(400).json({ error: `指摘は1〜${MAX_MESSAGE_CHARS}字で入力してください` });
      return;
    }

    const thread = await loadProposalThread(userId, id);
    if (!thread) {
      res.status(404).json({ error: '提案が見つかりません' });
      return;
    }
    if (thread.status !== 'proposed') {
      res.status(409).json({ error: 'この提案はすでに承認・見送り済みです' });
      return;
    }

    const currentProfile = await currentEditorialProfile(userId);
    const coverageText = await coverageFactsForUserSafe(userId);
    await appendProposalMessage(userId, id, { role: 'user', content: message });

    setUsageUser(userId);
    try {
      const result = await reviseProposal({
        currentProfile,
        draftProfile: thread.draft,
        history: [...toTurns(thread.messages), { role: 'user', content: message }],
        coverageText,
      });
      await appendProposalMessage(userId, id, {
        role: 'assistant',
        content: result.reply,
        revisedProfile: result.revisedProfile,
      });
      const updated = await loadProposalThread(userId, id);
      res.json(updated);
    } finally {
      setUsageUser(null);
    }
  } catch (err) {
    next(err);
  }
});

router.post('/editorial-proposals/:id/approve', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const note = normalizeNote(req.body?.note);
    const seenRevisionId = Number.isInteger(req.body?.revisionId) ? Number(req.body.revisionId) : null;

    const thread = await loadProposalThread(userId, id);
    if (!thread || thread.status !== 'proposed') {
      res.status(404).json({ error: '未処理の提案が見つかりません' });
      return;
    }
    if (seenRevisionId !== null && seenRevisionId !== thread.revisionId) {
      res.status(409).json({
        error: '案がその後更新されています。最新の内容を確認してから承認してください',
        revisionId: thread.revisionId,
      });
      return;
    }

    const currentProfile = await currentEditorialProfile(userId);
    const problems = validateProfile(thread.draft, currentProfile);
    if (problems.length > 0) {
      console.warn(`[Digest:editorial] 保存前の検査で差し止め user=${userId} proposal=${id}: ${problems.join(' / ')}`);
      res.status(422).json({ error: 'この改定案は保存できません', problems });
      return;
    }

    const updated = await decideEditorialProposal(userId, id, 'approved', note);
    if (!updated) {
      res.status(404).json({ error: '未処理の提案が見つかりません' });
      return;
    }
    const applied = await db
      .update(digestProfiles)
      .set({ editorialProfile: thread.draft, updatedAt: new Date() })
      .where(eq(digestProfiles.userId, userId))
      .returning({ userId: digestProfiles.userId });
    if (applied.length === 0) {
      await db.insert(digestProfiles)
        .values({ userId, settings: {}, editorialProfile: thread.draft })
        .onConflictDoNothing();
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/editorial-proposals/:id/dismiss', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const note = normalizeNote(req.body?.note);
    const thread = await loadProposalThread(userId, id);
    const updated = await decideEditorialProposal(userId, id, 'dismissed', note);
    if (!updated) {
      res.status(404).json({ error: '未処理の提案が見つかりません' });
      return;
    }
    const carriedOver = (thread?.messages ?? []).filter((m) => m.role === 'user');
    if (carriedOver.length > 0) {
      await db.insert(digestFeedback).values(
        carriedOver.map((m) => ({
          userId,
          comment: `【編集方針提案#${id}（見送り）での指摘】${m.content}`,
        })),
      );
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.post('/articles/:id/research', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const articleId = Number(req.params.id);
    const [article] = await db
      .select({ id: digestArticles.id })
      .from(digestArticles)
      .where(and(eq(digestArticles.id, articleId), eq(digestArticles.userId, userId)));
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    const [existing] = await db
      .select({ id: digestResearch.id, status: digestResearch.status })
      .from(digestResearch)
      .where(and(eq(digestResearch.userId, userId), eq(digestResearch.articleId, articleId)));
    if (existing && existing.status !== 'failed') {
      res.status(409).json({
        error: existing.status === 'done' ? 'この記事のレポートは完成済みです' : 'この記事は調査中です',
        researchId: existing.id,
        status: existing.status,
      });
      return;
    }

    await db
      .insert(digestResearch)
      .values({ userId, articleId, status: 'pending' })
      .onConflictDoUpdate({
        target: [digestResearch.userId, digestResearch.articleId],
        set: { status: 'pending', report: null, requestedAt: new Date(), completedAt: null },
      });

    void runDigestJob('research', [String(userId), String(articleId)], 10 * 60_000);
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

router.get('/research', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const rows = await db
      .select({
        id: digestResearch.id,
        articleId: digestResearch.articleId,
        status: digestResearch.status,
        visualStatus: digestResearch.visualStatus,
        requestedAt: digestResearch.requestedAt,
        completedAt: digestResearch.completedAt,
        articleTitle: digestArticles.title,
        articleSummary: digestArticles.summary,
        articleUrl: digestArticles.url,
      })
      .from(digestResearch)
      .leftJoin(digestArticles, eq(digestResearch.articleId, digestArticles.id))
      .where(eq(digestResearch.userId, userId))
      .orderBy(desc(digestResearch.requestedAt));
    res.json(rows.map((r) => ({
      id: r.id,
      articleId: r.articleId,
      headline: articleHeadline(r.articleSummary, r.articleTitle ?? ''),
      articleUrl: r.articleUrl,
      status: r.status,
      visual: r.visualStatus ?? 'none',
      requestedAt: r.requestedAt,
      completedAt: r.completedAt,
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/research/:id', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [row] = await db
      .select({
        id: digestResearch.id,
        articleId: digestResearch.articleId,
        status: digestResearch.status,
        report: digestResearch.report,
        visualStatus: digestResearch.visualStatus,
        requestedAt: digestResearch.requestedAt,
        completedAt: digestResearch.completedAt,
        articleTitle: digestArticles.title,
        articleSummary: digestArticles.summary,
        articleUrl: digestArticles.url,
      })
      .from(digestResearch)
      .leftJoin(digestArticles, eq(digestResearch.articleId, digestArticles.id))
      .where(and(eq(digestResearch.id, id), eq(digestResearch.userId, userId)));
    if (!row) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({
      id: row.id,
      articleId: row.articleId,
      headline: articleHeadline(row.articleSummary, row.articleTitle ?? ''),
      articleUrl: row.articleUrl,
      status: row.status,
      report: row.report,
      visual: row.visualStatus ?? 'none',
      requestedAt: row.requestedAt,
      completedAt: row.completedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/research/:id/visual', digestAiLimiter, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [row] = await db
      .select({ id: digestResearch.id, status: digestResearch.status, visualStatus: digestResearch.visualStatus })
      .from(digestResearch)
      .where(and(eq(digestResearch.id, id), eq(digestResearch.userId, userId)));
    if (!row) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    if (row.status !== 'done') {
      res.status(400).json({ error: 'レポートがまだ完成していません' });
      return;
    }
    if (row.visualStatus === 'running' || row.visualStatus === 'done') {
      res.status(409).json({
        error: row.visualStatus === 'done' ? 'ビジュアル版は作成済みです' : 'ビジュアル版を作成中です',
        status: row.visualStatus,
      });
      return;
    }

    await db.update(digestResearch).set({ visualStatus: 'running' }).where(eq(digestResearch.id, id));
    void runDigestJob('research-visual', [String(userId), String(id)], 10 * 60_000);
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

router.get('/research/:id/visual', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number(req.params.id);
    const [row] = await db
      .select({ visualStatus: digestResearch.visualStatus, visualHtml: digestResearch.visualHtml })
      .from(digestResearch)
      .where(and(eq(digestResearch.id, id), eq(digestResearch.userId, userId)));
    if (!row || row.visualStatus !== 'done' || !row.visualHtml) {
      res.status(404).json({ error: 'Visual report not found' });
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(row.visualHtml);
  } catch (err) {
    next(err);
  }
});

async function ownEdition(userId: number, editionId: number) {
  const [edition] = await db
    .select({
      id: digestEditions.id,
      status: digestEditions.status,
      articleCount: digestEditions.articleCount,
    })
    .from(digestEditions)
    .where(and(eq(digestEditions.id, editionId), eq(digestEditions.userId, userId)));
  return edition;
}

router.post('/editions/:id/podcast', digestAiLimiter, async (req, res, next) => {
  try {
    if (!serverFeatures().podcast) {
      res.status(503).json({ error: '音声版を作るには、サーバに GEMINI_API_KEY の設定が必要です' });
      return;
    }
    const userId = authUserId(req);
    const editionId = Number(req.params.id);
    const edition = await ownEdition(userId, editionId);
    if (!edition) {
      res.status(404).json({ error: 'Edition not found' });
      return;
    }
    if (edition.status !== 'done') {
      res.status(409).json({ error: 'この号はまだ完成していません', status: edition.status });
      return;
    }
    if (edition.articleCount === 0) {
      res.status(400).json({ error: 'この号には音声化する記事がありません' });
      return;
    }

    const [existing] = await db
      .select({ id: digestPodcasts.id, status: digestPodcasts.status })
      .from(digestPodcasts)
      .where(eq(digestPodcasts.editionId, editionId));
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      res.status(409).json({ error: 'この号の音声版は生成中です', status: existing.status });
      return;
    }

    const reusesScript = req.body?.reuse === true;

    await db
      .insert(digestPodcasts)
      .values({ userId, editionId, status: 'pending' })
      .onConflictDoUpdate({
        target: digestPodcasts.editionId,
        set: { status: 'pending', completedAt: null },
      });

    const args = [String(userId), String(editionId)];
    if (reusesScript) args.push('--reuse');
    void runDigestJob('podcast', args, 30 * 60_000);
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

router.get('/editions/:id/podcast', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const editionId = Number(req.params.id);
    const edition = await ownEdition(userId, editionId);
    if (!edition) {
      res.status(404).json({ error: 'Edition not found' });
      return;
    }
    const [row] = await db
      .select({
        id: digestPodcasts.id,
        status: digestPodcasts.status,
        mimeType: digestPodcasts.mimeType,
        durationSec: digestPodcasts.durationSec,
        audioBytes: sql<number | null>`octet_length(${digestPodcasts.audio})::int`,
        createdAt: digestPodcasts.createdAt,
        completedAt: digestPodcasts.completedAt,
      })
      .from(digestPodcasts)
      .where(and(eq(digestPodcasts.editionId, editionId), eq(digestPodcasts.userId, userId)));
    if (!row) {
      res.json({ status: 'none' });
      return;
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get('/editions/:id/podcast/audio', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const editionId = Number(req.params.id);
    const [row] = await db
      .select({
        id: digestPodcasts.id,
        status: digestPodcasts.status,
        mimeType: digestPodcasts.mimeType,
        completedAt: digestPodcasts.completedAt,
        size: sql<number | null>`octet_length(${digestPodcasts.audio})`,
      })
      .from(digestPodcasts)
      .where(and(eq(digestPodcasts.editionId, editionId), eq(digestPodcasts.userId, userId)));
    if (!row || row.status !== 'done' || !row.size) {
      res.status(404).json({ error: 'Podcast audio not found' });
      return;
    }

    const size = Number(row.size);
    const mimeType = row.mimeType ?? 'audio/wav';
    const etag = `"podcast-${row.id}-${row.completedAt ? row.completedAt.getTime() : 0}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    const range = parseRange(req.headers.range, size);
    if (range && 'unsatisfiable' in range) {
      res.setHeader('Content-Range', `bytes */${size}`);
      res.status(416).end();
      return;
    }

    const { from, length, start, end } = byteaSliceParams(range, size);
    const [chunk] = await db
      .select({
        bytes: sql<Buffer>`substring(${digestPodcasts.audio} from ${from} for ${length})`,
      })
      .from(digestPodcasts)
      .where(eq(digestPodcasts.id, row.id));
    if (!chunk?.bytes) {
      res.status(404).json({ error: 'Podcast audio not found' });
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(length));
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.end(chunk.bytes);
  } catch (err) {
    next(err);
  }
});

router.get('/usage/summary', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const rows: UsageAggRow[] = await db
      .select({
        stage: digestUsage.stage,
        model: digestUsage.model,
        inputTokens: sql<number>`sum(${digestUsage.inputTokens})::int`,
        outputTokens: sql<number>`sum(${digestUsage.outputTokens})::int`,
        cacheCreationInputTokens: sql<number>`sum(${digestUsage.cacheCreationInputTokens})::int`,
        cacheReadInputTokens: sql<number>`sum(${digestUsage.cacheReadInputTokens})::int`,
      })
      .from(digestUsage)
      .where(and(eq(digestUsage.userId, userId), gte(digestUsage.createdAt, jstMonthStart())))
      .groupBy(digestUsage.stage, digestUsage.model);
    res.json(buildUsageSummary(rows));
  } catch (err) {
    next(err);
  }
});

export default router;
