import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileSearch, Loader2, MessageSquarePlus, Search, Sprout, ThumbsDown, ThumbsUp } from 'lucide-react';
import type {
  DigestEdition,
  DigestEditionArticle,
  DigestEditionOtherArticle,
  DigestPodcastInfo,
  DigestResearchSummary,
} from 'shared';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { cn } from '../../lib/utils';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { isResearchActive, useResearchList } from '../../hooks/useDigestResearch';
import { api } from '../../lib/api';
import { safeHref } from '@/lib/safeHref';
import { useServerFeatures } from '../../hooks/useServerFeatures';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const PODCAST_POLL_MS = 15_000;

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${s}秒`;
}

function PodcastRow({ editionId }: { editionId: number }) {
  const features = useServerFeatures();
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const podcastQuery = useQuery<DigestPodcastInfo>({
    queryKey: ['digest', 'editions', editionId, 'podcast'],
    queryFn: () => api.digest.podcast(editionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? PODCAST_POLL_MS : false;
    },
  });
  const podcast = podcastQuery.data;

  const startMutation = useMutation({
    mutationFn: (reuse?: boolean) => api.digest.startPodcast(editionId, reuse),
    onSuccess: (result) => {
      if (result.started) {
        toast({ title: '音声版を作っています（数分かかります）' });
      } else if (result.status === 'done') {
        toast({ title: 'この号の音声版はすでに完成しています' });
      } else {
        toast({ title: 'この号の音声版はすでに作成中です' });
      }
      qc.invalidateQueries({ queryKey: ['digest', 'editions', editionId, 'podcast'] });
    },
    onError: (err: Error) => {
      toast({
        title: '音声版を作れませんでした',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  if (!podcast) return null;

  if (podcast.status === 'pending' || podcast.status === 'running' || startMutation.isPending) {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        音声版を作っています…
      </p>
    );
  }

  if (podcast.status === 'done') {
    const regenerate = async (reuse: boolean) => {
      const ok = await confirm({
        title: reuse ? '音声だけ作り直しますか？' : '台本から作り直しますか？',
        description: reuse
          ? '保存済みの台本はそのまま使い、音声合成だけをやり直します（数分）。'
            + '読み上げの不具合を直したいときはこちら'
          : '台本を作り直してから音声にします（数分）。'
            + '冒頭の挨拶が無い・記事の内容がおかしいなど、台本そのものを直したいときはこちら',
        confirmText: '作り直す',
      });
      if (ok) startMutation.mutate(reuse);
    };
    return (
      <div>
        <PodcastPlayer editionId={editionId} durationSec={podcast.durationSec} />
        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>作り直す:</span>
          <button type="button" onClick={() => regenerate(true)} className="underline hover:text-foreground">
            音声だけ
          </button>
          <span>/</span>
          <button type="button" onClick={() => regenerate(false)} className="underline hover:text-foreground">
            台本から
          </button>
        </p>
      </div>
    );
  }

  const expired = podcast.status === 'expired';

  const startWithConfirm = async () => {
    const ok = await confirm({
      title: expired ? '音声版をもう一度作りますか？' : '音声版（ポッドキャスト）を作りますか？',
      description: expired
        ? '保存期間を過ぎたため音声は削除されています。台本は残っているので、'
          + '音声合成だけを実行します（数分）。'
          + '完成するとこの場で再生できます'
        : '2人の話者が対話形式で紙面を紹介する音声番組を作ります（数分）。'
          + (features.email ? '完成するとこの場で再生でき、メールでもお知らせします' : '完成するとこの場で再生できます'),
      confirmText: expired ? '作り直す' : '作成する',
    });
    if (ok) startMutation.mutate(expired);
  };

  return (
    <p className="mt-3">
      <button
        type="button"
        onClick={startWithConfirm}
        className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={
          expired
            ? '保存期間を過ぎたため音声は削除されました。台本は残っているので安く作り直せます'
            : podcast.status === 'failed'
              ? '前回の音声版の作成は失敗しました。もう一度作れます'
              : 'この号をポッドキャスト風の音声にします（数分かかります）'
        }
      >
        {expired ? '🎧 音声版を作り直す（保存期間切れ）'
          : podcast.status === 'failed' ? '🎧 音声版を再生成' : '🎧 音声版を作る'}
      </button>
    </p>
  );
}

const RESUME_MIN_SEC = 3;
const RESUME_TAIL_SEC = 5;

function posKey(editionId: number): string {
  return `digestPodcastPos:${editionId}`;
}

function savedPosition(editionId: number): number | null {
  try {
    const v = Number(localStorage.getItem(posKey(editionId)));
    return Number.isFinite(v) && v > RESUME_MIN_SEC ? v : null;
  } catch {
    return null;
  }
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function PodcastPlayer({ editionId, durationSec }: { editionId: number; durationSec: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSavedRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [resumeNote, setResumeNote] = useState<string | null>(() => {
    const pos = savedPosition(editionId);
    return pos != null ? `前回の続き（${formatClock(pos)}）から再生します` : null;
  });

  const save = useCallback(() => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    try {
      if (el.currentTime > RESUME_MIN_SEC && el.currentTime < el.duration - RESUME_TAIL_SEC) {
        localStorage.setItem(posKey(editionId), String(el.currentTime));
      }
    } catch {
    }
  }, [editionId]);

  useEffect(() => {
    window.addEventListener('pagehide', save);
    return () => {
      save();
      window.removeEventListener('pagehide', save);
    };
  }, [save]);

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">
          🎧<span className="hidden sm:inline"> 音声版
            {durationSec != null && <>（{formatDuration(durationSec)}）</>}
          </span>
        </span>
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={api.digest.podcastAudioUrl(editionId)}
          className="h-9 min-w-0 flex-1 basis-64"
          onWaiting={() => setLoading(true)}
          onPlaying={() => setLoading(false)}
          onCanPlay={() => setLoading(false)}
          onError={() => setLoading(false)}
          onLoadedMetadata={() => {
            const el = audioRef.current;
            const pos = savedPosition(editionId);
            if (el && pos != null && Number.isFinite(el.duration) && pos < el.duration - RESUME_TAIL_SEC) {
              el.currentTime = pos;
            }
          }}
          onTimeUpdate={() => {
            const now = Date.now();
            if (now - lastSavedRef.current > 2000) {
              lastSavedRef.current = now;
              save();
            }
          }}
          onPause={save}
          onEnded={() => {
            try {
              localStorage.removeItem(posKey(editionId));
            } catch {
            }
            setResumeNote(null);
          }}
        >
          お使いのブラウザは音声再生に対応していません。
        </audio>
      </div>
      {loading ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
          音声を読み込み中…
        </p>
      ) : (
        resumeNote && <p className="mt-1 text-xs text-muted-foreground">{resumeNote}</p>
      )}
    </div>
  );
}

type Rating = 1 | -1;

function RatingButtons({
  articleId,
  persisted,
  onRated,
}: {
  articleId: number;
  persisted: Rating | undefined;
  onRated: (articleId: number, rating: Rating | 0) => void;
}) {
  const { toast } = useToast();
  const [override, setOverride] = useState<Rating | 0 | null>(null);
  const current: Rating | null =
    override !== null ? (override === 0 ? null : override) : (persisted ?? null);

  const rateMutation = useMutation({
    mutationFn: (rating: 1 | -1 | 0) => api.digest.rateArticle(articleId, rating),
    onMutate: (rating) => {
      const prev = override;
      setOverride(rating);
      return { prev };
    },
    onError: (err: Error, _rating, context) => {
      setOverride(context?.prev ?? null);
      toast({ title: '評価を保存できませんでした', description: err.message, variant: 'destructive' });
    },
    onSuccess: (_data, rating) => {
      onRated(articleId, rating);
      setOverride(null);
    },
  });

  const toggle = (value: Rating) => {
    if (rateMutation.isPending) return;
    rateMutation.mutate(current === value ? 0 : value);
    if (current === value) setReasonOpen(false);
  };

  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonSaved, setReasonSaved] = useState(false);

  const reasonMutation = useMutation({
    mutationFn: (text: string) => api.digest.rateArticle(articleId, (current ?? 1) as Rating, text),
    onSuccess: () => {
      setReasonOpen(false);
      setReasonSaved(true);
      setReason('');
      toast({ title: '理由を保存しました', description: '週末の編集会議で参考にします' });
    },
    onError: (err: Error) => {
      toast({ title: '理由を保存できませんでした', description: err.message, variant: 'destructive' });
    },
  });

  const buttonClass = (value: Rating) =>
    cn(
      'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
      current === value &&
        'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-500'
    );
  const iconClass = (value: Rating) => cn('w-3.5 h-3.5', current === value && 'fill-yellow-400');

  return (
    <span className="inline-flex items-center gap-0.5" title="この記事を評価して紙面を育てる">
      <button
        type="button"
        onClick={() => toggle(1)}
        className={buttonClass(1)}
        aria-label="この記事を評価する（良い）"
        aria-pressed={current === 1}
      >
        <ThumbsUp className={iconClass(1)} />
      </button>
      <button
        type="button"
        onClick={() => toggle(-1)}
        className={buttonClass(-1)}
        aria-label="この記事を評価する（合わない）"
        aria-pressed={current === -1}
      >
        <ThumbsDown className={iconClass(-1)} />
      </button>

      {current !== null && (
        <button
          type="button"
          onClick={() => setReasonOpen(true)}
          className={cn(
            'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            reasonSaved && 'text-yellow-500 hover:text-yellow-500'
          )}
          aria-label="この評価の理由を書く（任意）"
          title={reasonSaved ? '理由を書きました（追記できます）' : '理由を書く（任意）'}
        >
          <MessageSquarePlus className="w-3.5 h-3.5" />
        </button>
      )}

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{current === 1 ? '👍 この記事が良かった理由' : '👎 この記事が合わない理由'}（任意）</DialogTitle>
            <DialogDescription>
              書いていただいた理由は、週末の編集会議でAIが読み、次号からの編集方針の案に反映します。
              一言で構いません（例: 前日と同じ話題で新しい事実がない／数字が入っていて判断に使える）。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="理由を書く（空のままなら保存しません）"
            maxLength={4000}
            rows={4}
            autoFocus
            disabled={reasonMutation.isPending}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonOpen(false)} disabled={reasonMutation.isPending}>
              閉じる
            </Button>
            <Button
              onClick={() => reasonMutation.mutate(reason.trim())}
              disabled={reasonMutation.isPending || reason.trim() === ''}
            >
              {reasonMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              保存する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </span>
  );
}

function ResearchButton({
  articleId,
  research,
  onOpenResearch,
}: {
  articleId: number;
  research: DigestResearchSummary | undefined;
  onOpenResearch?: (researchId: number) => void;
}) {
  const features = useServerFeatures();
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const startMutation = useMutation({
    mutationFn: () => api.digest.startResearch(articleId),
    onSuccess: (result) => {
      if (result.started) {
        toast({ title: '深掘りリサーチを開始しました（数分で完成します）' });
      } else if (result.status === 'done') {
        onOpenResearch?.(result.researchId);
        return;
      } else {
        toast({ title: 'この記事はすでに調査中です', description: '完成すると「深掘り」タブで読めます' });
      }
      qc.invalidateQueries({ queryKey: ['digest', 'research'] });
    },
    onError: (err: Error) => {
      toast({
        title: '深掘りリサーチを依頼できませんでした',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  if ((research && isResearchActive(research.status)) || startMutation.isPending) {
    return (
      <span
        className="inline-flex items-center p-1 text-muted-foreground"
        title="深掘りリサーチを実施中です（数分かかります）"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      </span>
    );
  }

  if (research?.status === 'done') {
    return (
      <button
        type="button"
        onClick={() => onOpenResearch?.(research.id)}
        className="inline-flex items-center gap-1 rounded p-1 text-primary transition-colors hover:bg-primary/10"
        title="深掘りレポートが完成しています"
      >
        <FileSearch className="w-3.5 h-3.5" />
        <span className="text-xs">レポート</span>
      </button>
    );
  }

  const startWithConfirm = async () => {
    const ok = await confirm({
      title: '深掘りリサーチを開始しますか？',
      description:
        'AIがWeb検索でこの記事を深く調べ、続けて図解付きのビジュアル版まで作成します。' +
        (features.email ? '完成すると「深掘り」タブとメールでお知らせします' : '完成すると「深掘り」タブでお知らせします'),
      confirmText: '開始する',
    });
    if (ok) startMutation.mutate();
  };

  return (
    <button
      type="button"
      onClick={startWithConfirm}
      className="inline-flex items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label="この記事を深掘りリサーチする"
      title={
        research?.status === 'failed'
          ? '前回の調査は失敗しました。もう一度依頼できます'
          : 'この記事をAIが深く調べてレポートにします'
      }
    >
      <Search className="w-3.5 h-3.5" />
      <span className="text-xs">深掘り</span>
    </button>
  );
}

function EditionArticleItem({
  article,
  rating,
  onRated,
  research,
  onOpenResearch,
}: {
  article: DigestEditionArticle;
  rating: Rating | undefined;
  onRated: (articleId: number, rating: Rating | 0) => void;
  research: DigestResearchSummary | undefined;
  onOpenResearch?: (researchId: number) => void;
}) {
  return (
    <article className="py-4 first:pt-0 last:pb-0">
      <h4 className="font-serif text-base font-bold leading-snug">{article.headline}</h4>
      {article.lead && (
        <p className="mt-1 text-sm font-medium text-foreground/90">{article.lead}</p>
      )}
      {article.body && (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{article.body}</p>
      )}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {article.sourceTitle && <span>出典: {article.sourceTitle}</span>}
        {article.sourceCount != null && article.sourceCount > 1 && (
          <span
            className="rounded bg-muted px-1.5 py-0.5"
            title={`${article.sourceCount}つの情報源が同時に報じた話題です（重要度のシグナル）`}
          >
            📶 {article.sourceCount}媒体
          </span>
        )}
        <a
          href={safeHref(article.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          元記事を読む
          <ExternalLink className="w-3 h-3" />
        </a>
        <RatingButtons articleId={article.articleId} persisted={rating} onRated={onRated} />
        <ResearchButton
          articleId={article.articleId}
          research={research}
          onOpenResearch={onOpenResearch}
        />
      </p>
    </article>
  );
}

function formatShortDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function OtherArticleRow({
  article,
  rating,
  onRated,
  research,
  onOpenResearch,
}: {
  article: DigestEditionOtherArticle;
  rating: Rating | undefined;
  onRated: (articleId: number, rating: Rating | 0) => void;
  research: DigestResearchSummary | undefined;
  onOpenResearch?: (researchId: number) => void;
}) {
  const when = formatShortDateTime(article.publishedAt);
  const domain = (() => {
    try {
      return new URL(article.url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  })();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-2 text-sm">
      <a
        href={safeHref(article.url)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium hover:underline"
        title={article.sourceTitle ? `出典: ${article.sourceTitle}` : undefined}
      >
        {article.headline}
      </a>
      <span className="text-xs text-muted-foreground">
        {when && <>{when}・</>}
        {domain ?? article.sourceTitle ?? ''}
      </span>
      <RatingButtons articleId={article.articleId} persisted={rating} onRated={onRated} />
      <ResearchButton articleId={article.articleId} research={research} onOpenResearch={onOpenResearch} />
    </div>
  );
}

export function EditionView({
  edition,
  onOpenResearch,
}: {
  edition: DigestEdition;
  onOpenResearch?: (researchId: number) => void;
}) {
  const content = edition.content;
  const queryClient = useQueryClient();
  const features = useServerFeatures();

  const { data: researchList } = useResearchList();
  const researchByArticle = useMemo(() => {
    const map = new Map<number, DigestResearchSummary>();
    for (const r of researchList ?? []) map.set(r.articleId, r);
    return map;
  }, [researchList]);

  const articleIds = useMemo(
    () => [...new Set([
      ...(content?.sections ?? []).flatMap((s) => s.articles.map((a) => a.articleId)),
      ...(content?.others ?? []).flatMap((s) => s.articles.map((a) => a.articleId)),
    ])],
    [content]
  );
  const { data: articleRatings } = useQuery({
    queryKey: ['digest', 'articleRatings', edition.id],
    queryFn: async () => (await api.digest.articleRatings(articleIds)).ratings,
    enabled: articleIds.length > 0,
  });

  const handleRated = useCallback(
    (articleId: number, rating: Rating | 0) => {
      queryClient.setQueryData<Record<number, Rating>>(
        ['digest', 'articleRatings', edition.id],
        (old) => {
          const map = { ...(old ?? {}) };
          if (rating === 0) delete map[articleId];
          else map[articleId] = rating;
          return map;
        }
      );
      queryClient.invalidateQueries({ queryKey: ['digest', 'review-status'] });
    },
    [queryClient, edition.id]
  );

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
      <header className="border-b-2 border-foreground/80 pb-3">
        <h2 className="font-serif text-2xl font-bold tracking-wide">{edition.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatDateTime(edition.generatedAt ?? edition.createdAt)} 発行
          {content && <>・情報源 {content.sourceCount} 件・候補 {content.candidateCount} 本から選定</>}
        </p>
        {content?.coverage && (
          <p className="mt-0.5 text-xs text-muted-foreground">記事対象期間: {content.coverage}</p>
        )}
      </header>

      {edition.status === 'done' && edition.articleCount > 0 && features.podcast && (
        <div className="sticky top-[var(--app-header-h,64px)] z-40 -mx-4 border-b border-border bg-background px-4">
          <PodcastRow editionId={edition.id} />
        </div>
      )}

      {edition.growingNotice && (
        <div className="mt-4 flex items-start gap-2 rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          <Sprout className="mt-0.5 w-4 h-4 shrink-0 text-primary" />
          <p>この朝刊は育てている途中です。情報源と評価が増えるほど紙面は良くなります</p>
        </div>
      )}

      {content?.note && (
        <p className="mt-4 text-sm text-muted-foreground border-l-2 border-border pl-3">
          {content.note}
        </p>
      )}

      {!content ? (
        <p className="mt-6 py-6 text-center text-sm text-muted-foreground">
          この号には紙面データがありません。
        </p>
      ) : content.format === 'brief' ? (
        (() => {
          const articles = content.sections.flatMap((s) => s.articles);
          return (
            <section className="mt-5">
              <h3 className="font-serif text-lg font-bold">今日の{articles.length}本</h3>
              <div className="mt-2 divide-y divide-border">
                {articles.map((a) => (
                  <EditionArticleItem
                    key={a.articleId}
                    article={a}
                    rating={articleRatings?.[a.articleId]}
                    onRated={handleRated}
                    research={researchByArticle.get(a.articleId)}
                    onOpenResearch={onOpenResearch}
                  />
                ))}
              </div>
            </section>
          );
        })()
      ) : (
        <div className="mt-5 space-y-7">
          {content.sections
            .filter((s) => s.articles.length > 0)
            .map((section) => (
              <section key={section.name}>
                <h3 className="font-serif text-lg font-bold border-b border-border pb-1.5">
                  {section.name}
                </h3>
                <div className="mt-2 divide-y divide-border">
                  {section.articles.map((a) => (
                    <EditionArticleItem
                      key={a.articleId}
                      article={a}
                      rating={articleRatings?.[a.articleId]}
                      onRated={handleRated}
                      research={researchByArticle.get(a.articleId)}
                      onOpenResearch={onOpenResearch}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {content?.others && content.others.length > 0 && (
        <section className="mt-8 border-t-2 border-foreground/20 pt-4">
          <h3 className="font-serif text-lg font-bold">ほかにこんな記事がありました</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            本編に載せなかった記事の一覧です。👍=読みたかった（今後この種を拾う）／👎=要らない（今後拾わない）／
            深掘り=AIが調べてレポート。評価は編集方針に反映されます。
          </p>
          <div className="mt-3 space-y-4">
            {content.others.map((section) => (
              <div key={section.name}>
                <h4 className="text-sm font-bold text-muted-foreground">{section.name}</h4>
                <div className="divide-y divide-border">
                  {section.articles.map((a) => (
                    <OtherArticleRow
                      key={a.articleId}
                      article={a}
                      rating={articleRatings?.[a.articleId]}
                      onRated={handleRated}
                      research={researchByArticle.get(a.articleId)}
                      onOpenResearch={onOpenResearch}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {content?.editorialNote && (
        <p className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">
          編集メモ:
          本号は情報源{content.editorialNote.feedCount}本から集めた候補{content.editorialNote.candidateCount}本を審査し、
          {content.editorialNote.adoptedCount}本を掲載しました。
          {content.editorialNote.emptySections.length > 0 && (
            <>
              「{content.editorialNote.emptySections.join('」「')}」面は、掲載基準を満たす記事がありませんでした。
            </>
          )}
        </p>
      )}
      </CardContent>
    </Card>
  );
}
