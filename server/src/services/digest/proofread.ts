
import {
  createMessage,
  messageText,
  getGenerateModel,
  getEditionEffort,
  type CreateMessageFn,
} from './anthropicClient.js';

const MAX_TOKENS = 4000;
export const PROOFREAD_CONCURRENCY = 3;
export const PROOFREAD_BUDGET_MS = Number(process.env.DIGEST_PROOFREAD_BUDGET_MS || 3 * 60_000);

export const INSPECT_SYSTEM_PROMPT = `あなたは新聞社の校閲担当です。原稿が素材（元記事）から読み取れる内容だけで書かれているかを確かめてください。

判定の基準（厳守）:
- 判断材料は**渡された素材だけ**。あなた自身の知識で正誤を判断してはならない。
  あなたの知識は学習時点で止まっており、肩書や数値は既に変わっている可能性がある。
  「この人はもう社長ではないはず」のような知識に基づく指摘は**してはならない**
- 翻訳・要約・言い換えは素材にあるものとみなす。文字列の一致で見てはならない。
  例: 素材 "Mar 3, 2031" → 原稿「2031年3月3日」は問題なし
      素材 "vice president" → 原稿「副社長」も問題なし
      素材 "2.5 billion yen" → 原稿「25億円」も問題なし
- 指摘してよいのは**事実の裏付けが素材に無いもの**だけ:
  ① 素材に無い人物の肩書・役職・所属
  ② 素材に無い数値・金額・割合、または素材と食い違う数値
  ③ 素材に無い日付・時期・年、または素材と食い違う日付
  ④ 素材に無い位置づけの断定（「国内で初めて」「首位」「他に例のない」など）
  ⑤ 素材に書かれていない因果・背景・見通しの断定
- 文体・長さ・言い回し・構成には**一切口を出さない**（校正ではなく校閲）。
  読みやすさの改善提案は不要
- 迷ったら指摘しない。確実に素材から読み取れないものだけを挙げる

出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）。指摘が無ければ []:
[{"id": "記事ID", "issues": ["素材に無い記述と、その理由を1文で"]}, ...]`;

export const REVISE_SYSTEM_PROMPT = `あなたは新聞社の校閲担当です。指摘された記述だけを直してください。

厳守:
- 指摘された記述だけを削るか、素材に忠実な表現に直す
- それ以外は**一字も変えない**。文体を整えたり、言い回しを良くしたりしない
- 削った結果、記事が短くなるのは正しい。短くなった分を別の内容で埋めない
- 素材に書かれていない情報を新たに足すことは、いかなる理由でも禁止
- 見出し・リード・本文のうち、指摘に関係しない項目は元の文字列をそのまま返す

出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）:
[{"id": "記事ID", "headline": "見出し", "lead": "リード文", "body": "本文"}, ...]`;

export interface ProofreadItem {
  id: string;
  title: string | null;
  summaryRaw: string | null;
  content: string | null;
  headline: string;
  lead: string;
  body: string;
}

const YEN_AMOUNT_RE = /[0-9０-９][0-9０-９,，.．]*\s*(?:兆|億|万|千)?\s*円/g;

export function findUnsourcedYen(item: ProofreadItem): string | null {
  const material = `${item.title ?? ''} ${item.summaryRaw ?? ''} ${item.content ?? ''}`;
  if (/円|yen|¥|￥|JPY/i.test(material)) return null;
  const draft = `${item.headline}\n${item.lead}\n${item.body}`;
  const hits = [...new Set(draft.match(YEN_AMOUNT_RE) ?? [])];
  if (hits.length === 0) return null;
  return `［機械検査］円建ての金額（${hits.join('、')}）は素材に無い換算額。素材の通貨・桁のまま書く`;
}

