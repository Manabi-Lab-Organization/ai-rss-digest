
import {
  createMessage,
  messageText,
  getGenerateModel,
  type AnthropicEffort,
  type AnthropicMessageBody,
  type CreateMessageFn,
} from './anthropicClient.js';
import { DEFAULT_SECTIONS } from './generate.js';
import type { EditionContent } from './editionBuilder.js';

export function getPodcastScriptModel(): string {
  return process.env.DIGEST_PODCAST_SCRIPT_MODEL || getGenerateModel();
}

export function getPodcastScriptEffort(): AnthropicEffort {
  const v = process.env.DIGEST_PODCAST_SCRIPT_EFFORT;
  return v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max' ? v : 'medium';
}

const MAX_TOKENS = 16000;
const RETRY_BASE_MS = 10_000;
const SECTION_RETRIES = 2;
const CONTENT_RETRIES = 1;

export const SPEAKERS = { A: 'ナビゲーター', B: 'コメンテーター' } as const;

export const CHARS_PER_MINUTE = 300;
const MINUTES_PER_ARTICLE = 1.5;
const MIN_TARGET_MINUTES = 3;
const MAX_TARGET_MINUTES = 30;

export interface ScriptSegment {
  speaker: 'A' | 'B';
  text: string;
  article?: number;
}

export function targetMinutesFor(articleCount: number): number {
  const minutes = Math.max(1, articleCount) * MINUTES_PER_ARTICLE;
  return Math.min(MAX_TARGET_MINUTES, Math.max(MIN_TARGET_MINUTES, Math.round(minutes)));
}

export function charsPerArticle(articleCount: number, targetMinutes = targetMinutesFor(articleCount)): number {
  const total = targetMinutes * CHARS_PER_MINUTE - 600;
  return Math.max(500, Math.min(1400, Math.floor(total / Math.max(1, articleCount))));
}

export function articleMaterialChars(a: { lead?: string; body?: string; content?: string | null }): number {
  return (a.lead ?? '').length + (a.body ?? '').length
    + (a.content ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 2000).length;
}

export function scriptCharsFor(materialChars: number, perArticleChars: number): number {
  if (materialChars >= 1500) return perArticleChars;
  if (materialChars >= 800) return Math.min(perArticleChars, 800);
  if (materialChars >= 400) return Math.min(perArticleChars, 500);
  return Math.min(perArticleChars, 300);
}

export interface PodcastArticle {
  headline: string;
  lead: string;
  body: string;
  sourceTitle: string | null;
  content?: string | null;
}

export interface PodcastSection {
  name: string;
  articles: PodcastArticle[];
}

export function computeEmptySections(content: Pick<EditionContent, 'format' | 'sections'>): string[] {
  if (content.format !== 'paper') return [];
  const present = new Set(content.sections.map((s) => s.name));
  return DEFAULT_SECTIONS.filter((s) => s !== 'その他' && !present.has(s));
}

const MONTH_YOMI = [
  'いちがつ', 'にがつ', 'さんがつ', 'しがつ', 'ごがつ', 'ろくがつ',
  'しちがつ', 'はちがつ', 'くがつ', 'じゅうがつ', 'じゅういちがつ', 'じゅうにがつ',
];

const DAY_YOMI = [
  'ついたち', 'ふつか', 'みっか', 'よっか', 'いつか', 'むいか', 'なのか', 'ようか', 'ここのか', 'とおか',
  'じゅういちにち', 'じゅうににち', 'じゅうさんにち', 'じゅうよっか', 'じゅうごにち',
  'じゅうろくにち', 'じゅうしちにち', 'じゅうはちにち', 'じゅうくにち', 'はつか',
  'にじゅういちにち', 'にじゅうににち', 'にじゅうさんにち', 'にじゅうよっか', 'にじゅうごにち',
  'にじゅうろくにち', 'にじゅうしちにち', 'にじゅうはちにち', 'にじゅうくにち',
  'さんじゅうにち', 'さんじゅういちにち',
];

export function spokenDate(month: number, day: number): string {
  const m = MONTH_YOMI[month - 1];
  const d = DAY_YOMI[day - 1];
  return m && d ? `${m}${d}` : `${month}月${day}日`;
}

export function spokenProgramName(editionDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(editionDate.trim());
  if (!m) return 'エーアイ アールエスエス ダイジェストのポッドキャスト';
  return `エーアイ アールエスエス ダイジェスト、${spokenDate(Number(m[2]), Number(m[3]))}のポッドキャスト`;
}

