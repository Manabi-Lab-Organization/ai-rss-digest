import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';

type FeedMode = 'url' | 'keyword';

export function AddFeedForm() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [mode, setMode] = useState<FeedMode>('url');
  const [url, setUrl] = useState('');
  const [keyword, setKeyword] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addMutation = useMutation({
    mutationFn: (data: { url?: string; keyword?: string; title?: string; category?: string }) =>
      api.digest.addFeed(data),
    onSuccess: (created) => {
      toast({
        title: `「${created.title}」を追加しました`,
        description:
          created.itemCount != null ? `記事を ${created.itemCount} 件取得しました` : undefined,
      });
      setUrl('');
      setKeyword('');
      setTitle('');
      setCategory('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['digest', 'feeds'] });
      qc.invalidateQueries({ queryKey: ['digest', 'articles'] });
    },
    onError: (err: Error) => setError(err.message || '追加に失敗しました'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedCategory = category.trim();
    const optional = {
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      ...(trimmedCategory ? { category: trimmedCategory } : {}),
    };
    if (mode === 'url') {
      const trimmed = url.trim();
      if (!trimmed) {
        setError('RSSフィードのURLを入力してください');
        return;
      }
      addMutation.mutate({ url: trimmed, ...optional });
    } else {
      const trimmed = keyword.trim();
      if (!trimmed) {
        setError('検索キーワードを入力してください');
        return;
      }
      addMutation.mutate({ keyword: trimmed, ...optional });
    }
  };

  return (
    <Card>
      <CardContent className="p-5">
        <form onSubmit={submit} className="space-y-4">
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as FeedMode);
              setError(null);
            }}
          >
            <TabsList>
              <TabsTrigger value="url">RSSのURL</TabsTrigger>
              <TabsTrigger value="keyword">Googleニュース検索</TabsTrigger>
            </TabsList>
            <TabsContent value="url">
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/feed.xml"
                disabled={addMutation.isPending}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                購読したいサイトのRSS/AtomフィードのURLを入力します
              </p>
            </TabsContent>
            <TabsContent value="keyword">
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="例: 再生可能エネルギー 自治体"
                disabled={addMutation.isPending}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                キーワードに一致するGoogleニュースの記事を自動で収集します
              </p>
            </TabsContent>
          </Tabs>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">表示名（任意）</p>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="未入力ならフィード名を使用"
                maxLength={200}
                disabled={addMutation.isPending}
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">カテゴリ（任意）</p>
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="例: テクノロジー"
                maxLength={100}
                disabled={addMutation.isPending}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={addMutation.isPending}>
            {addMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Plus className="w-4 h-4" />
            )}
            {addMutation.isPending ? '確認中…' : '情報源を追加'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