export function mergeCodeFindings(findings: Finding[], items: ProofreadItem[]): Finding[] {
  const merged = findings.map((f) => ({ id: f.id, issues: [...f.issues] }));
  for (const it of items) {
    const issue = findUnsourcedYen(it);
    if (!issue) continue;
    const existing = merged.find((f) => f.id === it.id);
    if (existing) existing.issues.push(issue);
    else merged.push({ id: it.id, issues: [issue] });
  }
  return merged;
}

export function buildInspectUserMessage(items: ProofreadItem[], maxContentChars = 2000): string {
  return items
    .map((it) => [
      `[id: ${it.id}]`,
      '--- 素材（元記事） ---',
      `タイトル: ${(it.title ?? '').trim() || '(なし)'}`,
      `要約: ${(it.summaryRaw ?? '').trim() || '(なし)'}`,
      `本文: ${(it.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, maxContentChars) || '(なし)'}`,
      '--- 原稿 ---',
      `見出し: ${it.headline}`,
      `リード: ${it.lead}`,
      `本文: ${it.body}`,
    ].join('\n'))
    .join('\n\n');
}

export function buildReviseUserMessage(
  items: Array<ProofreadItem & { issues: string[] }>,
  maxContentChars = 2000,
): string {
  return items
    .map((it) => [
      `[id: ${it.id}]`,
      '--- 素材（元記事） ---',
      `タイトル: ${(it.title ?? '').trim() || '(なし)'}`,
      `要約: ${(it.summaryRaw ?? '').trim() || '(なし)'}`,
      `本文: ${(it.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, maxContentChars) || '(なし)'}`,
      '--- 原稿 ---',
      `見出し: ${it.headline}`,
      `リード: ${it.lead}`,
      `本文: ${it.body}`,
      '--- 校閲の指摘 ---',
      ...it.issues.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n'))
    .join('\n\n');
}

export function parseJsonArray(text: string): Array<Record<string, unknown>> {
  return readJsonArray(text) ?? [];
}

export function readJsonArray(text: string): Array<Record<string, unknown>> | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

const UNREADABLE_RETRIES = 1;

async function askJsonArray(
  createMessageFn: CreateMessageFn,
  body: Parameters<CreateMessageFn>[0],
): Promise<string> {
  let lastText = '';
  for (let attempt = 0; attempt <= UNREADABLE_RETRIES; attempt++) {
    lastText = messageText(await createMessageFn(body));
    if (readJsonArray(lastText) !== null) return lastText;
  }
  throw new Error(`読めない応答: ${lastText.replace(/\s+/g, ' ').slice(0, 80) || '（空）'}`);
}

export interface Finding {
  id: string;
  issues: string[];
}

export function parseFindings(text: string): Finding[] {
  return parseJsonArray(text)
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
      issues: Array.isArray(row.issues)
        ? row.issues.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        : [],
    }))
    .filter((f) => f.id && f.issues.length > 0);
}

export interface Revision {
  id: string;
  headline?: string;
  lead?: string;
  body?: string;
}

export function parseRevisions(text: string): Revision[] {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
  return parseJsonArray(text)
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
      headline: str(row.headline),
      lead: str(row.lead),
      body: str(row.body),
    }))
    .filter((r) => r.id);
}

export async function inspectBatch(
  items: ProofreadItem[],
  { createMessageFn = (body) => createMessage(body, { stage: 'proofread-inspect' }) }: { createMessageFn?: CreateMessageFn } = {},
): Promise<Finding[]> {
  if (items.length === 0) return [];
  const text = await askJsonArray(createMessageFn, {
    model: getGenerateModel(),
    max_tokens: MAX_TOKENS,
    output_config: { effort: getEditionEffort() },
    system: INSPECT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildInspectUserMessage(items) }],
  });
  return parseFindings(text);
}

export async function reviseBatch(
  items: Array<ProofreadItem & { issues: string[] }>,
  { createMessageFn = (body) => createMessage(body, { stage: 'proofread-revise' }) }: { createMessageFn?: CreateMessageFn } = {},
): Promise<Revision[]> {
  if (items.length === 0) return [];
  const text = await askJsonArray(createMessageFn, {
    model: getGenerateModel(),
    max_tokens: MAX_TOKENS,
    output_config: { effort: getEditionEffort() },
    system: REVISE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildReviseUserMessage(items) }],
  });
  return parseRevisions(text);
}