export interface OpeningInput {
  editionDate: string;
  sections: string[];
  articleCount: number;
  emptySections?: string[];
}

export function buildOpening({
  editionDate, sections, articleCount, emptySections = [],
}: OpeningInput): ScriptSegment[] {
  const empty = emptySections.length > 0
    ? `なお、${emptySections.join('、')}は、掲載基準を満たす記事がありませんでした。`
    : '';
  return [
    {
      speaker: 'A',
      text: `${spokenProgramName(editionDate)}です。`
        + `本日は${sections.join('、')}の各面から、あわせて${articleCount}本の記事をお届けします。${empty}`,
    },
    { speaker: 'B', text: 'よろしくお願いします。さっそく見ていきましょう。' },
  ];
}

export const OTHER_OUTLETS = [
  '日経', '日本経済新聞', '朝日新聞', '読売新聞', '毎日新聞', '産経新聞', '東京新聞',
  'NHK', 'ロイター', 'ブルームバーグ', '共同通信', '時事通信', '東洋経済', 'ダイヤモンド',
] as const;

export interface SectionPromptInput {
  editionTitle: string;
  section: string;
  articles: PodcastArticle[];
  perArticleChars: number;
  isFirst: boolean;
  isLast: boolean;
  emptySections?: string[];
}

export function buildSectionScriptPrompt(profileText: string, {
  editionTitle, section, articles, perArticleChars, isFirst, isLast, emptySections = [],
}: SectionPromptInput): { system: string; user: string } {
  const system = [
    'あなたは経済ニュース解説ポッドキャストの放送作家です。',
    `2人の話者A（${SPEAKERS.A}）とB（${SPEAKERS.B}）による対話台本の一部を書いてください。`,
    '',
    '<editorial_profile>',
    profileText.trim(),
    '</editorial_profile>',
    '',
    '番組の水準（厳守）:',
    '- 経済紙の紙面を音声にしたような番組。事実（誰が・何を・数字・日付）を正確に伝えた上で、背景と業界への意味を深掘りする',
    '- 各記事は「Aが事実を提示 → Bが背景・文脈を解説 → 影響や論点を対話で掘る」の流れ。表面をなぞらず、提供された本文の具体的情報を使い切る',
    '- 数字・企業名・製品名は台本に必ず織り込む。憶測での断定はせず、「〜とみられる」等で区別する',
    '- 「元記事の内容」はWebページからの機械抽出のため、広告・アクセスランキング・関連記事の見出し・'
      + '他競技の結果など、その記事の本文と無関係な断片が混ざることがある。見出し・リードと関係のない'
      + '話題の断片は事実として扱わず、台本には一語も使わないこと',
    '- 各記事の対話の長さは、記事ごとに「台本の分量」として指定する。その範囲で話すこと。',
    '  指定より長くしてはならない。素材にあることだけで指定に届かない場合は、短いままでよい',
    '- 話し言葉。フィラー（えー、あのー）は入れない。わざとらしい相槌の連発もしない',
    '- 1発言は80〜200字を目安にする（分量の指定が短い記事では、それに合わせて発言数を減らす）',
    '',
    '正確さの原則（他の指示に優先する）:',
    '- 紙面の本文・元記事に書かれていない事実を、あなたの知識から足してはならない。',
    '  尺を満たすための埋め合わせも禁止。素材の範囲で話せる分だけ話す',
    '- 人物の肩書・役職・所属は、その記事が報じている出来事の一部である場合のみ言う。',
    '  筆者・発言者が何者かを紹介するために肩書を付けてはならない（素材にあっても付けない）。',
    '  肩書は辞任・異動で変わるため、報道の対象でない肩書は古い情報になりやすい。氏名だけを言う',
    '- 「国内で初めて」「首位」「他に例のない」のような位置づけの断定は、素材にその記述がある場合のみ',
    '- 数値・日付は素材の精度のまま言う。素材に無い数値・日付・年を補ってはならない',
    isFirst
      ? `- 番組の挨拶と全体像はこの直前で紹介済み。挨拶はせず、「まずは${section}からです」のように入る`
      : `- 冒頭の挨拶は不要。「続いては${section}です」のような自然なセクション転換から始める`,
    isLast
      ? '- 最後: Bが今日全体を貫く一言の視点を述べ、Aが「詳しくは本紙で」と本紙へ誘導して締める。'
        + '別れの挨拶（「それでは」「また次回」「お会いしましょう」「失礼します」等）は絶対に書かないこと。'
        + '番組の仕組みが最後に自動で付けるため、台本に書くと締めが二重になる'
      : '- このセクションの最後の記事を語り終えたら、そのまま終える。「続いては◯◯」のような次セクションの'
        + '予告はしない（転換は次のセクション側の冒頭が行う。誤った面名や、記事のない面を読み上げないため）',
    '',
    '',
    '記事の順番（厳守）:',
    '- 記事は提示された順（[1] → [2] → …）に扱う。面白い順・関連順に入れ替えてはならない。',
    '  紙面の掲載順と番組の紹介順が食い違うと、聞きながら紙面を追えなくなる',
    '- 提示された記事はすべて扱う。素材が薄い記事も、短くてよいので飛ばさない',
    '- 各発言には、その発言が扱っている記事の番号を article として付ける',
    '  （セクションの導入や転換の一言は article: 0）',
    '',
    '出力は次の形式のJSON配列のみ（説明文・コードフェンス不要）:',
    '[{"speaker": "A", "article": 1, "text": "..."}, {"speaker": "B", "article": 1, "text": "..."}, ...]',
  ].join('\n');

  const user = [
    `「${editionTitle}」のセクション「${section}」の記事:`,
    '',
    ...articles.map((r, i) => [
      `[${i + 1}] 見出し: ${r.headline}`,
      `リード: ${r.lead ?? ''}`,
      `紙面本文: ${r.body ?? ''}`,
      `出典: ${r.sourceTitle ?? ''}`,
      `元記事の内容: ${(r.content ?? '').replace(/<[^>]+>/g, ' ').trim().slice(0, 2000) || '(なし)'}`,
      `台本の分量: 約${scriptCharsFor(articleMaterialChars(r), perArticleChars)}字まで`,
    ].join('\n')),
  ].join('\n\n');

  return { system, user };
}

