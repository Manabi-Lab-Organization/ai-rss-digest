
import {
  createMessage,
  messageText,
  getDedupeModel,
  getGenerateModel,
  getEditionEffort,
  type CreateMessageFn,
} from './anthropicClient.js';
import type { Representative } from './generate.js';

const MAX_TOKENS = 2000;

export interface DedupeItem {
  id: string;
  headline?: string | null;
  lead?: string | null;
  section?: string | null;
}

export interface DedupePrompt {
  system: string;
  user: string;
}

function renderDedupeItem(it: DedupeItem, i: number, mark = ''): string {
  return [
    `[${i + 1}]（セクション: ${it.section ?? '不明'}）${mark}`,
    `見出し: ${(it.headline ?? '').trim()}`,
    `リード: ${(it.lead ?? '').trim()}`,
  ].join('\n');
}

export function buildDedupePrompt(items: DedupeItem[]): DedupePrompt {
  const system = [
    'あなたは新聞編集部の整理部員です。紙面に採用予定の記事一覧から、',
    '「同一の事象・発表・出来事」を報じている記事のグループを検出してください。',
    '',
    'あなたは**最後の砦**です。記事の元タイトルは媒体ごとに切り口が異なるため、元タイトルだけでは同じ事象を取り逃がします。',
    'あなたが見ているのは生成後の日本語の見出しとリードで、表現が揃っているぶん判断しやすい。',
    'ここで束ねられなければ、同じ出来事の記事が紙面に並んだまま読者に届きます。',
    '',
    '判定基準:',
    '- 同じ出来事（同じ法律の成立、同じ企業の同じ発表、同じ製品のリリース等）を別媒体が報じたものは同一グループ',
    '- **同じ発表を別の角度から書いたもの**（切り口・強調点が違うだけ）も同一グループ',
    '- 掲載セクションが異なっていても、事象が同じならグループにする',
    '- **同じ訪問・会議・事件の一連の流れ**（到着、式典、会談の予定など）は、日付や切り口が違っても同じ出来事としてグループにする',
    '- 同じテーマ・同じ業界でも、事象が別（別の企業・別の発表）ならグループにしない',
    '  例: 「株式会社サンプルによるテスト工房株式会社の買収」と「架空半導体株式会社の資金調達」は、どちらも半導体の話でも別の出来事',
    '- **各グループには、共通する具体的な出来事を1つ、「誰が・何をした」の形で event に書く**（例: "株式会社サンプルによるテスト工房株式会社の買収"）。',
    '  「新技術の話題」「各社の新製品」「電池業界の動き」のようなテーマしか書けないなら、それは同じ出来事ではないのでグループにしない。',
    '  迷ってよいのは、同じ出来事を名指しできたうえで、切り口が違うだけかどうかを迷うときだけ。',
    '- **1つのグループに書ける出来事は1つだけ。** 「AとBがそれぞれ…」「A・B向けに…」のように2つをまとめて書くなら、それは別の出来事なのでグループにしない。',
    '- **各グループには、束ねる全記事の見出しかリードにそのまま出てくる固有名詞（企業名・製品名・人名・法律名など）を1つ subject に書く。**',
    '  すべての記事に共通して出てくる固有名詞が無いなら、同じ出来事ではないのでグループにしない。「新技術」「電池」のような一般的な言葉は固有名詞ではない。',
    '- **迷った場合はグループにしない。** 束ねると1本は本編から外れ、同じ紙面の非採用一覧「ほかにこんな記事がありました」に回る。',
    '  別の出来事を束ねると、読者は片方の出来事を本編で見落とす。同じ出来事の記事が2本並ぶより、そのほうが被害が大きい。',
    '',
    '出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）:',
    '[{"ids": [番号, 番号], "subject": "全記事に出てくる固有名詞", "event": "共通する出来事"}, ...]',
    '「番号」は一覧の [ ] の中の数字です。',
    '同一事象の記事が2本以上あるグループだけを出力してください。重複がなければ [] を返してください。',
  ].join('\n');

  const user = [
    `以下の${items.length}件の採用予定記事から同一事象グループを検出してください。`,
    '',
    ...items.map((it, i) => renderDedupeItem(it, i)),
  ].join('\n\n');

  return { system, user };
}