export async function runWithBudget<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  {
    concurrency = PROOFREAD_CONCURRENCY,
    budgetMs = PROOFREAD_BUDGET_MS,
    now = () => Date.now(),
    onSkip,
  }: {
    concurrency?: number;
    budgetMs?: number;
    now?: () => number;
    onSkip?: (skipped: number) => void;
  } = {},
): Promise<{ results: R[]; skipped: number; skippedItems: T[]; failedItems: T[] }> {
  const deadline = now() + budgetMs;
  const results: R[] = [];
  const skippedItems: T[] = [];
  const failedItems: T[] = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (true) {
      if (next >= items.length) return;
      if (now() >= deadline) {
        skippedItems.push(...items.slice(next));
        next = items.length;
        return;
      }
      const item = items[next++];
      try {
        results.push(await worker(item));
      } catch {
        failedItems.push(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  const skipped = skippedItems.length;
  if (skipped > 0) onSkip?.(skipped);
  return { results, skipped, skippedItems, failedItems };
}

export interface ProofreadResult {
  revised: Map<string, { headline: string; lead: string; body: string }>;
  findings: Finding[];
  skipped: number;
  failed: number;
  inspected: number;
}

export async function proofreadArticles(
  items: ProofreadItem[],
  {
    createMessageFn,
    batchSize = 5,
    concurrency = PROOFREAD_CONCURRENCY,
    budgetMs = PROOFREAD_BUDGET_MS,
    now = () => Date.now(),
  }: {
    createMessageFn?: CreateMessageFn;
    batchSize?: number;
    concurrency?: number;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<ProofreadResult> {
  const revised = new Map<string, { headline: string; lead: string; body: string }>();
  if (items.length === 0) return { revised, findings: [], skipped: 0, failed: 0, inspected: 0 };

  const batches: ProofreadItem[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));

  const deadline = now() + budgetMs;
  const remaining = () => Math.max(0, deadline - now());

  const inspect = await runWithBudget(
    batches,
    (batch) => inspectBatch(batch, { createMessageFn }),
    { concurrency, budgetMs, now },
  );
  const findings = mergeCodeFindings(inspect.results.flat(), items);
  const countArticles = (batches: ProofreadItem[][]): number =>
    batches.reduce((n, b) => n + b.length, 0);
  const skippedCount = countArticles(inspect.skippedItems);
  const failedCount = countArticles(inspect.failedItems);
  const inspected = Math.max(0, items.length - skippedCount - failedCount);

  if (findings.length === 0) {
    return { revised, findings, skipped: skippedCount, failed: failedCount, inspected };
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const targets = findings
    .map((f) => {
      const it = byId.get(f.id);
      return it ? { ...it, issues: f.issues } : null;
    })
    .filter((x): x is ProofreadItem & { issues: string[] } => x !== null);

  const reviseBatches: Array<Array<ProofreadItem & { issues: string[] }>> = [];
  for (let i = 0; i < targets.length; i += batchSize) reviseBatches.push(targets.slice(i, i + batchSize));

  const revise = await runWithBudget(
    reviseBatches,
    (batch) => reviseBatch(batch, { createMessageFn }),
    { concurrency, budgetMs: remaining(), now },
  );
  for (const r of revise.results.flat()) {
    const original = byId.get(r.id);
    if (!original) continue;
    revised.set(r.id, {
      headline: r.headline || original.headline,
      lead: r.lead || original.lead,
      body: r.body ?? original.body,
    });
  }

  return {
    revised,
    findings,
    skipped: skippedCount + countArticles(revise.skippedItems),
    failed: failedCount + countArticles(revise.failedItems),
    inspected,
  };
}
