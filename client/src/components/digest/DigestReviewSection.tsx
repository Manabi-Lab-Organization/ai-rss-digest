import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, ChevronDown, ChevronUp, GraduationCap, Loader2 } from 'lucide-react';
import type { DigestEditorialProposal, DigestProfileSection, DigestReviewStatus } from 'shared';
import { Card, CardContent } from '../ui/card';
import { SectionHeading } from '../ui/help-note';
import { Button } from '../ui/button';
import { useToast } from '../../hooks/use-toast';
import { useServerFeatures } from '../../hooks/useServerFeatures';
import { useConfirm } from '../ui/confirm-dialog';
import { Badge } from '../ui/badge';
import { DecidedProposalContent, EditorialProposalThread } from './EditorialProposalThread';
import { api } from '../../lib/api';

const STATUS_LABEL: Record<DigestEditorialProposal['status'], string> = {
  proposed: '提案中',
  approved: '反映済み',
  dismissed: '見送り',
};

function statusVariant(status: DigestEditorialProposal['status']) {
  return status === 'approved'
    ? ('success' as const)
    : status === 'dismissed'
      ? ('warning' as const)
      : ('secondary' as const);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function nextReviewDayLabel(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  let add = (7 - jst.getUTCDay()) % 7;
  if (add === 0 && jst.getUTCHours() >= 17) add = 7;
  const d = new Date(jst.getTime() + add * 86400000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（日）`;
}

function EditorialProposalItem({ proposal }: { proposal: DigestEditorialProposal }) {
  const [open, setOpen] = useState(false);
  const isProposed = proposal.status === 'proposed';

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{formatDate(proposal.createdAt)}</span>
        <Badge variant={statusVariant(proposal.status)}>{STATUS_LABEL[proposal.status]}</Badge>
        {!isProposed && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={open}
          >
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {open ? '提案内容を閉じる' : '提案内容を見る'}
          </button>
        )}
      </div>

      {isProposed ? (
        <EditorialProposalThread proposalId={proposal.id} />
      ) : (
        <>
          {open && <DecidedProposalContent proposalId={proposal.id} fallback={proposal.content} />}
          {proposal.note && (
            <p className="mt-2 text-xs text-muted-foreground">修正意見: {proposal.note}</p>
          )}
        </>
      )}
    </li>
  );
}

function CoverageFactsCard() {
  const [open, setOpen] = useState(false);
  const query = useQuery<{ days: number; text: string }>({
    queryKey: ['digest', 'coverage'],
    queryFn: () => api.digest.coverage(),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">紙面の実績</h2>
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <BarChart3 className="mt-0.5 w-5 h-5 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 space-y-3 text-sm">
              <p className="text-muted-foreground leading-relaxed">
                直近30日の朝刊について、面ごとの本数・AIの話題への偏り・過去の号と重なった記事・出典の偏りを
                数字にしたものです。編集長チャットや編集会議のAIにも同じ数字を渡しているので、
                「AIに偏っていないか」「同じ話題が続いていないか」を実測で相談できます。
              </p>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={open}
              >
                {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                {open ? '実績を閉じる' : '実績を見る'}
              </button>
              {open && (
                query.isLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" /> 集計しています…
                  </div>
                ) : query.isError ? (
                  <p className="text-muted-foreground">実績を取得できませんでした。</p>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-foreground">
                    {query.data?.text}
                  </pre>
                )
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProfileSections({ sections }: { sections: DigestProfileSection[] }) {
  if (sections.length === 0) {
    return <p className="text-xs text-muted-foreground">（内容を読み取れませんでした）</p>;
  }
  return (
    <div className="space-y-2">
      {sections.map((sec) => (
        <div
          key={sec.name}
          className={
            sec.isConstitution
              ? 'rounded-md border-l-4 border-amber-400 bg-amber-50 p-2 dark:bg-amber-950/30'
              : 'rounded-md border-l-4 border-border bg-muted/50 p-2'
          }
        >
          <p className="text-xs font-medium">
            {sec.name}
            {sec.isConstitution && (
              <span className="ml-2 rounded bg-amber-200 px-1 py-0.5 text-[10px] text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                土台
              </span>
            )}
          </p>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
            {sec.body}
          </pre>
        </div>
      ))}
    </div>
  );
}

function ProfileHistory() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [shownVersion, setShownVersion] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['digest', 'profile-versions'],
    queryFn: () => api.digest.profileVersions(),
    enabled: open,
  });

  const restoreMutation = useMutation({
    mutationFn: (proposalId: number) => api.digest.restoreProfile(proposalId),
    onSuccess: () => {
      toast({ title: '編集方針を戻しました', description: '次の朝刊から反映されます' });
      qc.invalidateQueries({ queryKey: ['digest', 'profile-versions'] });
    },
    onError: (err: Error) => {
      toast({ title: '戻せませんでした', description: err.message, variant: 'destructive' });
    },
  });

  const restore = async (v: { proposalId: number; approvedAt: string | null }) => {
    const ok = await confirm({
      title: 'この版に戻しますか？',
      description: `${v.approvedAt ? new Date(v.approvedAt).toLocaleString('ja-JP') : '日時不明'}に承認した内容へ戻します。`
        + 'いまの編集方針は履歴に残るので、あとでまた戻せます。',
      confirmText: 'この版に戻す',
    });
    if (ok) restoreMutation.mutate(v.proposalId);
  };

  const versions = versionsQuery.data?.versions ?? [];

  return (
    <div className="mt-4">
      <SectionHeading title="いまの編集方針と履歴" />
      <Card>
        <CardContent className="p-4">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            {open ? '閉じる' : '全文を見る・前の版に戻す'}
          </button>
      {open && (
        <div className="mt-3 text-sm">
            {versionsQuery.isLoading ? (
              <p className="text-muted-foreground">読み込み中…</p>
            ) : (
              <>
                <div className="mb-4">
                  <p className="mb-1 text-xs font-medium">
                    いまの編集方針
                    <span className="ml-2 text-muted-foreground">
                      {versionsQuery.data?.current.chars}字
                    </span>
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    <span className="rounded bg-amber-200 px-1 py-0.5 text-[10px] text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                      土台
                    </span>
                    {' '}の印がある節は、紙面の性格そのものを決める部分です。
                    編集長がここを変える案を出したときは、承認前に差分が表示されます。
                  </p>
                  <ProfileSections sections={versionsQuery.data?.current.sections ?? []} />
                </div>

                <p className="mb-1 text-xs font-medium">これまでの版</p>
                {versions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    まだ承認した改定がありません。承認するとここに履歴が残り、いつでも前の版に戻せます。
                  </p>
                ) : (
              <ul className="divide-y divide-border">
                {versions.map((v) => (
                  <li key={v.proposalId} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs">
                          {v.approvedAt ? new Date(v.approvedAt).toLocaleString('ja-JP') : '日時不明'}
                          <span className="ml-2 text-muted-foreground">{v.chars}字</span>
                        </p>
                        {v.note && <p className="truncate text-xs text-muted-foreground">メモ: {v.note}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShownVersion((cur) => (cur === v.proposalId ? null : v.proposalId))}
                        >
                          {shownVersion === v.proposalId ? '閉じる' : '中身を見る'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => restore(v)}
                          disabled={restoreMutation.isPending}
                        >
                          この版に戻す
                        </Button>
                      </div>
                    </div>
                    {shownVersion === v.proposalId && (
                      <div className="mt-2">
                        <ProfileSections sections={v.sections} />
                      </div>
                    )}
                  </li>
                ))}
                  </ul>
                )}
              </>
            )}
        </div>
      )}
        </CardContent>
      </Card>
    </div>
  );
}

export function DigestReviewSection() {
  const features = useServerFeatures();
  const statusQuery = useQuery<DigestReviewStatus>({
    queryKey: ['digest', 'review-status'],
    queryFn: () => api.digest.reviewStatus(),
  });

  const proposalsQuery = useQuery<DigestEditorialProposal[]>({
    queryKey: ['digest', 'editorial-proposals'],
    queryFn: () => api.digest.editorialProposals(),
  });
  const proposals = proposalsQuery.data ?? [];

  const status = statusQuery.data;
  const remaining = status ? Math.max(status.threshold - status.signalsSinceLastReview, 0) : 0;

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading
          title="編集方針"
          help={
            '紙面の記事をどう選び、どう書くかの基準です。紙面への👍👎（と書き添えた理由）や'
            + '編集長チャットに送った意見をAIが分析し、日曜の夕方に「見直し案」を作ります。'
            + (features.email ? '案はメールとこの画面に届き、' : '案はこの画面に届き、')
            + 'その場で指摘を送って直してもらえます。'
            + '紙面に反映されるのは、あなたが承認したときだけです。'
          }
        />
        <Card>
          <CardContent className="p-5">
            {statusQuery.isLoading ? (
              <div className="flex items-center justify-center py-4 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : !status ? (
              <p className="text-sm text-muted-foreground">学習の状況を取得できませんでした。</p>
            ) : (
              <div className="flex items-start gap-3">
                <GraduationCap className="mt-0.5 w-5 h-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 space-y-3 text-sm">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{status.lastReviewAt ? '前回の見直し以降に貯まった評価・意見' : '貯まった評価・意見'}</span>
                      <span className="font-medium text-foreground">
                        {status.signalsSinceLastReview} / {status.threshold} 件
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{
                          width: `${Math.min((status.signalsSinceLastReview / status.threshold) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {status.latestProposal?.status === 'proposed' ? (
                    <p className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">見直し案が届いています</Badge>
                      <span>
                        下の「見直し提案」（{formatDate(status.latestProposal.createdAt)} 作成）で
                        内容を確認し、直したいところを伝えたうえで承認してください。
                      </span>
                    </p>
                  ) : status.signalsSinceLastReview >= status.threshold ? (
                    <p>
                      件数が貯まったので、次回 <span className="font-medium">{nextReviewDayLabel()} 夕方</span> に
                      AIが見直し案を作ります。完成すると{features.email ? 'メールとこの画面' : 'この画面'}でお知らせします。
                    </p>
                  ) : (
                    <p>
                      あと <span className="font-medium">{remaining} 件</span> 貯まると見直しの対象になり、
                      その後の日曜夕方（直近では {nextReviewDayLabel()}）にAIが見直し案を作ります。
                      それまでは現在の編集方針のまま朝刊が届きます。
                    </p>
                  )}

                  {status.latestProposal?.status !== 'proposed' &&
                    status.signalsSinceLastReview < status.threshold && (
                      <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
                        <span className="font-medium text-foreground">件数を貯めるには:</span>{' '}
                        朝刊の記事に👍👎を付ける／「編集長に相談」タブで紙面への意見・要望を送る
                        —— どちらも1件としてカウントされます。
                        <br />
                        評価を付けると隣に💬が出ます。そこに理由を一言書いておくと、
                        見直し案がぐっと的確になります（任意・件数は増えません）。
                      </div>
                    )}

                  {(status.lastReviewAt || (status.latestProposal && status.latestProposal.status !== 'proposed')) && (
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {status.lastReviewAt && <span>前回の見直し: {formatDate(status.lastReviewAt)}</span>}
                      {status.latestProposal && status.latestProposal.status !== 'proposed' && (
                        <>
                          <span>最新の見直し案（{formatDate(status.latestProposal.createdAt)}）:</span>
                          <Badge variant={statusVariant(status.latestProposal.status)}>
                            {STATUS_LABEL[status.latestProposal.status]}
                          </Badge>
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {proposals.length > 0 && (
        <div id="digest-review" className="scroll-mt-4">
          <SectionHeading
            title="見直し提案"
            help="AIが作った編集方針の改定案です。承認するまで紙面には反映されません。案を開いて指摘を送ると、その場で直してもらえます。"
          />
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {proposals.map((p) => (
                  <EditorialProposalItem key={p.id} proposal={p} />
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      <ProfileHistory />

      <CoverageFactsCard />
    </div>
  );
}