interface DedupeGroupRow {
  ids?: unknown;
  event?: unknown;
  subject?: unknown;
}

const THEME_MARKERS = ['それぞれ', '関連', '動向', '各社', '相次'];

const GENERIC_SUBJECTS = new Set(
  ['AI', '生成AI', 'AIエージェント', 'エージェント', 'LLM', '半導体', 'ロボット', 'EV', 'DX',
    '日本', '米国', '中国', '政府', '企業', 'スタートアップ'].map((w) => normalizeForMatch(w)),
);

function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function checkGroupEvidence(event: string, subject: string, members: DedupeItem[]): string | null {
  const marker = THEME_MARKERS.find((m) => event.includes(m));
  if (marker) return `出来事がテーマの言い回し（「${marker}」）`;
  const subj = normalizeForMatch(subject);
  if (subj.length < 2) return '全記事に共通する固有名詞（subject）が書かれていない';
  if (GENERIC_SUBJECTS.has(subj)) return `「${subject.trim()}」は一般的な言葉で、根拠にならない`;
  const missing = members.find((m) => !normalizeForMatch(`${m.headline ?? ''} ${m.lead ?? ''}`).includes(subj));
  if (missing) return `「${subject.trim()}」が「${String(missing.headline ?? '').slice(0, 20)}」に出てこない`;
  return null;
}

export interface RejectedGroup {
  ids: string[];
  event: string;
  subject: string;
  reason: string;
}

export function parseDedupeGroups(text: string, items: DedupeItem[]): string[][] {
  return parseDedupeGroupsDetailed(text, items).groups;
}

