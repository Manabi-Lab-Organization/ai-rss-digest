
import {
  createMessage,
  messageText,
  getTriageModel,
  type CreateMessageFn,
} from './anthropicClient.js';
import { tierLabel, normalizeTier } from './feedTier.js';

export const BATCH_SIZE = 20;
const MAX_SUMMARY_CHARS = 300;
const MAX_TOKENS = 2000;

export interface TriageArticle {
  id: string;
  title: string | null;
  summaryRaw: string | null;
  feedTitle?: string | null;
  feedTier?: string | null;
  sourceSite?: string | null;
}

export function sourceLine(a: { feedTitle?: string | null; feedTier?: string | null; sourceSite?: string | null }): string {
  const name = (a.feedTitle ?? '').trim() || '(不明)';
  const site = a.sourceSite ? `（サイト: ${a.sourceSite}）` : '';
  const tier = normalizeTier(a.feedTier) === 'primary' ? `［${tierLabel('primary')}］` : '';
  return `${name}${site}${tier}`;
}

export interface TriagePrompt {
  system: string;
  user: string;
}

export function buildTriagePrompt(profileText: string, articles: TriageArticle[]): TriagePrompt {
  const system = [
    'あなたは日刊の総合ダイジェスト紙「AI RSS Digest」の編集部で一次トリアージを担当する編集者です。',
    '以下の編集方針プロファイルに基づき、各記事の関連度を1〜5の整数で採点してください。',
    '',
    '<editorial_profile>',
    profileText.trim(),
    '</editorial_profile>',
    '',
    '採点基準:',
    '5: 重みの高い関心領域の新しいファクト（公式発表・数字・提携・研究結果）で、信頼できる情報源',
    '4: 関心領域に合致する新しい事実、または論文級の新視点・フレームワークを持つ論考',
    '3: 関心領域に関連する事実だが、重要度・新規性が中程度',
    '2: 関連は薄い、既知の内容の再解説、またはUGC（記事投稿サービス・個人ブログなど）の一般的な記事',
    '1: 関心領域と無関係、抽象的な意見・感想・入門解説',
    '',
    '重要: プロファイルの「情報源の信頼度ティア」「新規性の要件」「既知性の軸」を必ず適用してください。',
    '出典がUGCの場合、独自データ・一次情報が明示されていない限り3点以上を付けてはいけません。',
    '媒体の名前や知名度で点を上げ下げしないでください。判断の材料は記事の中身と、次の2点です。',
    '- 一次情報: 出典に「一次情報」とある記事、または出典のサイトが記事で発表・決定をした当事者（企業・団体・機関）自身のものなら、',
    '  当事者による発表として扱ってよい。',
    '- 既知性: 同じ出来事を多くの情報源がすでに報じていて、新しい事実（数字・決定・発表の中身）が無い記事は低く。',
    '  報じる情報源が少なくても重要な事実を含む記事は高く。',
    '',
    '入力はタイトル・要約・出典（サイト名と、分かる場合は種別）です。要約が空の場合はタイトルから判断してください。',
    '出力は次の形式のJSON配列のみを返してください（説明文・コードフェンスは不要）:',
    '[{"id": 番号, "score": 3}, ...]',
    '「番号」は一覧の [ ] の中の数字です。必ず入力された全記事の番号を1回ずつ含めてください。',
  ].join('\n');

  const user = [
    `以下の${articles.length}件の記事を採点してください。`,
    '',
    ...articles.map((a, i) =>
      [
        `[${i + 1}]`,
        `タイトル: ${(a.title ?? '').trim() || '(なし)'}`,
        `出典: ${sourceLine(a)}`,
        `要約: ${(a.summaryRaw ?? '').trim().slice(0, MAX_SUMMARY_CHARS) || '(なし)'}`,
      ].join('\n'),
    ),
  ].join('\n\n');

  return { system, user };
}

export function firstBalancedArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

interface TriageScoreRow {
  id?: unknown;
  score?: unknown;
}

