import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, Loader2 } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../lib/api';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';

export function AccountDeletionCard({ className }: { className?: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!user) return null;

  const handleDeleteAccount = async () => {
    if (confirmEmail.trim() !== user.email) {
      alert('確認用メールアドレスが一致しません');
      return;
    }
    setDeleting(true);
    try {
      await api.user.deleteAccount(confirmEmail.trim());
      qc.clear();
      window.location.href = '/login';
    } catch (err: any) {
      alert(err.message);
      setDeleting(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <Trash2 className="h-4 w-4 shrink-0" />
          退会（アカウント削除）
        </CardTitle>
        <CardDescription>
          退会すると、アカウントとすべてのデータ（情報源・記事・紙面・深掘り・音声版）をその場で削除します。
          削除後の復元はできません。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Dialog onOpenChange={(open) => { if (!open) setConfirmEmail(''); }}>
            <DialogTrigger asChild>
              <Button variant="destructive">
                <Trash2 className="h-4 w-4 mr-2" />
                退会する
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>本当に退会しますか？</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2 text-sm">
                    <p className="font-medium text-destructive">
                      アカウントとすべてのデータをその場で削除します。削除後の復元はできません。
                    </p>
                    <p>
                      続けるには、確認のためメールアドレス（<span className="font-medium">{user.email}</span>）を入力してください。
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>
              <Input
                type="email"
                autoComplete="off"
                placeholder={user.email}
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
              />
              <DialogFooter className="gap-2 sm:gap-0">
                <DialogClose asChild>
                  <Button variant="outline">キャンセル</Button>
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={handleDeleteAccount}
                  disabled={deleting || confirmEmail.trim() !== user.email}
                >
                  {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  退会する
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}
