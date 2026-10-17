
import {
  createMessage,
  messageText,
  getGenerateModel,
  getEditionEffort,
  isRetryableAnthropicError,
  type AnthropicEffort,
  type CreateMessageFn,
} from './anthropicClient.js';
import { sourceLine } from './triage.js';

const MAX_TOKENS = 16000;
const RETRY_BASE_MS = 10_000;
const MAX_CONTENT_CHARS = 1500;

export const DEFAULT_SECTIONS = [
  '総合',
  '経済・ビジネス',
  'テクノロジー・AI',
  '行政・政策',
  '国際',
  '社会・地域',
  '文化・スポーツ',
  'その他',
];
export const PER_SECTION = 5;

export interface GenerateArticle {
  id: string;
  feedId?: string | number | null;
  title: string | null;
  summaryRaw: string | null;
  content?: string | null;
  clusterId?: string | null;
  triageScore?: number | null;
  feedTitle?: string | null;
  feedTier?: string | null;
  sourceSite?: string | null;
}

export interface Representative {
  rep: GenerateArticle;
  memberIds: string[];
  clusterSize: number;
  feedCount: number;
  sourceCount: number;
}

function sourceKey(a: GenerateArticle): string {
  const name = (a.feedTitle ?? '').trim();
  if (name) return `name:${name}`;
  if (a.sourceSite) return `site:${a.sourceSite}`;
  return `feed:${a.feedId ?? a.id}`;
}

export function pickRepresentatives(articles: GenerateArticle[]): Representative[] {
  const byCluster = new Map<string, { rep: GenerateArticle; members: GenerateArticle[] }>();
  for (const a of articles) {
    const key = a.clusterId ?? `solo_${a.id}`;
    const cur = byCluster.get(key);
    if (
      !cur ||
      (a.triageScore ?? 0) > (cur.rep.triageScore ?? 0) ||
      ((a.triageScore ?? 0) === (cur.rep.triageScore ?? 0) &&
        (a.summaryRaw ?? '').length > (cur.rep.summaryRaw ?? '').length)
    ) {
      byCluster.set(key, { rep: a, members: [...(cur?.members ?? []), a] });
    } else {
      cur.members.push(a);
    }
  }
  return [...byCluster.values()].map(({ rep, members }) => ({
    rep,
    memberIds: members.map((m) => m.id),
    clusterSize: members.length,
    feedCount: new Set(members.map((m) => m.feedId)).size,
    sourceCount: new Set(members.map(sourceKey)).size,
  }));
}

export function materialChars(rep: GenerateArticle): number {
  const summary = (rep.summaryRaw ?? '').trim().slice(0, 400).length;
  const content = (rep.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, MAX_CONTENT_CHARS).length;
  return summary + content;
}

export interface WritingPlan {
  lead: string;
  body: string;
}

export function writingPlan(chars: number): WritingPlan {
  if (chars >= 1200) return { lead: '2〜3文・80〜140字', body: '3〜6文・150〜300字' };
  if (chars >= 600) return { lead: '2〜3文・80〜140字', body: '2〜4文・100〜200字' };
  return { lead: '1〜2文・50〜120字', body: '1〜2文・50〜100字' };
}

export const THIN_MATERIAL_CHARS = 600;

export interface GeneratePrompt {
  system: string;
  user: string;
}