export function parseDedupeGroupsDetailed(
  text: string,
  items: DedupeItem[],
): { groups: string[][]; events: string[]; unknownIds: string[]; droppedNoEvent: string[][]; rejected: RejectedGroup[] } {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`JSON配列が見つかりません: ${text.slice(0, 120)}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('応答がJSON配列ではありません');

  const known = new Set(items.map((it) => it.id));
  const byId = new Map(items.map((it) => [it.id, it]));
  const toId = (v: unknown): string | undefined => {
    const raw = String(v).trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= 1 && n <= items.length) return items[n - 1].id;
    }
    return known.has(raw) ? raw : undefined;
  };

  const seen = new Set<string>();
  const unknown = new Set<string>();
  const groups: string[][] = [];
  const events: string[] = [];
  const droppedNoEvent: string[][] = [];
  const rejected: RejectedGroup[] = [];
  for (const row of parsed as DedupeGroupRow[]) {
    const rawIds = Array.isArray(row?.ids) ? row.ids : [];
    const mapped: string[] = [];
    for (const v of rawIds) {
      const id = toId(v);
      if (id === undefined) unknown.add(String(v));
      else if (!seen.has(id) && !mapped.includes(id)) mapped.push(id);
    }
    if (mapped.length < 2) continue;
    const event = typeof row?.event === 'string' ? row.event.trim() : '';
    if (!event) {
      droppedNoEvent.push(mapped);
      continue;
    }
    const subject = typeof row?.subject === 'string' ? row.subject.trim() : '';
    const reason = checkGroupEvidence(event, subject, mapped.map((id) => byId.get(id) ?? { id }));
    if (reason) {
      rejected.push({ ids: mapped, event, subject, reason });
      continue;
    }
    for (const id of mapped) seen.add(id);
    groups.push(mapped);
    events.push(event);
  }
  return { groups, events, unknownIds: [...unknown], droppedNoEvent, rejected };
}

export function chooseExcluded(groups: string[][], reps: Representative[]): Set<string> {
  const byId = new Map(reps.map((r) => [r.rep.id, r]));
  const excluded = new Set<string>();
  for (const ids of groups) {
    const members = ids.map((id) => byId.get(id)).filter((m): m is Representative => Boolean(m));
    if (members.length < 2) continue;
    members.sort(
      (a, b) => b.feedCount - a.feedCount || (b.rep.triageScore ?? 0) - (a.rep.triageScore ?? 0),
    );
    for (const m of members.slice(1)) excluded.add(m.rep.id);
  }
  return excluded;
}

export interface DedupeOutcome {
  groups: string[][];
  events?: string[];
  droppedNoEvent?: string[][];
  rejected?: RejectedGroup[];
  unknownIds: string[];
  rawText: string;
}

const EMPTY_OUTCOME: DedupeOutcome = { groups: [], events: [], unknownIds: [], rawText: '', droppedNoEvent: [], rejected: [] };

type DedupeOptions = {
  createMessageFn?: CreateMessageFn;
  retries?: number;
  logFn?: (line: string) => void;
};

export function formatRetryLog(label: string, attempt: number, rawText: string, err: unknown): string {
  const head = rawText.replace(/\s+/g, ' ').trim().slice(0, 80) || '（空）';
  const why = String((err as Error)?.message ?? err).slice(0, 60);
  return `[Digest:edition]   ${label}：読めない答えのためやり直し（${attempt}回目）— ${why} — 答えの冒頭: ${head}`;
}

async function runDedupe(
  { system, user }: DedupePrompt,
  known: DedupeItem[],
  {
    createMessageFn = (body) => createMessage(body, { stage: 'dedupe' }),
    retries = 2,
    logFn = (l) => console.log(l),
  }: DedupeOptions = {},
  label = '重複判定',
): Promise<DedupeOutcome> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await createMessageFn({
      model: getDedupeModel(),
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const rawText = messageText(response);
    try {
      return { ...parseDedupeGroupsDetailed(rawText, known), rawText };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) logFn(formatRetryLog(label, attempt + 1, rawText, err));
    }
  }
  throw lastErr;
}

export async function dedupeBatchDetailed(items: DedupeItem[], opts: DedupeOptions = {}): Promise<DedupeOutcome> {
  if (items.length < 2) return EMPTY_OUTCOME;
  return runDedupe(buildDedupePrompt(items), items, opts, '重複統合（号内）');
}

export async function dedupeBatch(items: DedupeItem[], opts: DedupeOptions = {}): Promise<string[][]> {
  return (await dedupeBatchDetailed(items, opts)).groups;
}

export function buildPublishedDedupePrompt(today: DedupeItem[], published: DedupeItem[]): DedupePrompt {
  const system = [
    'あなたは新聞編集部の整理部員です。今日の紙面に採用予定の記事が、前日までの号ですでに読者に届けた記事と',
    '「まったく同じ出来事」を報じていないかを確かめてください。',
    '',
    'ここで同じと判定した今日の記事は、**本編から1本も残さず外します**（同じ紙面の非採用一覧には残ります）。',
    '判定を誤ると、**読者が知るべき新しい展開が本編から消えます。**',
    '',
    '判定基準:',
    '- 前日までに報じた出来事を、別の媒体・別の言語・別の切り口で報じ直しただけのもの → 同じ出来事',
    '- **新しい展開（結果、決定、判決、合意、新しい数字や発表など）を含むもの → 同じ出来事にしない**',
    '  例: 前日「新工場の建設を検討」→ 今日「新工場の建設を正式に決定」は別。前日「値上げを申請」→ 今日「値上げが認可」は別。',
    '- **迷った場合はグループにしない。** 同じ話を2日続けて読ませる損より、新しい展開を見落とさせる損のほうが大きい。',
    '- 各グループには、共通する**具体的な出来事**を1つ、「誰が・何をした」の形で event に書く。',
    '  「物価の話題」「海外の情勢」のようなテーマしか書けないなら、同じ出来事ではないのでグループにしない。',
    '- **1つのグループに書ける出来事は1つだけ。** 「AとBがそれぞれ…」「A・B向けに…」のように2つをまとめて書くなら、それは別の出来事なのでグループにしない。',
    '- **各グループには、今日の記事と掲載済みの記事の両方の見出しかリードにそのまま出てくる固有名詞（企業名・製品名・人名・法律名など）を1つ subject に書く。**',
    '  両方に共通して出てくる固有名詞が無いなら、同じ出来事ではないのでグループにしない。「新技術」「電池」のような一般的な言葉は固有名詞ではない。',
    '',
    '出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）:',
    '[{"ids": [今日の記事の番号, 掲載済みの記事の番号], "subject": "両方に出てくる固有名詞", "event": "共通する出来事"}, ...]',
    '「番号」は一覧の [ ] の中の数字です。',
    '各グループには、今日の記事と【掲載済み】の記事をそれぞれ1本以上含めてください。該当が無ければ [] を返してください。',
  ].join('\n');

  const user = [
    `【今日の採用予定】${today.length}件`,
    '',
    ...today.map((it, i) => renderDedupeItem(it, i)),
    '',
    `─── ここから下は前日までの号に掲載済み（${published.length}件）───`,
    '',
    ...published.map((it, i) => renderDedupeItem(it, today.length + i, ' 【掲載済み】')),
  ].join('\n\n');

  return { system, user };
}

export async function dedupeAgainstPublished(
  today: DedupeItem[],
  published: DedupeItem[],
  opts: DedupeOptions = {},
): Promise<DedupeOutcome> {
  if (today.length === 0 || published.length === 0) return EMPTY_OUTCOME;
  return runDedupe(buildPublishedDedupePrompt(today, published), [...today, ...published], opts, '既報との照合');
}

export interface VerifyVerdict {
  same: boolean;
  reason: string;
}

export function buildPublishedVerifyPrompt(today: DedupeItem[], published: DedupeItem[]): DedupePrompt {
  const system = [
    'あなたは新聞編集部のデスクです。今日の記事が、前日までに掲載した記事と「まったく同じ出来事」を報じているかだけを判定してください。',
    '同じと判定すると、今日の記事は本編から外れます。誤って外すと、読者は新しい出来事を見落とします。',
    '',
    '同じ出来事: 同じ主体の同じ発表・決定・事件を、別の媒体・別の言語・別の切り口で報じ直したもの。',
    '別の出来事:',
    '- 新しい展開（結果・決定・判決・合意・新しい数字や発表）',
    '- 同じ主体による別の発表・別の取り組み',
    '- 同じ話題・同じ指標・同じ制度・同じ業界についての、別の動き',
    '  例: 「架空市の5月の観光客数が過去最多」と「観光客数の数え方を架空市が見直し」は別の出来事。',
    '  例: 「サンプル電機が不正アクセスを防いだと発表」と「警備ロボットのテスト工房が資金調達」は別の出来事。',
    '',
    '**迷ったら別の出来事とする。**',
    '',
    '出力は次の形式のJSONのみ（説明文・コードフェンス不要）:',
    '{"same": true または false, "reason": "判断の理由を一文で"}',
  ].join('\n');

  const block = (label: string, list: DedupeItem[]) => [
    label,
    ...list.map((it) => `見出し: ${(it.headline ?? '').trim()}\nリード: ${(it.lead ?? '').trim()}`),
  ].join('\n\n');
  const user = [block('【今日の記事】', today), block('【前日までに掲載した記事】', published)].join('\n\n');
  return { system, user };
}

export function parseVerifyAnswer(text: string): VerifyVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`JSONが見つかりません: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(text.slice(start, end + 1)) as { same?: unknown; reason?: unknown };
  return {
    same: parsed.same === true,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
  };
}

