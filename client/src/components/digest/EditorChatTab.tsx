import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Loader2, Paperclip, Send, Sparkles, X } from 'lucide-react';
import type {
  DigestChatAttachment,
  DigestChatHistoryItem,
  DigestChatRequest,
  DigestSourceProposal,
} from 'shared';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useToast } from '../../hooks/use-toast';
import { api } from '../../lib/api';

type ChatItem =
  | { role: 'user'; content: string; attachmentNames?: string[] }
  | { role: 'assistant'; content: string; proposals?: DigestSourceProposal[] };

const INTRO_MESSAGE =
  'はじめまして、編集長AIです。どんな情報を追いかけたいですか？ 業界・企業・テーマなど、自由にお聞かせください';

const EXAMPLE_CHIPS = ['生成AIの規制動向', '小売業のDX事例', '半導体業界の動き'];

const MAX_HISTORY = 30;

const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPT_ATTR = [...IMAGE_TYPES, 'application/pdf', '.txt', '.md', '.markdown', 'text/plain', 'text/markdown', '.docx', DOCX_TYPE].join(',');

function attachmentKind(file: File): DigestChatAttachment['kind'] | null {
  if (IMAGE_TYPES.includes(file.type)) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === DOCX_TYPE || /\.docx$/i.test(file.name)) return 'docx';
  if (file.type === 'text/plain' || file.type === 'text/markdown' || /\.(txt|md|markdown)$/i.test(file.name)) return 'text';
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function validateFile(file: File): string | null {
  const kind = attachmentKind(file);
  if (kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) return `画像は1枚5MB以下にしてください（${file.name}）`;
    return null;
  }
  if (kind === 'pdf') {
    if (file.size > MAX_PDF_BYTES) return `PDFは1件10MB以下にしてください（${file.name}）`;
    return null;
  }
  if (kind === 'text' || kind === 'docx') {
    if (file.size > MAX_DOCUMENT_BYTES) return `テキスト・Word のファイルは1件5MB以下にしてください（${file.name}）`;
    return null;
  }
  return `対応していないファイル形式です（${file.name}）。画像（PNG/JPEG/GIF/WebP）・PDF・テキスト（.txt/.md）・Word（.docx）を添付できます`;
}

const KIND_LABEL: Record<DigestSourceProposal['kind'], string> = {
  rss: 'RSS',
  gnews: 'Googleニュース',
};

function ProposalCard({ proposal }: { proposal: DigestSourceProposal }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(
    proposal.status === 'approved' ? 'approved' : proposal.status === 'rejected' ? 'rejected' : null
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['digest', 'feeds'] });
    qc.invalidateQueries({ queryKey: ['digest', 'proposals'] });
  };

  const approveMutation = useMutation({
    mutationFn: () => api.digest.approveProposal(proposal.id),
    onSuccess: (result) => {
      setDecided('approved');
      toast({ title: `「${result.feed.title}」を情報源に追加しました` });
      invalidate();
    },
    onError: (err: Error) => {
      toast({
        title: '承認できませんでした',
        description: err.message,
        variant: 'destructive',
      });
      invalidate();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => api.digest.rejectProposal(proposal.id),
    onSuccess: () => {
      setDecided('rejected');
      invalidate();
    },
  });

  const busy = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="rounded-md border border-border bg-background p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{proposal.title}</span>
        <Badge variant="secondary">{KIND_LABEL[proposal.kind]}</Badge>
        {proposal.category && <Badge variant="outline">{proposal.category}</Badge>}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{proposal.reason}</p>
      <div className="mt-2.5">
        {decided === 'approved' ? (
          <p className="flex items-center gap-1 text-xs font-medium text-primary">
            <Check className="w-3.5 h-3.5" />
            承認済み — 情報源に追加しました
          </p>
        ) : decided === 'rejected' ? (
          <p className="text-xs text-muted-foreground">見送りました</p>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => approveMutation.mutate()} disabled={busy}>
              {approveMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              承認
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => rejectMutation.mutate()}
              disabled={busy}
            >
              {rejectMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <X className="w-4 h-4" />
              )}
              見送り
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function renderInlineBold(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(/\*\*([^*]+)\*\*/g)
    .map((part, i) => (i % 2 === 1 ? <strong key={`${keyPrefix}-b${i}`}>{part}</strong> : part));
}

function renderChatMarkdown(content: string): ReactNode {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p-${blocks.length}`;
    blocks.push(
      <p key={key} className="mb-2 last:mb-0">
        {renderInlineBold(paragraph.join('\n'), key)}
      </p>,
    );
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    const key = `ul-${blocks.length}`;
    blocks.push(
      <ul key={key} className="mb-2 list-disc pl-5 last:mb-0">
        {bullets.map((b, i) => (
          <li key={i}>{renderInlineBold(b, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('・')) {
      flushParagraph();
      bullets.push(trimmed.replace(/^(?:- |・)/, '').trim());
    } else if (trimmed === '') {
      flushParagraph();
      flushBullets();
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();
  return <>{blocks}</>;
}

function ChatBubble({ item }: { item: ChatItem }) {
  const isUser = item.role === 'user';
  const attachmentNames = isUser ? item.attachmentNames : undefined;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm whitespace-pre-wrap ${
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        }`}
      >
        {attachmentNames && attachmentNames.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {attachmentNames.map((name, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-xs"
              >
                <Paperclip className="w-3 h-3" />
                {name}
              </span>
            ))}
          </div>
        )}
        {isUser ? item.content : renderChatMarkdown(item.content)}
      </div>
    </div>
  );
}

