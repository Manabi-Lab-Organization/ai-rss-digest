import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Newspaper, RefreshCw } from 'lucide-react';
import type { DigestFeed, DigestPollStatus } from 'shared';
import { Layout } from '../components/layout/Layout';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { AddFeedForm } from '../components/digest/AddFeedForm';
import { FeedList } from '../components/digest/FeedList';
import { ArticleList } from '../components/digest/ArticleList';
import { MorningEditionTab } from '../components/digest/MorningEditionTab';
import { EditorChatTab } from '../components/digest/EditorChatTab';
import { ResearchTab } from '../components/digest/ResearchTab';
import { DigestSettingsForm } from '../components/digest/DigestSettingsForm';
import { DigestReviewSection } from '../components/digest/DigestReviewSection';
import { useToast } from '../hooks/use-toast';
import { useSiteConfig } from '../hooks/useSiteConfig';
import { api } from '../lib/api';

type DigestTab = 'edition' | 'chat' | 'articles' | 'research' | 'sources' | 'settings';

function researchIdFromUrl(): number | null {
  const v = new URLSearchParams(window.location.search).get('research');
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function editionIdFromUrl(): number | null {
  const v = new URLSearchParams(window.location.search).get('edition');
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function reviewFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get('review') != null;
}

function suggestFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get('suggest') != null;
}