export function parseTriageScores(text: string, articles: TriageArticle[]): Map<string, number> {
  return parseTriageScoresDetailed(text, articles).scores;
}

export interface TriageParse {
  scores: Map<string, number>;
  missing: string[];
  unknown: string[];
  duplicated: string[];
}

export function parseTriageScoresDetailed(text: string, articles: TriageArticle[]): TriageParse {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`JSON配列が見つかりません: ${text.slice(0, 120)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    const balanced = firstBalancedArray(text);
    if (!balanced) throw new Error(`JSON配列を復元できません: ${text.slice(0, 120)}`);
    parsed = JSON.parse(balanced);
  }
  if (!Array.isArray(parsed)) throw new Error('応答がJSON配列ではありません');

  const known = new Set(articles.map((a) => a.id));
  const toId = (v: unknown): string | undefined => {
    const raw = String(v).trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= 1 && n <= articles.length) return articles[n - 1].id;
    }
    return known.has(raw) ? raw : undefined;
  };
  const scores = new Map<string, number>();
  const unknown: string[] = [];
  const duplicated = new Set<string>();
  for (const row of parsed as TriageScoreRow[]) {
    if (!row) continue;
    const id = toId(row.id);
    if (id === undefined) {
      unknown.push(String(row.id));
      continue;
    }
    const n = Math.round(Number(row.score));
    if (!Number.isFinite(n)) continue;
    if (scores.has(id)) {
      duplicated.add(id);
      continue;
    }
    scores.set(id, Math.min(5, Math.max(1, n)));
  }
  const missing = articles.map((a) => a.id).filter((id) => !scores.has(id));
  return { scores, missing, unknown, duplicated: [...duplicated] };
}

export function applyFeedWeight(score: number, _weight = 1.0): number {
  return score;
}

export async function triageBatch(
  articles: TriageArticle[],
  {
    profileText,
    createMessageFn = (body) => createMessage(body, { stage: 'triage' }),
    logFn = (l) => console.log(l),
  }: { profileText: string; createMessageFn?: CreateMessageFn; logFn?: (line: string) => void },
): Promise<Map<string, number>> {
  const ask = async (list: TriageArticle[]) => {
    const { system, user } = buildTriagePrompt(profileText, list);
    const response = await createMessageFn({
      model: getTriageModel(),
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = messageText(response);
    return { text, parsed: parseTriageScoresDetailed(text, list) };
  };

  const first = await ask(articles);
  const scores = first.parsed.scores;
  if (scores.size === 0) {
    throw new Error(`採点結果が0件（応答の形式が想定と異なる可能性）: ${first.text.slice(0, 160)}`);
  }

  const { missing, unknown, duplicated } = first.parsed;
  if (missing.length > 0 || unknown.length > 0 || duplicated.length > 0) {
    let recovered = 0;
    let retryNote = '';
    if (missing.length > 0) {
      const rest = articles.filter((a) => missing.includes(a.id));
      try {
        const again = await ask(rest);
        for (const [id, sc] of again.parsed.scores) {
          scores.set(id, sc);
          recovered++;
        }
      } catch (err) {
        retryNote = `（やり直し失敗: ${String((err as Error).message ?? err).slice(0, 60)}）`;
      }
    }
    logFn(formatTriageGaps({ total: articles.length, missing: missing.length, recovered, unknown, duplicated }) + retryNote);
  }
  return scores;
}

export function formatTriageGaps({ total, missing, recovered, unknown, duplicated }: {
  total: number; missing: number; recovered: number; unknown: string[]; duplicated: string[];
}): string {
  const parts = [`[Digest:edition]   採点の取りこぼし（${total}件中）: 答えに無かった${missing}件`];
  if (missing > 0) parts.push(`→ もう1回聞いて${recovered}件採点`);
  if (unknown.length > 0) parts.push(`/ 一覧に無い番号: ${unknown.slice(0, 5).join(', ')}`);
  if (duplicated.length > 0) parts.push(`/ 2回答えた記事${duplicated.length}件（最初の点数を使用）`);
  return parts.join(' ');
}