export function buildGeneratePrompt(
  profileText: string,
  reps: Representative[],
  sections: string[] = DEFAULT_SECTIONS,
): GeneratePrompt {
  const system = [
    'あなたは、読者ごとに作る朝刊の編集者です。',
    '各記事に「見出し」と「リード文1行」を書き、掲載セクションを割り当ててください。',
    '',
    '<editorial_profile>',
    profileText.trim(),
    '</editorial_profile>',
    '',
    '制約（厳守）:',
    '- 見出し: 30字以内。事実ベースで簡潔に。煽らない',
    '- リード文・本文の分量は、記事ごとに「分量の指定」として与える。その範囲で書くこと。',
    '  指定より長く書いてはならない。素材に書かれていることだけで指定に届かない場合は、短いままでよい',
    '- リード文: 「誰が・何を・いくらで・いつ」のうち素材にある事実を凝縮する',
    '- 本文: 経済紙の記事のように、リードに続く詳細事実を書く。本文冒頭の情報から具体的に書き、',
    '  憶測や一般論は書かない。背景・業界への意味は、素材に書かれている場合のみ書く',
    '- 論考記事の場合: 何が新しい視点かをリードで明示し、本文で骨子を要約する',
    '',
    '正確さの原則（他の指示に優先する）:',
    '- 人物の肩書・役職・所属は、その記事が報じている出来事の一部である場合のみ書く。',
    '  筆者・発言者が何者かを紹介するために肩書を付けてはならない（素材に書かれていても付けない）。',
    '  肩書は辞任・異動で変わるため、報道の対象でない肩書は古い情報になりやすい。氏名だけを書く',
    '- 「国内で初めて」「首位」「他に例のない」のような位置づけの断定は、素材にその記述がある場合のみ書く',
    '- 数値・日付は素材の精度のまま書く。素材が「半数近く」なら「半数近く」と書き、「45%」に直さない。',
    '  素材に無い数値・日付・年を、あなたの知識から補ってはならない',
    '- 金額は素材の通貨・単位・桁のまま書く。ドルを円に直すなど、別の通貨に換算しない（換算額は素材に書かれている場合のみ書く）。',
    '  「$7.5B」は「75億ドル」。桁の読み替え（B=10億、M=100万）を誤らないこと。見出しも同じ',
    `- セクション: 次のいずれか1つ ${JSON.stringify(sections)}`,
    '- 情報源の数（sources）は、同じ出来事を報じている情報源の数。多くの情報源が報じていて素材に新しい事実が無い記事は、',
    '  読者が既に知っている可能性が高い（プロファイルの「既知性の軸」を適用）。媒体の名前や知名度で扱いを変えない',
    '',
    '出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）:',
    '[{"id": 番号, "headline": "見出し", "lead": "リード文", "body": "本文", "section": "セクション名"}, ...]',
    '「番号」は一覧の [ ] の中の数字です。必ず入力された全記事の番号を1回ずつ含めてください。',
  ].join('\n');

  const user = [
    `以下の${reps.length}件を処理してください。`,
    '',
    ...reps.map(({ rep, clusterSize, sourceCount }, i) =>
      [
        `[${i + 1}] (score: ${rep.triageScore}, sources: ${sourceCount}, cluster: ${clusterSize}記事)`,
        `タイトル: ${(rep.title ?? '').trim()}`,
        `出典: ${sourceLine(rep)}`,
        `要約: ${(rep.summaryRaw ?? '').trim().slice(0, 400) || '(なし)'}`,
        `本文冒頭: ${(rep.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, MAX_CONTENT_CHARS) || '(なし)'}`,
        `分量の指定: リード ${writingPlan(materialChars(rep)).lead} / 本文 ${writingPlan(materialChars(rep)).body}`,
      ].join('\n'),
    ),
  ].join('\n\n');

  return { system, user };
}

export interface GeneratedArticle {
  headline: string;
  lead: string;
  body: string;
  section: string;
}

interface GeneratedRow {
  id?: unknown;
  headline?: unknown;
  lead?: unknown;
  body?: unknown;
  section?: unknown;
}

export function parseGenerated(
  text: string,
  reps: Representative[],
  sections: string[] = DEFAULT_SECTIONS,
): Map<string, GeneratedArticle> {
  return parseGeneratedDetailed(text, reps, sections).generated;
}

export interface GenerateParse {
  generated: Map<string, GeneratedArticle>;
  missing: string[];
  unknown: string[];
  duplicated: string[];
}

export function parseGeneratedDetailed(
  text: string,
  reps: Representative[],
  sections: string[] = DEFAULT_SECTIONS,
): GenerateParse {
  const start = text.indexOf('[');
  if (start < 0) {
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      return parseGeneratedDetailed(`[${text.slice(objStart, objEnd + 1)}]`, reps, sections);
    }
    throw new Error(`JSON配列が見つかりません: ${text.slice(0, 120)}`);
  }
  let end = text.lastIndexOf(']');
  let body: string;
  if (end > start) {
    body = text.slice(start, end + 1);
  } else {
    end = text.lastIndexOf('}');
    if (end <= start) throw new Error(`JSON配列が閉じておらず救済もできません: ${text.slice(0, 120)}`);
    body = `${text.slice(start, end + 1)}]`;
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('応答がJSON配列ではありません');

  const known = new Set(reps.map((r) => r.rep.id));
  const toId = (v: unknown): string | undefined => {
    const raw = String(v).trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= 1 && n <= reps.length) return reps[n - 1].rep.id;
    }
    return known.has(raw) ? raw : undefined;
  };
  const results = new Map<string, GeneratedArticle>();
  const unknown: string[] = [];
  const duplicated = new Set<string>();
  for (const row of parsed as GeneratedRow[]) {
    if (!row) continue;
    const id = toId(row.id);
    if (id === undefined) {
      unknown.push(String(row.id));
      continue;
    }
    if (!row.headline || !row.lead) continue;
    if (results.has(id)) {
      duplicated.add(id);
      continue;
    }
    results.set(id, {
      headline: String(row.headline).trim(),
      lead: String(row.lead).trim(),
      body: String(row.body ?? '').trim(),
      section: sections.includes(String(row.section)) ? String(row.section) : 'その他',
    });
  }
  const missing = reps.map((r) => r.rep.id).filter((id) => !results.has(id));
  return { generated: results, missing, unknown, duplicated: [...duplicated] };
}