export async function verifyPublishedGroup(
  today: DedupeItem[],
  published: DedupeItem[],
  opts: DedupeOptions = {},
): Promise<VerifyVerdict> {
  return runVerify(buildPublishedVerifyPrompt(today, published), '既報の確かめ直し', opts);
}

export function buildIntraVerifyPrompt(items: DedupeItem[]): DedupePrompt {
  const system = [
    'あなたは新聞編集部のデスクです。今日の紙面に載せる予定の次の記事が、「まったく同じ出来事」を報じているかだけを判定してください。',
    '同じと判定すると、1本だけを本編に残し、残りは本編から外します。誤って束ねると、読者は別の出来事を本編で見落とします。',
    '',
    '同じ出来事: 同じ主体の同じ発表・決定・事件を、別の媒体・別の言語・別の切り口で報じたもの。同じ発表の続報や一連の流れも含む。',
    '別の出来事:',
    '- 同じ企業・同じ人物による、別の発表・別の取り組み',
    '  例: 「サンプル電機の研究所が新しい電池素材を開発」と「サンプル電機が新型の掃除機を全国で発売」は別の出来事。',
    '- 同じ媒体の同じ調査・同じ連載に属する、別の内容の記事',
    '  例: 「架空新聞の調査による喫茶店の売上ランキング」と「同じ調査でパン店の7割が値上げ」は別の出来事。',
    '- 同じ話題・同じ業界・同じ指標についての、別の動き',
    '',
    '**迷ったら別の出来事とする。**',
    '',
    '出力は次の形式のJSONのみ（説明文・コードフェンス不要）:',
    '{"same": true または false, "reason": "判断の理由を一文で"}',
  ].join('\n');
  const user = items
    .map((it, i) => `【記事${i + 1}】\n見出し: ${(it.headline ?? '').trim()}\nリード: ${(it.lead ?? '').trim()}`)
    .join('\n\n');
  return { system, user };
}

