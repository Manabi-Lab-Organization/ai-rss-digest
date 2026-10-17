
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Loader2, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import type { DigestProposalMessage, DigestProposalThread } from 'shared';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';

export function changeSummary(draft: string): string | null {
  const lines: string[] = [];
  for (const line of draft.split('\n')) {
    if (line.trim() === '' && lines.length === 0) continue;
    if (!line.startsWith('#')) break;
    lines.push(line.replace(/^#+\s*/, ''));
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function MessageBubble({ message }: { message: DigestProposalMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        }`}
      >
        {message.content}
        {message.revised && (
          <span className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="w-3 h-3" />
            この指摘で案を更新しました
          </span>
        )}
      </div>
    </div>
  );
}

export function EditorialProposalThread({ proposalId }: { proposalId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [draftOpen, setDraftOpen] = useState(false);
  const [input, setInput] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  const threadQuery = useQuery<DigestProposalThread>({
    queryKey: ['digest', 'proposal-thread', proposalId],
    queryFn: () => api.digest.proposalThread(proposalId),
  });
  const thread = threadQuery.data;

  const invalidateDecision = () => {
    qc.invalidateQueries({ queryKey: ['digest', 'editorial-proposals'] });
    qc.invalidateQueries({ queryKey: ['digest', 'review-status'] });
    qc.invalidateQueries({ queryKey: ['digest', 'proposal-thread', proposalId] });
  };

  const sendMutation = useMutation({
    mutationFn: (message: string) => api.digest.sendProposalMessage(proposalId, message),
    onSuccess: (updated) => {
      qc.setQueryData(['digest', 'proposal-thread', proposalId], updated);
      setInput('');
    },
    onError: (err: Error) => {
      toast({ title: '指摘を送れませんでした', description: err.message, variant: 'destructive' });
      qc.invalidateQueries({ queryKey: ['digest', 'proposal-thread', proposalId] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => api.digest.approveEditorialProposal(proposalId, thread?.revisionId ?? 0),
    onSuccess: () => {
      toast({ title: '編集方針を更新しました', description: '次の朝刊から反映されます' });
      invalidateDecision();
    },
    onError: (err: Error) => {
      toast({ title: '承認できませんでした', description: err.message, variant: 'destructive' });
      qc.invalidateQueries({ queryKey: ['digest', 'proposal-thread', proposalId] });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: () => api.digest.dismissEditorialProposal(proposalId),
    onSuccess: () => {
      toast({
        title: '提案を見送りました',
        description: 'この案への指摘は次回の見直しの材料に引き継ぎます',
      });
      invalidateDecision();
    },
  });

  const busy = sendMutation.isPending || approveMutation.isPending || dismissMutation.isPending;
  const messages = thread?.messages ?? [];

  useEffect(() => {
    if (messages.length > 0) logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length, sendMutation.isPending]);

  const send = () => {
    const text = input.trim();
    if (text && !busy) sendMutation.mutate(text);
  };

  const approve = async () => {
    const touched = thread?.constitutionDiff ?? [];
    const base = thread?.revisionCount
      ? `打ち合わせで${thread.revisionCount}回直した案を反映します。次の朝刊から適用されます`
      : '承認すると編集方針が置き換わり、次の朝刊から反映されます';
    const ok = await confirm({
      title: touched.length > 0
        ? 'この改定は本紙の土台に触れます。更新しますか？'
        : 'この内容で編集方針を更新しますか？',
      description: touched.length > 0
        ? `変わるのは「${touched.map((d) => d.section).join('」「')}」です。`
          + '紙面の性格そのものが変わる箇所なので、上の差分を確認してから承認してください。'
          + `${base}`
        : base,
      confirmText: '承認して反映',
    });
    if (ok) approveMutation.mutate();
  };

  if (threadQuery.isLoading) {
    return (
      <div className="mt-3 flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="mt-3 space-y-2 rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">
          提案の内容を取得できませんでした。時間をおいて再読み込みしてください。
        </p>
        {threadQuery.error instanceof Error && (
          <p className="text-xs text-muted-foreground">詳細: {threadQuery.error.message}</p>
        )}
        <Button size="sm" variant="outline" onClick={() => threadQuery.refetch()} disabled={threadQuery.isFetching}>
          {threadQuery.isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          再読み込み
        </Button>
      </div>
    );
  }

  const summary = changeSummary(thread.draft);

  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-md border border-border">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-sm font-medium">現在の案</span>
          {thread.revisionCount > 0 && (
            <Badge variant="secondary">打ち合わせで{thread.revisionCount}回更新</Badge>
          )}
          <button
            type="button"
            onClick={() => setDraftOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={draftOpen}
          >
            {draftOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {draftOpen ? '全文を閉じる' : '全文を見る'}
          </button>
        </div>
        {summary && !draftOpen && (
          <p className="border-t border-border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
            {summary}
          </p>
        )}
        {draftOpen && (
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap border-t border-border p-3 font-sans text-sm leading-relaxed">
            {thread.draft}
          </pre>
        )}
      </div>

      {messages.length > 0 && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {sendMutation.isPending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                案を見直しています…
              </div>
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      )}

      <div className="space-y-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            messages.length === 0
              ? '案への指摘・注文を書いてください（例: 前日に載せた記事の重複は、その後の新事実が無ければ採用しない）。AIが案を直します'
              : '続けて指摘する（案の意図を質問するだけでも構いません）'
          }
          maxLength={4000}
          rows={3}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={send} disabled={busy || input.trim() === ''}>
            {sendMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            指摘を送って直してもらう
          </Button>
          <span className="text-xs text-muted-foreground">
            納得できたら承認してください。承認するまで紙面には反映されません。
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button size="sm" onClick={approve} disabled={busy}>
          {approveMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          この内容で承認して反映
        </Button>
        <Button size="sm" variant="outline" onClick={() => dismissMutation.mutate()} disabled={busy}>
          {dismissMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <X className="w-4 h-4" />
          )}
          見送り
        </Button>
      </div>
    </div>
  );
}

export function DecidedProposalContent({ proposalId, fallback }: { proposalId: number; fallback: string }) {
  const threadQuery = useQuery<DigestProposalThread>({
    queryKey: ['digest', 'proposal-thread', proposalId],
    queryFn: () => api.digest.proposalThread(proposalId),
  });

  if (threadQuery.isLoading) {
    return (
      <div className="mt-3 flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }
  const thread = threadQuery.data;
  const userNotes = (thread?.messages ?? []).filter((m) => m.role === 'user');

  return (
    <div className="mt-3 space-y-2">
      {thread && thread.revisionCount > 0 && (
        <p className="text-xs text-muted-foreground">
          打ち合わせで{thread.revisionCount}回直した最終案です（指摘 {userNotes.length} 件）
        </p>
      )}
      {(thread?.problems ?? []).length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">この案は承認しても保存できません</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {thread!.problems!.map((p) => <li key={p}>{p}</li>)}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            下の入力欄で「ここを直して」と伝えると、編集長が案を直します。
          </p>
        </div>
      )}

      {(thread?.constitutionDiff ?? []).length > 0 && (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          <p className="font-medium">この改定は本紙の土台に触れます</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            紙面の性格そのものが変わる箇所です。変更前後を確認してから承認してください。
          </p>
          <div className="mt-2 space-y-3">
            {thread!.constitutionDiff!.map((d) => (
              <div key={d.section}>
                <p className="text-xs font-medium">{d.section}</p>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-background/60 p-2 text-xs line-through opacity-70">
                  {d.before || '（この項目は元の方針にありませんでした）'}
                </pre>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-background/60 p-2 text-xs">
                  {d.after || '（この項目が消えます）'}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}

      <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm leading-relaxed">
        {thread?.draft ?? fallback}
      </pre>
    </div>
  );
}
