import { Loader2, LogOut } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { useConfirm } from '../ui/confirm-dialog';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';

export function LogoutOthersCard() {
  const confirm = useConfirm();
  const { toast } = useToast();

  const logoutOthers = useMutation({
    mutationFn: () => api.auth.logoutOthers(),
    onSuccess: (r) => {
      toast({
        title: 'ほかのブラウザからログアウトしました',
        description: `${r.deletedSessions} 件のログインを終了しました。`,
      });
    },
    onError: (err) => toast({ title: 'ログアウトできませんでした', description: err instanceof Error ? err.message : String(err), variant: 'destructive' }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LogOut className="h-4 w-4" />
          ほかのブラウザのログイン
        </CardTitle>
        <CardDescription>
          共用のパソコンなどでログインしたままにしているときは、ここからまとめてログアウトできます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          disabled={logoutOthers.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: 'ほかのブラウザからログアウトしますか？',
              description: 'いま使っているこのブラウザ以外の、すべてのブラウザでログアウトします。\nそれぞれのブラウザでは、もう一度ログインが必要になります。',
              confirmText: 'ログアウトする',
              destructive: true,
            });
            if (ok) logoutOthers.mutate();
          }}
        >
          {logoutOthers.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogOut className="h-4 w-4 mr-2" />}
          ほかのブラウザからログアウト
        </Button>
      </CardContent>
    </Card>
  );
}
