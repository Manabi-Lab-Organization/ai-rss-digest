import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, FileSearch, Loader2, Presentation } from 'lucide-react';
import type { DigestResearchDetail, DigestResearchStatus, DigestResearchSummary } from 'shared';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { isResearchActive, useResearchList } from '../../hooks/useDigestResearch';
import { api } from '../../lib/api';

const STATUS_LABEL: Record<DigestResearchStatus, string> = {
  pending: '調査中',
  running: '調査中',
  done: '完成',
  failed: '失敗',
};

function StatusBadge({ status }: { status: DigestResearchStatus }) {
  const variant =
    status === 'done'
      ? ('success' as const)
      : status === 'failed'
        ? ('destructive' as const)
        : ('warning' as const);
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

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

function VisualRow({ detail }: { detail: DigestResearchDetail }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const startMutation = useMutation({
    mutationFn: () => api.digest.startResearchVisual(detail.id),
    onSuccess: (result) => {
      if (result.started) {
        toast({ title: 'ビジュアル版を作っています（1〜2分かかります）' });
      } else if (result.status === 'done') {
        toast({ title: 'ビジュアル版はすでに完成しています' });
      } else {
        toast({ title: 'ビジュアル版はすでに作成中です' });
      }
      qc.invalidateQueries({ queryKey: ['digest', 'research'] });
    },
    onError: (err: Error) => {
      toast({ title: 'ビジュアル版を作れませんでした', description: err.message, variant: 'destructive' });
    },
  });

  if (detail.status !== 'done') return null;

  if (detail.visual === 'done') {
    return (
      <a
        href={api.digest.researchVisualUrl(detail.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10"
      >
        <Presentation className="w-4 h-4" />
        ビジュアル表示
        <ExternalLink className="w-3 h-3" />
      </a>
    );
  }

  if (detail.visual === 'running' || startMutation.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        ビジュアル版を生成中です（1〜2分かかります）
      </p>
    );
  }

  const startWithConfirm = async () => {
    const ok = await confirm({
      title: detail.visual === 'failed' ? 'ビジュアル版を再生成しますか？' : 'ビジュアル版を作成しますか？',
      description:
        'このレポートを図表付きの見やすい1枚ページに変換します（1〜2分）。'
        + '保存済みレポートからの変換のみで、再調査はしません',
      confirmText: detail.visual === 'failed' ? '再生成する' : '作成する',
    });
    if (ok) startMutation.mutate();
  };

  if (detail.visual === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-destructive">ビジュアル版の生成でエラーが発生しました。</span>
        <Button size="sm" variant="outline" onClick={startWithConfirm}>
          <Presentation className="w-4 h-4" />
          再生成する
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" variant="outline" onClick={startWithConfirm}>
      <Presentation className="w-4 h-4" />
      ビジュアル版を作成
    </Button>
  );
}

function ResearchReportView({ id, onBack }: { id: number; onBack: () => void }) {
  const detailQuery = useQuery<DigestResearchDetail>({
    queryKey: ['digest', 'research', id],
    queryFn: () => api.digest.research(id),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (isResearchActive(d.status) || d.visual === 'running') ? 10_000 : false;
    },
  });
  const detail = detailQuery.data;

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="w-4 h-4" />
        深掘り一覧に戻る
      </Button>

      {detailQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : !detail ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            レポートを読み込めませんでした。
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-5 sm:p-6">
            <header className="border-b border-border pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={detail.status} />
                <h2 className="w-full font-serif text-xl font-bold leading-snug sm:w-auto">
                  {detail.headline}
                </h2>
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>依頼: {formatDateTime(detail.requestedAt)}</span>
                {detail.completedAt && <span>完成: {formatDateTime(detail.completedAt)}</span>}
                {detail.articleUrl && (
                  <a
                    href={detail.articleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    元記事を読む
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </p>
            </header>

            {detail.status === 'done' && (
              <div className="mt-3">
                <VisualRow detail={detail} />
              </div>
            )}

            {detail.report ? (
              <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-relaxed">
                {detail.report}
              </pre>
            ) : isResearchActive(detail.status) ? (
              <p className="mt-4 flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                調査中です。完成まで数分かかります
              </p>
            ) : (
              <p className="mt-4 py-4 text-sm text-muted-foreground">
                {detail.status === 'failed'
                  ? '調査に失敗しました。紙面の🔍ボタンからもう一度依頼できます。'
                  : 'レポート本文がありません。'}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ResearchListItem({
  research,
  onOpen,
}: {
  research: DigestResearchSummary;
  onOpen: (id: number) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => research.status === 'done' && onOpen(research.id)}
        disabled={research.status !== 'done'}
        className="flex w-full flex-wrap items-center gap-2 px-5 py-3 text-left text-sm hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {isResearchActive(research.status) ? (
          <Loader2 className="w-4 h-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <FileSearch className="w-4 h-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 font-medium">{research.headline}</span>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(research.completedAt ?? research.requestedAt)}
        </span>
        <StatusBadge status={research.status} />
      </button>
    </li>
  );
}

export function ResearchTab({
  openId,
  onOpenChange,
}: {
  openId: number | null;
  onOpenChange: (id: number | null) => void;
}) {
  const listQuery = useResearchList();
  const list = listQuery.data ?? [];

  if (openId != null) {
    return <ResearchReportView id={openId} onBack={() => onOpenChange(null)} />;
  }

  if (listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-2">
          <FileSearch className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="font-medium">深掘りリサーチはまだありません</p>
          <p className="text-sm text-muted-foreground">
            朝刊の気になる記事で🔍ボタンを押すと、AIがWeb検索で深く調べて
            <br className="hidden sm:block" />
            レポートにまとめます（数分で完成します）。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-1 text-sm text-muted-foreground">
        朝刊の記事の🔍ボタンから依頼した深掘りレポートです。完成した行を選ぶと読めます。
      </p>
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {list.map((r) => (
              <ResearchListItem key={r.id} research={r} onOpen={(id) => onOpenChange(id)} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
