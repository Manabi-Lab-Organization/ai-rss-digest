import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, ChevronUp, Loader2, Newspaper, RefreshCw } from 'lucide-react';
import type { DigestEdition, DigestEditionSummary } from 'shared';
import { useConfirm } from '../ui/confirm-dialog';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';
import { EditionView } from './EditionView';

const POLL_INTERVAL_MS = 10_000;

const STATUS_LABEL: Record<DigestEditionSummary['status'], string> = {
  generating: '作成中',
  done: '完成',
  failed: '失敗',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function StatusBadge({ status }: { status: DigestEditionSummary['status'] }) {
  const variant =
    status === 'done' ? ('success' as const) : status === 'failed' ? ('destructive' as const) : ('warning' as const);
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

export function MorningEditionTab({
  hasFeeds,
  onGoToSources,
  onGoToChat,
  onOpenResearch,
  initialEditionId = null,
}: {
  hasFeeds: boolean;
  initialEditionId?: number | null;
  onGoToSources: () => void;
  onGoToChat: () => void;
  onOpenResearch?: (researchId: number) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [pendingRun, setPendingRun] = useState<{ baselineId: number | null } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(initialEditionId);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const editionsQuery = useQuery<DigestEditionSummary[]>({
    queryKey: ['digest', 'editions'],
    queryFn: () => api.digest.editions(50),
    refetchInterval: (query) => {
      const newest = query.state.data?.[0];
      return pendingRun != null || newest?.status === 'generating'
        ? POLL_INTERVAL_MS
        : false;
    },
  });
  const editions = editionsQuery.data ?? [];
  const newest = editions[0];
  const generating = pendingRun != null || newest?.status === 'generating';
  const hasDoneEdition = editions.some((e) => e.status === 'done');
  const isFirstEver = editions.length === 0;

  const latestQuery = useQuery<DigestEdition | null>({
    queryKey: ['digest', 'editions', 'latest'],
    queryFn: () => api.digest.latestEdition(),
    enabled: hasDoneEdition,
  });

  const selectedQuery = useQuery<DigestEdition>({
    queryKey: ['digest', 'editions', selectedId],
    queryFn: () => api.digest.edition(selectedId!),
    enabled: selectedId != null,
  });

  useEffect(() => {
    if (selectedId == null || !selectedQuery.isError) return;
    setSelectedId(null);
    toast({
      title: 'この号は開けませんでした',
      description: '最新号を表示します。',
      variant: 'destructive',
    });
  }, [selectedId, selectedQuery.isError, toast]);

  const runMutation = useMutation({
    mutationFn: (first: boolean) => api.digest.runEdition(first),
    onSuccess: () => {
      setPendingRun({ baselineId: newest?.id ?? null });
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ['digest', 'editions'] });
    },
    onError: (err: Error) => {
      toast({
        title: '朝刊を作れませんでした',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const prevNewestRef = useRef<DigestEditionSummary | undefined>(undefined);
  useEffect(() => {
    const prev = prevNewestRef.current;
    prevNewestRef.current = newest;
    if (!newest) return;

    const newRowAppeared = pendingRun != null && newest.id !== pendingRun.baselineId;
    if (newRowAppeared) setPendingRun(null);

    const wasGenerating = prev?.id === newest.id && prev.status === 'generating';
    const finished =
      newest.status !== 'generating' && (wasGenerating || newRowAppeared);
    if (finished && newest.status === 'done') {
      qc.invalidateQueries({ queryKey: ['digest', 'editions', 'latest'] });
      setSelectedId(null);
      toast({ title: `${newest.title}が完成しました` });
    }
  }, [newest, pendingRun, qc, toast]);

  const startRun = async () => {
    const ok = await confirm({
      title: isFirstEver ? '創刊号を作りますか？' : '朝刊を今すぐ作りますか？',
      description: isFirstEver
        ? '集めた記事をすべて評価して、あなた専用の創刊号を編集します（数分）。'
          + '創刊号はたまった記事をまとめて読むぶん、2号目以降より AI の費用が多くかかります'
        : '集まっている記事から新しい号を編集します（数分）。',
      confirmText: isFirstEver ? '創刊号を作る' : '作成する',
    });
    if (ok) runMutation.mutate(isFirstEver);
  };
  const runButtonLabel = isFirstEver ? '創刊号を作る' : '朝刊を今すぐ作る';

  if (!hasFeeds) {
    return (
      <Card>
        <CardContent className="py-10 text-center space-y-3">
          <Newspaper className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="font-medium">情報源を追加すると朝刊を作れます</p>
          <p className="text-sm text-muted-foreground">
            編集長AIに「どんな情報を追いかけたいか」を伝えると、あなたに合った情報源を探して提案します。
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={onGoToChat}>編集長に相談して始める</Button>
            <Button variant="outline" onClick={onGoToSources}>
              自分で情報源を追加する
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const loading = editionsQuery.isLoading;
  const shownEdition = selectedId != null ? selectedQuery.data : latestQuery.data ?? undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {generating && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              紙面を作っています… 数分かかります
            </p>
          )}
        </div>
        {!isFirstEver && (
          <Button onClick={startRun} disabled={generating || runMutation.isPending}>
            {runMutation.isPending || generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {runButtonLabel}
          </Button>
        )}
      </div>

      {!generating && newest?.status === 'failed' && selectedId == null && (
        <Card>
          <CardContent className="py-6 text-center space-y-3">
            <AlertCircle className="w-6 h-6 mx-auto text-destructive" />
            <p className="text-sm">
              {newest.title}の作成に失敗しました。しばらくおいて再試行してください。
            </p>
            <Button variant="outline" onClick={startRun} disabled={runMutation.isPending}>
              {runMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              再試行
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : isFirstEver && !generating ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <Newspaper className="w-8 h-8 mx-auto text-muted-foreground" />
            <p className="font-medium">創刊号を作りましょう</p>
            <p className="text-sm text-muted-foreground">
              集めた記事から、あなた専用の朝刊を編集します。作成には数分かかります。
            </p>
            <Button size="lg" onClick={startRun} disabled={runMutation.isPending}>
              {runMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Newspaper className="w-4 h-4" />
              )}
              創刊号を作る
            </Button>
          </CardContent>
        </Card>
      ) : selectedId != null && selectedQuery.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : shownEdition ? (
        <div className="space-y-3">
          {selectedId != null && shownEdition.id !== latestQuery.data?.id && (
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <span>バックナンバーを表示しています</span>
              {hasDoneEdition && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                  最新号に戻る
                </Button>
              )}
            </div>
          )}
          <EditionView edition={shownEdition} onOpenResearch={onOpenResearch} />
        </div>
      ) : (
        !generating && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            まだ完成した号がありません。
          </p>
        )
      )}

      {editions.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setArchiveOpen((v) => !v)}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={archiveOpen}
          >
            {archiveOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            バックナンバー（{editions.length} 号）
          </button>
          {archiveOpen && (
            <Card className="mt-2">
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {editions.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => e.status === 'done' && setSelectedId(e.id)}
                        disabled={e.status !== 'done'}
                        className="flex w-full flex-wrap items-center gap-2 px-5 py-3 text-left text-sm hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span className="text-muted-foreground">{formatDate(e.editionDate)}</span>
                        <span className="font-medium">{e.title}</span>
                        <span className="text-xs text-muted-foreground">{e.articleCount} 本</span>
                        <StatusBadge status={e.status} />
                        {selectedId === e.id && <Badge variant="outline">表示中</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
