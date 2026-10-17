import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import type { DigestFrequency, DigestProfile, DigestSettings } from 'shared';
import { DEFAULT_DIGEST_SETTINGS } from 'shared';
import { Card, CardContent } from '../ui/card';
import { SectionHeading } from '../ui/help-note';
import { Button } from '../ui/button';
import { useToast } from '../../hooks/use-toast';
import { useServerFeatures } from '../../hooks/useServerFeatures';
import { api } from '../../lib/api';

const FREQUENCY_OPTIONS: Array<{ value: DigestFrequency; label: string }> = [
  { value: 'daily', label: '毎日' },
  { value: 'weekly3', label: '週3回（月・水・金）' },
  { value: 'weekly1', label: '週1回（月）' },
];

const selectClass =
  'h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function DigestSettingsForm() {
  const features = useServerFeatures();
  const qc = useQueryClient();
  const { toast } = useToast();

  const profileQuery = useQuery<DigestProfile>({
    queryKey: ['digest', 'profile'],
    queryFn: () => api.digest.profile(),
  });

  const [form, setForm] = useState<DigestSettings>(DEFAULT_DIGEST_SETTINGS);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (profileQuery.data && !dirty) setForm(profileQuery.data.settings);
  }, [profileQuery.data, dirty]);

  const saveMutation = useMutation({
    mutationFn: (settings: Partial<DigestSettings>) => api.digest.updateProfile(settings),
    onSuccess: (profile) => {
      setDirty(false);
      setForm(profile.settings);
      qc.setQueryData(['digest', 'profile'], profile);
      toast({ title: '設定を保存しました' });
    },
  });

  const update = <K extends keyof DigestSettings>(key: K, value: DigestSettings[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  if (profileQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <SectionHeading
        title="配信"
        help={
          '設定した時刻に、その日の朝刊が自動で作られます。頻度を下げると、その分だけまとめて届きます。'
          + (features.email ? 'メールは紙面の見出しとリードを載せた要約版で、本文はこの画面で読みます。' : '')
        }
      />
      <Card>
      <CardContent className="p-5 space-y-5">
        <div>
          <label htmlFor="digest-delivery-hour" className="block text-sm font-medium mb-1">
            配信時刻（JST）
          </label>
          <select
            id="digest-delivery-hour"
            value={form.deliveryHour}
            onChange={(e) => update('deliveryHour', Number(e.target.value))}
            className={selectClass}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="digest-frequency" className="block text-sm font-medium mb-1">
            配信頻度
          </label>
          <select
            id="digest-frequency"
            value={form.frequency}
            onChange={(e) => update('frequency', e.target.value as DigestFrequency)}
            className={selectClass}
          >
            {FREQUENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {features.email && (
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
            <input
              type="checkbox"
              checked={form.emailEnabled}
              onChange={(e) => update('emailEnabled', e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            メールでも受け取る
          </label>
        )}

        <div>
          <Button
            onClick={() => saveMutation.mutate(form)}
            disabled={saveMutation.isPending || !dirty}
          >
            {saveMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            保存
          </Button>
        </div>
      </CardContent>
      </Card>
    </div>
  );
}