export function formatGenerateGaps({ total, missing, recovered, unknown, duplicated }: {
  total: number; missing: number; recovered: number; unknown: string[]; duplicated: string[];
}): string {
  const parts = [`[Digest:edition]   生成の取りこぼし（${total}件中）: 書かれなかった${missing}件`];
  if (missing > 0) parts.push(`→ もう1回頼んで${recovered}件生成`);
  if (unknown.length > 0) parts.push(`/ 一覧に無い番号: ${unknown.slice(0, 5).join(', ')}`);
  if (duplicated.length > 0) parts.push(`/ 2回書いた記事${duplicated.length}件（最初の原稿を使用）`);
  return parts.join(' ');
}

export const MAX_PER_FEED = 2;

export function selectTopPerSection(
  reps: Representative[],
  generated: Map<string, GeneratedArticle>,
  perSection: number = PER_SECTION,
  exclude: Set<string> = new Set(),
  sections: string[] = DEFAULT_SECTIONS,
): Set<string> {
  const bySection = new Map<string, Representative[]>(sections.map((s) => [s, []]));
  for (const r of reps) {
    if (exclude.has(r.rep.id)) continue;
    const g = generated.get(r.rep.id);
    if (g) bySection.get(g.section)?.push(r);
  }
  const selected = new Set<string>();
  const perFeed = new Map<string | number, number>();
  for (const [, list] of bySection) {
    list.sort(
      (a, b) => b.feedCount - a.feedCount || (b.rep.triageScore ?? 0) - (a.rep.triageScore ?? 0),
    );
    let taken = 0;
    for (const r of list) {
      if (taken >= perSection) break;
      const feedKey = r.rep.feedId ?? `solo_${r.rep.id}`;
      if ((perFeed.get(feedKey) ?? 0) >= MAX_PER_FEED) continue;
      selected.add(r.rep.id);
      perFeed.set(feedKey, (perFeed.get(feedKey) ?? 0) + 1);
      taken++;
    }
  }
  return selected;
}

type GenerateBatchOptions = {
  profileText: string;
  createMessageFn?: CreateMessageFn;
  retries?: number;
  sections?: string[];
  effort?: AnthropicEffort;
  sleepFn?: (ms: number) => Promise<void>;
  logFn?: (line: string) => void;
};

export async function generateBatch(
  reps: Representative[],
  opts: GenerateBatchOptions,
): Promise<Map<string, GeneratedArticle>> {
  const { logFn = (l: string) => console.log(l) } = opts;
  const first = await generateWithRetries(reps, opts);
  const generated = first.generated;

  const { missing, unknown, duplicated } = first;
  if (missing.length > 0 || unknown.length > 0 || duplicated.length > 0) {
    let recovered = 0;
    let note = '';
    if (missing.length > 0) {
      try {
        const again = await generateWithRetries(reps.filter((r) => missing.includes(r.rep.id)), { ...opts, retries: 0 });
        for (const [id, g] of again.generated) {
          generated.set(id, g);
          recovered++;
        }
      } catch (err) {
        note = `（やり直し失敗: ${String((err as Error).message ?? err).slice(0, 60)}）`;
      }
    }
    logFn(formatGenerateGaps({ total: reps.length, missing: missing.length, recovered, unknown, duplicated }) + note);
  }
  return generated;
}

async function generateWithRetries(
  reps: Representative[],
  {
    profileText,
    createMessageFn = (body) => createMessage(body, { stage: 'generate' }),
    retries = 2,
    sections = DEFAULT_SECTIONS,
    effort = getEditionEffort(),
    sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: GenerateBatchOptions,
): Promise<GenerateParse> {
  const { system, user } = buildGeneratePrompt(profileText, reps, sections);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepFn(attempt * RETRY_BASE_MS);
    try {
      const response = await createMessageFn({
        model: getGenerateModel(),
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { effort },
      });
      const parsed = parseGeneratedDetailed(messageText(response), reps, sections);
      if (parsed.generated.size === 0) {
        throw new Error(`生成結果が0件（応答の形式が想定と異なる可能性）: ${messageText(response).slice(0, 160)}`);
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (!isRetryableAnthropicError(err)) throw err;
      if (attempt < retries) {
        console.warn(
          `[Digest:generate] 生成に失敗、${(attempt + 1) * (RETRY_BASE_MS / 1000)}秒後に再試行`
          + ` (${attempt + 1}/${retries}): ${String((err as Error).message ?? err).slice(0, 160)}`,
        );
      }
    }
  }
  throw lastErr;
}