export async function verifyIntraGroup(items: DedupeItem[], opts: DedupeOptions = {}): Promise<VerifyVerdict> {
  return runVerify(buildIntraVerifyPrompt(items), '号内の確かめ直し', opts);
}

async function runVerify(
  { system, user }: DedupePrompt,
  label: string,
  {
    createMessageFn = (body) => createMessage(body, { stage: 'dedupe-verify' }),
    retries = 1,
    logFn = (l) => console.log(l),
  }: DedupeOptions = {},
): Promise<VerifyVerdict> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await createMessageFn({
      model: getGenerateModel(),
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: getEditionEffort() },
    });
    const rawText = messageText(response);
    try {
      return parseVerifyAnswer(rawText);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) logFn(formatRetryLog(label, attempt + 1, rawText, err));
    }
  }
  throw lastErr;
}

export function formatDedupeLog(
  kind: '号内' | '既報',
  outcome: DedupeOutcome,
  { todayCount, publishedCount = 0, headlineOf, publishedIds = new Set<string>() }: {
    todayCount: number;
    publishedCount?: number;
    headlineOf: (id: string) => string;
    publishedIds?: Set<string>;
  },
): string[] {
  const short = (id: string) => `「${String(headlineOf(id) ?? '').slice(0, 30)}」${publishedIds.has(id) ? '【既報】' : ''}`;
  const scope = kind === '号内'
    ? `重複統合（号内）: 採用${todayCount}件を照合`
    : `既報との照合: 採用${todayCount}件 × 掲載済み${publishedCount}件`;
  const lines: string[] = [];
  const answer = () => outcome.rawText.replace(/\s+/g, ' ').trim().slice(0, 160) || '（空）';

  if (kind === '号内' && todayCount < 2) {
    lines.push(`[Digest:edition] ${scope} → 照合不要（採用${todayCount}件のため AI は呼んでいません）`);
    return lines;
  }
  if (kind === '既報' && (todayCount === 0 || publishedCount === 0)) {
    lines.push(`[Digest:edition] ${scope} → 照合不要（比べる相手が無いため AI は呼んでいません）`);
    return lines;
  }

  const eventOf = (g: string[]) => outcome.events?.[outcome.groups.indexOf(g)];
  const groupLine = (label: string, g: string[]) => {
    const ev = eventOf(g);
    return `[Digest:edition]   ${label}: ${g.map(short).join(' ／ ')}${ev ? ` — 出来事: ${ev}` : ''}`;
  };

  if (kind === '号内') {
    if (outcome.groups.length === 0) {
      lines.push(`[Digest:edition] ${scope} → 同一事象なし（AIの答え: ${answer()}）`);
    } else {
      lines.push(`[Digest:edition] ${scope} → 同一事象${outcome.groups.length}グループ`);
      for (const g of outcome.groups) lines.push(groupLine('束ねた', g));
    }
  } else {
    const hits = outcome.groups.filter((g) => g.some((id) => publishedIds.has(id)) && g.some((id) => !publishedIds.has(id)));
    const pastDups = outcome.groups.filter((g) => g.every((id) => publishedIds.has(id)));
    const todayOnly = outcome.groups.filter((g) => g.every((id) => !publishedIds.has(id)));
    if (hits.length === 0) {
      lines.push(`[Digest:edition] ${scope} → 既報と同じ事象なし（AIの答え: ${answer()}）`);
    } else {
      lines.push(`[Digest:edition] ${scope} → 既報と同じ事象${hits.length}件`);
      for (const g of hits) lines.push(groupLine('束ねた', g));
    }
    for (const g of pastDups) lines.push(groupLine('過去の号で重複していた話題（配信済み・外すものなし）', g));
    for (const g of todayOnly) lines.push(groupLine('今日の記事どうし（号内の判定に任せるため使わない）', g));
  }
  for (const g of outcome.droppedNoEvent ?? []) {
    lines.push(`[Digest:edition]   出来事を名指ししなかったので使わない: ${g.map(short).join(' ／ ')}`);
  }
  for (const r of outcome.rejected ?? []) {
    lines.push(
      `[Digest:edition]   根拠が足りないので使わない: ${r.ids.map(short).join(' ／ ')} — ${r.reason}（出来事: ${r.event}）`,
    );
  }
  if (outcome.unknownIds.length > 0) {
    lines.push(`[Digest:edition]   一覧に無いIDを捨てた: ${outcome.unknownIds.join(', ')}`);
  }
  return lines;
}

