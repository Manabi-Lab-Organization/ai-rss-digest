import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { DigestFeed } from 'shared';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { safeHref } from '@/lib/safeHref';

const PAGE_SIZE = 50;

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

export function ArticleList({ feeds }: { feeds: DigestFeed[] }) {
  const [feedId, setFeedId] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['digest', 'articles', feedId ?? 'all', limit],
    queryFn: () =>
      api.digest.articles({ ...(feedId != null ? { feedId } : {}), limit, offset: 0 }),
    placeholderData: keepPreviousData,
  });

  const articles = data?.articles ?? [];
  const total = data?.total ?? 0;
  const hasMore = articles.length < total;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          収集した記事
          {data && <span className="ml-2 text-sm font-normal text-muted-foreground">{total} 件</span>}
        </h2>
        <select
          value={feedId ?? ''}
          onChange={(e) => {
            setFeedId(e.target.value ? Number(e.target.value) : null);
            setLimit(PAGE_SIZE);
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="情報源で絞り込み"
        >
          <option value="">すべての情報源</option>
          {feeds.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : articles.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              まだ記事がありません。「今すぐ収集」を押すか、次回の自動巡回をお待ちください。
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {articles.map((a) => (
                <li key={a.id} className="px-5 py-3">
                  <a
                    href={safeHref(a.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block"
                  >
                    <p className="text-sm font-medium group-hover:text-primary group-hover:underline">
                      {a.title}
                      <ExternalLink className="ml-1 inline w-3 h-3 align-baseline text-muted-foreground" />
                    </p>
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {a.feedTitle || '削除済みの情報源'}・{formatDateTime(a.publishedAt ?? a.fetchedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {hasMore && (
        <div className="text-center">
          <Button
            variant="outline"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            disabled={isFetching}
          >
            {isFetching && <Loader2 className="w-4 h-4 animate-spin" />}
            もっと見る（残り {total - articles.length} 件）
          </Button>
        </div>
      )}
    </div>
  );
}