export function EditorChatTab({
  hasFeeds,
  premiumDefault = null,
  openPending = false,
}: {
  hasFeeds: boolean;
  premiumDefault?: boolean | null;
  openPending?: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [localItems, setLocalItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [pendingOpen, setPendingOpen] = useState(openPending);
  const [deep, setDeep] = useState(false);
  const [premiumChoice, setPremiumChoice] = useState<boolean | null>(null);
  const premium = premiumChoice ?? premiumDefault ?? false;
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<HTMLDivElement | null>(null);

  const historyQuery = useQuery<DigestChatHistoryItem[]>({
    queryKey: ['digest', 'chat-history'],
    queryFn: () => api.digest.chatHistory(),
  });
  const chat: ChatItem[] = [
    ...(historyQuery.data ?? []).map<ChatItem>((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content, attachmentNames: m.attachmentNames }
        : {
            role: 'assistant',
            content: m.content,
            proposals: m.proposals && m.proposals.length > 0 ? m.proposals : undefined,
          },
    ),
    ...localItems,
  ];

  const pendingQuery = useQuery<DigestSourceProposal[]>({
    queryKey: ['digest', 'proposals', 'proposed'],
    queryFn: () => api.digest.proposals('proposed'),
  });
  const pending = pendingQuery.data ?? [];

  const pendingScrolled = useRef(false);
  useEffect(() => {
    if (!openPending || pendingScrolled.current || pending.length === 0) return;
    pendingScrolled.current = true;
    pendingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [openPending, pending.length]);

  const chatMutation = useMutation({
    mutationFn: (req: DigestChatRequest) => api.digest.chat(req),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['digest', 'chat-history'] });
      setLocalItems([]);
    },
    onError: (err: Error, sent) => {
      const lastUser = sent.messages[sent.messages.length - 1];
      setLocalItems([]);
      setInput((v) => v || lastUser?.content || '');
      toast({
        title: '編集長AIへの相談に失敗しました',
        description: err.message,
        variant: 'destructive',
      });
    },
  });
  const waiting = chatMutation.isPending;
  const deepInFlight = waiting && chatMutation.variables?.deep === true;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length, waiting]);

  const addFiles = (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    const picked = Array.from(list);
    setFiles((current) => {
      const next = [...current];
      for (const file of picked) {
        if (next.length >= MAX_ATTACHMENTS) {
          toast({ title: `添付できるファイルは最大${MAX_ATTACHMENTS}件までです`, variant: 'destructive' });
          break;
        }
        const error = validateFile(file);
        if (error) {
          toast({ title: '添付できませんでした', description: error, variant: 'destructive' });
          continue;
        }
        if (next.reduce((sum, f) => sum + f.size, 0) + file.size > MAX_TOTAL_BYTES) {
          toast({
            title: '添付できませんでした',
            description: '添付の合計サイズが大きすぎます（合計30MB以下にしてください）',
            variant: 'destructive',
          });
          continue;
        }
        next.push(file);
      }
      return next;
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (file.type.startsWith('image/')) {
        const now = new Date();
        const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()]
          .map((n) => String(n).padStart(2, '0'))
          .join('');
        const ext = file.type.split('/')[1] ?? 'png';
        pasted.push(new File([file], `スクリーンショット-${hhmmss}.${ext}`, { type: file.type }));
      } else if (file.type === 'application/pdf') {
        pasted.push(file);
      }
    }
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (waiting) return;
    addFiles(e.dataTransfer?.files ?? null);
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || waiting) return;
    const attached = files;

    let attachments: DigestChatAttachment[] | undefined;
    if (attached.length > 0) {
      try {
        attachments = await Promise.all(
          attached.map(async (f) => ({
            kind: attachmentKind(f) ?? 'image',
            mediaType: f.type || (attachmentKind(f) === 'docx' ? DOCX_TYPE : 'text/plain'),
            dataBase64: await fileToBase64(f),
            name: f.name,
          })),
        );
      } catch {
        toast({ title: 'ファイルの読み込みに失敗しました', variant: 'destructive' });
        return;
      }
    }

    const userItem: ChatItem = {
      role: 'user',
      content: trimmed,
      attachmentNames: attached.length > 0 ? attached.map((f) => f.name) : undefined,
    };
    const nextChat: ChatItem[] = [...chat, userItem];
    setLocalItems((c) => [...c, userItem]);
    setInput('');
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    const messages = nextChat
      .map(({ role, content }) => ({ role, content }))
      .slice(-MAX_HISTORY);
    chatMutation.mutate({ messages, deep, premium, attachments });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <div ref={pendingRef}>
          <button
            type="button"
            onClick={() => setPendingOpen((v) => !v)}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={pendingOpen}
          >
            {pendingOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            未回答の提案（{pending.length} 件）
          </button>
          {pendingOpen && (
            <div className="mt-2 space-y-2">
              {pending.map((p) => (
                <ProposalCard key={p.id} proposal={p} />
              ))}
            </div>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-4 sm:p-5">
          <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
            {historyQuery.isLoading && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            )}

            {!hasFeeds && !historyQuery.isLoading && (
              <>
                <ChatBubble item={{ role: 'assistant', content: INTRO_MESSAGE }} />
                {chat.length === 0 && (
                  <div className="flex flex-wrap gap-2 pl-1">
                    {EXAMPLE_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => setInput(chip)}
                        className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {hasFeeds && chat.length === 0 && !historyQuery.isLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Sparkles className="mx-auto mb-2 w-6 h-6" />
                <p>追いかけたいテーマや業界を伝えると、編集長AIが情報源を探して提案します。</p>
              </div>
            )}

            {chat.map((item, i) => (
              <div key={i} className="space-y-2">
                <ChatBubble item={item} />
                {item.role === 'assistant' && item.proposals && (
                  <div className="space-y-2 pl-1 sm:pl-4">
                    {item.proposals.map((p) => (
                      <ProposalCard key={p.id} proposal={p} />
                    ))}
                    {item.proposals.length > 0 && (
                      <p className="px-1 text-xs text-muted-foreground">
                        提案は1回につき最大10件に絞っています（提案の質を保つため。件数で AI の費用は変わりません）。
                        もっと必要なときは「別の角度でもっと提案して」と送ってください。
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {waiting && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {deepInFlight
                    ? '資料とWebを深く調査しています…（数分かかることがあります）'
                    : '情報源を探しています…（Web検索中・1分ほどかかることがあります）'}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="mt-4 space-y-2.5 border-t border-border pt-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={deep}
                onChange={(e) => setDeep(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">詳細分析モード</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  ON中はWeb検索を強化し、URLの内容まで読み込んで深く調査します（時間が長くかかります）
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={premium}
                onChange={(e) => setPremiumChoice(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">じっくり選定モード</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  上位のAIモデルで、より質の高い情報源選定を行います（AI の費用は通常より高くなります）。
                  情報源の初期選定が紙面の質を決めるため、情報源が5件未満の間は自動でONになります
                </span>
              </span>
            </label>
          </div>

          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                >
                  <Paperclip className="w-3 h-3" />
                  {f.name}（{formatSize(f.size)}）
                  <button
                    type="button"
                    onClick={() => setFiles((c) => c.filter((_, j) => j !== i))}
                    aria-label={`${f.name} を取り外す`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <form
            onSubmit={submit}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="mt-2 flex items-end gap-2"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <span title="ファイルを添付（画像・PDF・テキスト・Word。貼り付け・ドラッグ&ドロップでも可）">
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={waiting}
                onClick={() => fileInputRef.current?.click()}
                aria-label="ファイルを添付"
              >
                <Paperclip className="w-4 h-4" />
              </Button>
            </span>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="例: 生成AIの規制動向を追いかけたい"
              maxLength={MAX_MESSAGE_CHARS}
              rows={2}
              disabled={waiting}
              className="flex-1 resize-none"
            />
            <Button type="submit" disabled={waiting || input.trim() === ''}>
              {waiting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              送信
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