export function parseScript(text: string): ScriptSegment[] {
  const start = text.indexOf('[');
  if (start < 0) throw new Error(`JSON配列が見つかりません: ${text.slice(0, 120)}`);
  let end = text.lastIndexOf(']');
  let body: string;
  if (end > start) {
    body = text.slice(start, end + 1);
  } else {
    end = text.lastIndexOf('}');
    if (end <= start) throw new Error('JSON配列が閉じておらず救済もできません');
    body = `${text.slice(start, end + 1)}]`;
  }
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('応答がJSON配列ではありません');
  const segments = (parsed as Array<{ speaker?: unknown; text?: unknown; article?: unknown }>)
    .filter((s) => s && (s.speaker === 'A' || s.speaker === 'B') && s.text)
    .map((s) => {
      const n = Number(s.article);
      const seg: ScriptSegment = { speaker: s.speaker as 'A' | 'B', text: String(s.text).trim() };
      if (Number.isInteger(n) && n >= 1) seg.article = n;
      return seg;
    });
  if (segments.length === 0) {
    throw new Error(`セグメントが0件（応答の形式が想定と異なる可能性）: ${text.slice(0, 160)}`);
  }
  return segments;
}

function carriedArticleKeys(segments: ScriptSegment[], articleCount: number): number[] {
  let carry = 0;
  return segments.map((s) => {
    if (typeof s.article === 'number' && s.article >= 1 && s.article <= articleCount) carry = s.article;
    return carry;
  });
}