export default function DigestPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { appName } = useSiteConfig();
  const [initialResearchId] = useState<number | null>(researchIdFromUrl);
  const [initialReview] = useState<boolean>(reviewFromUrl);
  const [initialSuggest] = useState<boolean>(suggestFromUrl);
  const [initialEditionId] = useState<number | null>(editionIdFromUrl);
  const [tab, setTab] = useState<DigestTab>(
    initialResearchId != null
      ? 'research'
      : initialReview
        ? 'settings'
        : initialSuggest
          ? 'chat'
          : 'edition'
  );
  const [openResearchId, setOpenResearchId] = useState<number | null>(initialResearchId);

  useEffect(() => {
    if (initialResearchId != null || initialReview || initialSuggest || initialEditionId != null) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [initialResearchId, initialReview, initialSuggest, initialEditionId]);

  useEffect(() => {
    if (!initialReview) return;
    const t = setTimeout(() => {
      document.getElementById('digest-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
    return () => clearTimeout(t);
  }, [initialReview]);

  const openResearchReport = (researchId: number) => {
    setOpenResearchId(researchId);
    setTab('research');
  };

  const { data: feeds = [], isLoading: feedsLoading } = useQuery<DigestFeed[]>({
    queryKey: ['digest', 'feeds'],
    queryFn: () => api.digest.feeds(),
  });

  const pollStatusQuery = useQuery<DigestPollStatus>({
    queryKey: ['digest', 'poll-status'],
    queryFn: () => api.digest.pollStatus(),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 3_000 : false),
  });
  const pollStatus = pollStatusQuery.data;
  const polling = pollStatus?.status === 'running';

  const pollMutation = useMutation({
    mutationFn: () => api.digest.poll(),
    onSuccess: (r) => {
      if (r.started) {
        toast({
          title: '収集を開始しました',
          description: '数分かかります。終わり次第この画面でお知らせします（開いたままでなくても大丈夫です）',
        });
      }
      qc.invalidateQueries({ queryKey: ['digest', 'poll-status'] });
    },
    onError: (err: Error) => {
      toast({ title: '収集を開始できませんでした', description: err.message, variant: 'destructive' });
    },
  });

  const prevPollRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevPollRef.current;
    prevPollRef.current = pollStatus?.status;
    if (prev !== 'running') return;
    if (pollStatus?.status === 'done') {
      qc.invalidateQueries({ queryKey: ['digest', 'feeds'] });
      qc.invalidateQueries({ queryKey: ['digest', 'articles'] });
      const r = pollStatus.result;
      toast({
        title: r ? `収集が完了しました（新着 ${r.added} 件）` : '収集が完了しました',
        description: r
          ? `${r.feedCount} 件の情報源を巡回`
            + (r.reattached > 0 ? `・${r.reattached} 件の記事を再整理` : '')
            + (r.errorCount > 0 ? `・${r.errorCount} 件で取得エラー` : '')
          : undefined,
      });
    } else if (pollStatus?.status === 'failed') {
      toast({ title: '収集に失敗しました', description: 'もう一度お試しください', variant: 'destructive' });
    }
  }, [pollStatus?.status, pollStatus?.result, qc, toast]);

  const lastPollLine = (() => {
    if (!pollStatus || pollStatus.status === 'none' || !pollStatus.finishedAt) return null;
    const d = new Date(pollStatus.finishedAt);
    const when = Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (pollStatus.status === 'failed') return `前回の収集（${when}）は失敗しました`;
    const r = pollStatus.result;
    return r
      ? `前回の収集: ${when}・新着 ${r.added} 件${r.errorCount > 0 ? `・取得エラー ${r.errorCount} 件` : ''}`
      : `前回の収集: ${when}`;
  })();

  const hasFeeds = feeds.length > 0;

  return (
    <Layout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-primary" />
            {appName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            登録した情報源から記事を集め、あなた専用の朝刊を毎朝お届けします。
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as DigestTab)}>
          <TabsList>
            <TabsTrigger value="edition">朝刊</TabsTrigger>
            <TabsTrigger value="chat">編集長に相談</TabsTrigger>
            <TabsTrigger value="articles">収集記事</TabsTrigger>
            <TabsTrigger value="research">深掘り</TabsTrigger>
            <TabsTrigger value="sources">情報源</TabsTrigger>
            <TabsTrigger value="settings">設定</TabsTrigger>
          </TabsList>

          <TabsContent value="edition" className="mt-4">
            {feedsLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : (
              <MorningEditionTab
                hasFeeds={hasFeeds}
                initialEditionId={initialEditionId}
                onGoToSources={() => setTab('sources')}
                onGoToChat={() => setTab('chat')}
                onOpenResearch={openResearchReport}
              />
            )}
          </TabsContent>

          <TabsContent value="chat" className="mt-4 data-[state=inactive]:hidden" forceMount>
            <EditorChatTab
              hasFeeds={hasFeeds}
              premiumDefault={feedsLoading ? null : feeds.length < 5}
              openPending={initialSuggest}
            />
          </TabsContent>

          <TabsContent value="articles" className="mt-4">
            {hasFeeds ? (
              <ArticleList feeds={feeds} />
            ) : (
              <Card>
                <CardContent className="py-10 text-center space-y-3">
                  <Newspaper className="w-8 h-8 mx-auto text-muted-foreground" />
                  <p className="font-medium">まだ記事がありません</p>
                  <p className="text-sm text-muted-foreground">
                    情報源を追加すると記事の収集が始まります。
                  </p>
                  <Button variant="outline" onClick={() => setTab('sources')}>
                    情報源を追加する
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="research" className="mt-4">
            <ResearchTab openId={openResearchId} onOpenChange={setOpenResearchId} />
          </TabsContent>

          <TabsContent value="sources" className="mt-4 space-y-6">
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-2 px-1">情報源を追加</h2>
              <AddFeedForm />
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">
                  情報源
                  {hasFeeds && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {feeds.length} 件
                    </span>
                  )}
                </h2>
                {hasFeeds && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => pollMutation.mutate()}
                    disabled={polling || pollMutation.isPending}
                  >
                    {polling || pollMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    {polling || pollMutation.isPending ? '収集中…（数分かかります）' : '今すぐ収集'}
                  </Button>
                )}
              </div>
              {lastPollLine && (
                <p className="px-1 text-xs text-muted-foreground">{lastPollLine}</p>
              )}

              {feedsLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : hasFeeds ? (
                <FeedList feeds={feeds} />
              ) : (
                <Card>
                  <CardContent className="py-10 text-center space-y-2">
                    <Newspaper className="w-8 h-8 mx-auto text-muted-foreground" />
                    <p className="font-medium">最初の情報源を追加しましょう</p>
                    <p className="text-sm text-muted-foreground">
                      上のフォームから、よく読むサイトのRSSのURL、または
                      <br className="hidden sm:block" />
                      気になるテーマのGoogleニュース検索キーワードを登録すると、記事の収集が始まります。
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-4 space-y-6">
            <DigestSettingsForm />
            <DigestReviewSection />
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