export function excludeAlreadyPublished(groups: string[][], publishedIds: Set<string>): Set<string> {
  const excluded = new Set<string>();
  for (const ids of groups) {
    if (!ids.some((id) => publishedIds.has(id))) continue;
    for (const id of ids) if (!publishedIds.has(id)) excluded.add(id);
  }
  return excluded;
}

export function splitStoredSummary(summary: string | null | undefined): { headline: string; lead: string } {
  const parts = String(summary ?? '').split('｜');
  return { headline: (parts[0] ?? '').trim(), lead: (parts[1] ?? '').trim() };
}

export interface DedupeRoundDeps {
  intraFn?: (items: DedupeItem[]) => Promise<DedupeOutcome>;
  crossFn?: (today: DedupeItem[], published: DedupeItem[]) => Promise<DedupeOutcome>;
  verifyFn?: (today: DedupeItem[], published: DedupeItem[]) => Promise<VerifyVerdict>;
  intraVerifyFn?: (items: DedupeItem[]) => Promise<VerifyVerdict>;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

export async function dedupeRound(
  items: DedupeItem[],
  published: DedupeItem[],
  reps: Representative[],
  { crossAlive, headlineOf, verifyCache }: {
    crossAlive: boolean;
    headlineOf: (id: string) => string;
    verifyCache?: Map<string, VerifyVerdict>;
  },
  {
    intraFn = (it) => dedupeBatchDetailed(it),
    crossFn = (t, p) => dedupeAgainstPublished(t, p),
    verifyFn = (t, p) => verifyPublishedGroup(t, p),
    intraVerifyFn = (it) => verifyIntraGroup(it),
    log = (l) => console.log(l),
    logError = (l) => console.error(l),
  }: DedupeRoundDeps = {},
): Promise<{ removed: Set<string>; crossAlive: boolean }> {
  const short = (id: string) => `「${String(headlineOf(id) ?? '').slice(0, 34)}」`;

  const intra = await intraFn(items);
  for (const line of formatDedupeLog('号内', intra, { todayCount: items.length, headlineOf })) log(line);
  const itemById = new Map(items.map((it) => [it.id, it]));
  const intraConfirmed: string[][] = [];
  for (const g of intra.groups) {
    const members = g.map((id) => itemById.get(id) ?? { id });
    try {
      const key = `intra:${[...g].sort().join(',')}`;
      const v = verifyCache?.get(key) ?? await intraVerifyFn(members);
      verifyCache?.set(key, v);
      if (v.same) {
        intraConfirmed.push(g);
        log(`[Digest:edition]   確認で同じ出来事と判定（号内）: ${g.map(short).join(' ／ ')} — ${v.reason}`);
      } else {
        log(`[Digest:edition]   確認で別の出来事と判定（号内・両方本編に残す）: ${g.map(short).join(' ／ ')} — ${v.reason}`);
      }
    } catch (err) {
      logError(
        `[Digest:edition]   確認できなかったので束ねない（号内）: ${g.map(short).join(' ／ ')} — `
        + `${String((err as Error).message ?? err).slice(0, 120)}`,
      );
    }
  }
  const intraOut = chooseExcluded(intraConfirmed, reps);
  for (const id of intraOut) log(`[Digest:edition]   号内で外した: ${short(id)}`);

  let alreadyOut = new Set<string>();
  let alive = crossAlive && published.length > 0;
  if (alive) {
    try {
      const cross = await crossFn(items, published);
      const publishedIds = new Set(published.map((p) => p.id));
      for (const line of formatDedupeLog('既報', cross, {
        todayCount: items.length, publishedCount: published.length, headlineOf, publishedIds,
      })) log(line);
      const byId = new Map([...items, ...published].map((it) => [it.id, it]));
      const confirmed: string[][] = [];
      for (const g of cross.groups) {
        if (!g.some((id) => publishedIds.has(id)) || g.every((id) => publishedIds.has(id))) continue;
        const t = g.filter((id) => !publishedIds.has(id)).map((id) => byId.get(id) ?? { id });
        const p = g.filter((id) => publishedIds.has(id)).map((id) => byId.get(id) ?? { id });
        try {
          const key = [...g].sort().join(',');
          const v = verifyCache?.get(key) ?? await verifyFn(t, p);
          verifyCache?.set(key, v);
          if (v.same) {
            confirmed.push(g);
            log(`[Digest:edition]   確認で同じ出来事と判定: ${t.map((x) => short(x.id)).join(' ／ ')} — ${v.reason}`);
          } else {
            log(`[Digest:edition]   確認で別の出来事と判定（本編に残す）: ${t.map((x) => short(x.id)).join(' ／ ')} — ${v.reason}`);
          }
        } catch (err) {
          logError(
            `[Digest:edition]   確認できなかったので本編に残す: ${t.map((x) => short(x.id)).join(' ／ ')} — `
            + `${String((err as Error).message ?? err).slice(0, 120)}`,
          );
        }
      }
      alreadyOut = excludeAlreadyPublished(confirmed, publishedIds);
      for (const id of alreadyOut) log(`[Digest:edition]   既報（連日）: ${short(id)}`);
    } catch (err) {
      alive = false;
      logError(
        `[Digest:edition] 既報との照合は実行できませんでした（号内の結果は使います）: `
        + `${String((err as Error).message ?? err).slice(0, 120)}`,
      );
    }
  }

  return { removed: new Set([...intraOut, ...alreadyOut]), crossAlive: alive };
}

export const MAX_DEDUPE_ROUNDS = 6;

export async function dedupeUntilStable<T>(
  initial: T,
  round: (selected: T) => Promise<Set<string>>,
  refill: (removed: Set<string>) => T,
  { maxRounds = MAX_DEDUPE_ROUNDS }: { maxRounds?: number } = {},
): Promise<{ selected: T; rounds: number; capped: boolean }> {
  let selected = initial;
  for (let r = 1; r <= maxRounds; r++) {
    const removed = await round(selected);
    if (removed.size === 0) return { selected, rounds: r, capped: false };
    selected = refill(removed);
  }
  return { selected, rounds: maxRounds, capped: true };
}