export function orderSegments(segments: ScriptSegment[], articleCount: number): ScriptSegment[] {
  const keys = carriedArticleKeys(segments, articleCount);
  return segments
    .map((seg, i) => ({ seg, key: keys[i], i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.seg);
}

export function isInArticleOrder(segments: ScriptSegment[], articleCount: number): boolean {
  const keys = carriedArticleKeys(segments, articleCount);
  return keys.every((k, i) => i === 0 || k >= keys[i - 1]);
}

export function missingArticles(segments: ScriptSegment[], articleCount: number): number[] {
  const seen = new Set(carriedArticleKeys(segments, articleCount));
  const missing: number[] = [];
  for (let n = 1; n <= articleCount; n++) if (!seen.has(n)) missing.push(n);
  return missing;
}

export function stripArticleLabels(segments: ScriptSegment[]): ScriptSegment[] {
  return segments.map(({ speaker, text }) => ({ speaker, text }));
}

export interface GenerateScriptOptions {
  profileText: string;
  createMessageFn?: CreateMessageFn;
  onProgress?: (done: number, total: number) => void;
  retries?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

async function callForSegments(
  { system, user }: { system: string; user: string },
  createMessageFn: CreateMessageFn,
  { retries, label, sleepFn, validate }: {
    retries: number;
    label: string;
    sleepFn: (ms: number) => Promise<void>;
    validate?: (segments: ScriptSegment[]) => string | null;
  },
): Promise<ScriptSegment[]> {
  let lastErr: unknown;
  let usable: ScriptSegment[] | null = null;
  let contentRetries = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepFn(attempt * RETRY_BASE_MS);
    try {
      const response = await createMessageFn({
        model: getPodcastScriptModel(),
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: getPodcastScriptEffort() },
      });
      const segments = parseScript(messageText(response));
      const complaint = validate?.(segments) ?? null;
      if (!complaint) return segments;
      usable = segments;
      lastErr = new Error(complaint);
      contentRetries++;
      if (contentRetries > CONTENT_RETRIES) break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) {
      console.warn(
        `[Digest:podcast] ${label}の生成に失敗、再試行 (${attempt + 1}/${retries}): `
        + String((lastErr as Error).message ?? lastErr).slice(0, 160),
      );
    }
  }
  if (usable) {
    console.warn(
      `[Digest:podcast] ${label}: 作り直しても解消しないため、そのまま採用します: `
      + String((lastErr as Error).message ?? lastErr).slice(0, 160),
    );
    return usable;
  }
  throw lastErr ?? new Error(`${label}の生成に失敗しました`);
}

export async function generateScript(
  sections: PodcastSection[],
  { editionTitle, editionDate, emptySections = [] }:
    { editionTitle: string; editionDate: string; emptySections?: string[] },
  {
    profileText,
    createMessageFn = (body: AnthropicMessageBody) => createMessage(body, { stage: 'podcast-script' }),
    onProgress,
    retries = SECTION_RETRIES,
    sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: GenerateScriptOptions,
): Promise<ScriptSegment[]> {
  const withArticles = sections.filter((s) => s.articles.length > 0);
  if (withArticles.length === 0) throw new Error('台本にする記事がありません');
  const articleCount = withArticles.reduce((n, s) => n + s.articles.length, 0);
  const perArticleChars = charsPerArticle(articleCount);

  const segments: ScriptSegment[] = buildOpening({
    editionDate, sections: withArticles.map((s) => s.name), articleCount, emptySections,
  });

  for (let i = 0; i < withArticles.length; i++) {
    const prompt = buildSectionScriptPrompt(profileText, {
      editionTitle,
      emptySections,
      section: withArticles[i].name,
      articles: withArticles[i].articles,
      perArticleChars,
      isFirst: i === 0,
      isLast: i === withArticles.length - 1,
    });
    const name = withArticles[i].name;
    const count = withArticles[i].articles.length;
    const raw = await callForSegments(prompt, createMessageFn, {
      retries,
      label: `セクション「${name}」`,
      sleepFn,
      validate: (segs) => {
        if (!segs.some((x) => typeof x.article === 'number')) {
          return `各発言に記事番号（article）が付いていません（全${count}本）`;
        }
        const missing = missingArticles(segs, count);
        return missing.length === 0
          ? null
          : `紙面の記事が台本で扱われていません（[${missing.join('][')}]／全${count}本）`;
      },
    });
    const ordered = orderSegments(raw, count);
    if (!isInArticleOrder(raw, count)) {
      console.warn(`[Digest:podcast] 「${name}」の台本が紙面の掲載順と違ったため並べ替えました`);
    }
    const missing = missingArticles(ordered, count);
    if (missing.length > 0) {
      console.warn(`[Digest:podcast] 「${name}」で台本に載らなかった記事: [${missing.join('][')}]／全${count}本`);
    }
    segments.push(...ordered);
    onProgress?.(i + 1, withArticles.length);
  }
  return stripArticleLabels(segments);
}

export function scriptStats(segments: ScriptSegment[]): { chars: number; estimatedMinutes: number } {
  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  return { chars, estimatedMinutes: Math.round(chars / CHARS_PER_MINUTE) };
}
