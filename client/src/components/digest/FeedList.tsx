import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Link2, Loader2, Pause, Pencil, Play, Skull, Trash2 } from 'lucide-react';
import type { DigestFeed } from 'shared';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';

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

function isDying(feed: DigestFeed): boolean {
  return feed.status === 'dead_candidate' || feed.errorCount >= 5;
}

function adoptionRateLabel(adopted: number, total: number): string {
  if (total === 0) return '—';
  const percent = Math.round((adopted / total) * 100);
  if (adopted > 0 && percent === 0) return '1%未満';
  return `${percent}%`;
}

function FeedRow({ feed }: { feed: DigestFeed }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { toast } = useToast();

  const invalidateFeeds = () => qc.invalidateQueries({ queryKey: ['digest', 'feeds'] });

  const pauseMutation = useMutation({
    mutationFn: () => api.digest.pauseFeed(feed.id),
    onSuccess: invalidateFeeds,
  });
  const activateMutation = useMutation({
    mutationFn: () => api.digest.activateFeed(feed.id),
    onSuccess: invalidateFeeds,
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.digest.deleteFeed(feed.id),
    onSuccess: () => {
      toast({ title: `「${feed.title}」を削除しました`, description: '収集済みの記事は残ります' });
      invalidateFeeds();
      qc.invalidateQueries({ queryKey: ['digest', 'articles'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (patch: { url?: string; title?: string; tier?: DigestFeed['tier'] }) => api.digest.updateFeed(feed.id, patch),
    onSuccess: (_data, patch) => {
      if (patch.tier) {
        toast({
          title: patch.tier === 'primary'
            ? `「${feed.title}」を一次情報として扱います`
            : `「${feed.title}」の種別を「分類しない」に戻しました`,
        });
      } else if (patch.title) {
        toast({ title: `名前を「${patch.title}」に変えました` });
      } else {
        toast({
          title: `「${feed.title}」のURLを差し替えました`,
          description: '記事と採用率はそのまま残ります。名前が中身と合っているか確認してください',
        });
      }
      invalidateFeeds();
    },
    onError: (e, patch) =>
      toast({
        title: patch.tier ? '種別を変えられませんでした' : patch.title ? '名前を変えられませんでした' : '差し替えできませんでした',
        description: e instanceof Error ? e.message : '',
        variant: 'destructive' as any,
      }),
  });

  const paused = feed.status === 'paused';
  const busy =
    pauseMutation.isPending || activateMutation.isPending || deleteMutation.isPending || updateMutation.isPending;

  const handleChangeUrl = async () => {
    const next = window.prompt(
      `「${feed.title}」の新しいフィードURLを入力してください。\n\n`
      + '取得できるか確認してから差し替えます。収集済みの記事と採用率は残ります。',
      feed.xmlUrl,
    );
    if (!next || next.trim() === '' || next.trim() === feed.xmlUrl) return;
    updateMutation.mutate({ url: next.trim() });
  };

  const handleRename = () => {
    const next = window.prompt(
      `「${feed.title}」の新しい名前を入力してください。\n\n`
      + '一覧での表示名だけが変わります。収集済みの記事にも、これからの収集にも影響しません。',
      feed.title,
    );
    if (next === null) return;
    const title = next.trim();
    if (title === '' || title === feed.title) return;
    updateMutation.mutate({ title });
  };

  const isPrimary = feed.tier === 'primary';
  const handleToggleTier = () => {
    updateMutation.mutate({ tier: isPrimary ? 'none' : 'primary' });
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'この情報源を削除しますか？',
      description: `「${feed.title}」の収集を停止し、一覧から削除します。\n収集済みの記事はそのまま残ります。`,
      confirmText: '削除する',
      destructive: true,
    });
    if (ok) deleteMutation.mutate();
  };

  return (
    <li className={`px-5 py-4 ${paused ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium truncate" title={feed.xmlUrl}>
              {feed.htmlUrl ? (
                <a
                  href={feed.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {feed.title}
                </a>
              ) : (
                feed.title
              )}
            </span>
            <Badge variant="secondary">{feed.kind === 'gnews' ? 'Googleニュース' : 'RSS'}</Badge>
            {isPrimary && <Badge variant="outline">一次情報</Badge>}
            {feed.category && <Badge variant="warning">{feed.category}</Badge>}
            {paused && <Badge variant="warning">一時停止中</Badge>}
            {isDying(feed) && (
              <Badge variant="destructive" className="gap-1">
                <Skull className="w-3 h-3" />
                取得不能のおそれ
              </Badge>
            )}
            {feed.healthWarning === 'stale' && !isDying(feed) && (
              <Badge
                variant="destructive"
                className="gap-1"
                title="このフィードの平常の更新間隔に対して、長く新着が途絶えています。配信を止めたか、URL が移転した可能性があります。収集は継続中で、復活すればこの表示は消えます"
              >
                <Skull className="w-3 h-3" />
                配信が止まっている疑い
              </Badge>
            )}
            {feed.healthWarning === 'no-hits' && !isDying(feed) && (
              <Badge
                variant="secondary"
                className="gap-1"
                title="このキーワードに当たる記事が長く見つかっていません。フィードは正常で、キーワードが狭いか、その話題が静かなだけです。キーワードの見直しをご検討ください"
              >
                検索に当たっていません
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            記事 {feed.articleCount ?? 0} 件
            {(feed.articleCount ?? 0) > 0 && feed.adoptedCount != null && (
              <span title="集めた記事のうち朝刊に採用された割合。低いままなら整理の候補です">
                （採用率 {adoptionRateLabel(feed.adoptedCount, feed.articleCount ?? 0)}）
              </span>
            )}
            ・最終取得 {formatDateTime(feed.lastFetchedAt)}
          </p>
          {feed.lastError && (
            <p className="mt-1 text-xs text-destructive break-all">
              取得エラー（{feed.errorCount}回連続）: {feed.lastError}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {paused ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => activateMutation.mutate()}
              disabled={busy}
              title="収集を再開"
            >
              {activateMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">再開</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => pauseMutation.mutate()}
              disabled={busy}
              title="収集を一時停止"
            >
              {pauseMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Pause className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">一時停止</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRename}
            disabled={busy}
            title="一覧での表示名を変える（収集には影響しません）"
          >
            {updateMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Pencil className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">名称変更</span>
          </Button>
          {feed.kind !== 'gnews' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleToggleTier}
              disabled={busy}
              title={isPrimary
                ? '一次情報としての扱いをやめ、「分類しない」に戻す'
                : '発表した当事者自身が出している情報源（会社や団体の公式のお知らせなど）なら、一次情報として扱う'}
            >
              <BadgeCheck className="w-4 h-4" />
              <span className="hidden sm:inline">{isPrimary ? '一次情報をやめる' : '一次情報にする'}</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleChangeUrl}
            disabled={busy}
            title="フィードURLを差し替える（移転したときに使います。記事と採用率は残ります）"
          >
            {updateMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Link2 className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">URL変更</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDelete}
            disabled={busy}
            title="削除（記事は残ります）"
            className="text-destructive hover:text-destructive"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">削除</span>
          </Button>
        </div>
      </div>
    </li>
  );
}

export function FeedList({ feeds }: { feeds: DigestFeed[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {feeds.map((feed) => (
            <FeedRow key={feed.id} feed={feed} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
