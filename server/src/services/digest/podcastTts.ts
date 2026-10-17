
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScriptSegment } from './podcastScript.js';

export function getTtsModel(): string {
  return process.env.DIGEST_TTS_MODEL || 'gemini-3.8-flash-tts';
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const CHUNK_CHARS = 450;
export const RATE = 24000;
const BYTES_PER_SEC = RATE * 2;

export interface VoicePair {
  A: string;
  B: string;
}

export const STYLE_PROMPT = [
  '次の日本語のセリフを、日本のビジネス系ラジオ番組の出演者のように、落ち着いた知的なトーンで読み上げてください。',
  '書かれているセリフだけを読み、台本に無い言葉（挨拶・相槌・繰り返しなど）を付け加えないでください。',
].join('');

export function voiceMap(): VoicePair {
  return {
    A: process.env.DIGEST_PODCAST_VOICE_A || 'Kore',
    B: process.env.DIGEST_PODCAST_VOICE_B || 'Charon',
  };
}

const END_UTTERANCE: ScriptSegment = {
  speaker: 'A',
  text: 'それでは、また次回お会いしましょう。 。。。失礼いたします。',
};
const SENTINEL_MAX_SEC = 1.6;
const GAP_MIN_MS = 160;
const SENTINEL_MARGIN_MS = 40;
const END_FADE_SEC = 0.05;
const END_SILENCE_SEC = 0.8;
const SILENCE_THRESH = 200;
const WIN_MS = 20;

const LEAD_KEEP_SEC = 0.08;
const TAIL_KEEP_SEC = 0.22;

const FAREWELL_RE = /(それでは.{0,12}(また|次回|失礼)|また次回|次回お会い|お会いしましょう|それではまた|次回もお楽しみ|お楽しみに$|失礼(いた)?します)/;
export function stripTrailingFarewell(text: string): string {
  const sentences = String(text).split(/(?<=[。！？])/).filter((s) => s.trim());
  while (sentences.length) {
    const tail = sentences[sentences.length - 1].replace(/[「」『』、\s]/g, '');
    if (tail.length <= 40 && FAREWELL_RE.test(tail)) sentences.pop();
    else break;
  }
  return sentences.join('').trim();
}

const AMBIGUOUS_MONTHS: Array<[RegExp, string]> = [
  [/(?<![0-9０-９])4月(?!曜)/g, 'しがつ'],
  [/(?<![0-9０-９])7月(?!曜)/g, 'しちがつ'],
  [/(?<![0-9０-９])9月(?!曜)/g, 'くがつ'],
];

export function cleanForTts(text: string): string {
  let t = String(text);
  for (const ch of ['“', '”', '„', '‟', '「', '」', '『', '』', '"', '＂']) t = t.split(ch).join('');
  t = t.replaceAll('…', '、').replaceAll('⋯', '、').replaceAll('—', '、').replaceAll('――', '、');
  t = t.split('・').join('');
  for (const [re, yomi] of AMBIGUOUS_MONTHS) t = t.replace(re, yomi);
  return t.replace(/[ \t]+/g, ' ').trim();
}

export function mergeAdjacentSpeakers(
  segments: ScriptSegment[],
  maxChars: number = CHUNK_CHARS,
): ScriptSegment[] {
  const out: ScriptSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && last.text.length + s.text.length + 1 <= maxChars) {
      last.text = `${last.text} ${s.text}`.trim();
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function buildUtteranceRequest(
  segment: ScriptSegment,
  { voices = voiceMap() }: { voices?: VoicePair } = {},
): object {
  return {
    contents: [{ parts: [{ text: `${STYLE_PROMPT}\n\n${cleanForTts(segment.text)}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[segment.speaker] } },
      },
    },
  };
}

export function usesInteractionsApi(model: string): boolean {
  return /^gemini-3\./.test(model);
}

export function buildInteractionsRequest(
  segment: ScriptSegment,
  { voices = voiceMap() }: { voices?: VoicePair } = {},
): object {
  return {
    model: getTtsModel(),
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text: cleanForTts(segment.text),
        annotations: [{ type: 'speech_metadata', style: STYLE_PROMPT }],
      }],
    }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: voices[segment.speaker] }] },
  };
}

export function extractInteractionsAudio(json: unknown): string {
  const root = (json ?? {}) as Record<string, any>;
  const direct = root.output_audio?.data ?? root.outputAudio?.data;
  if (typeof direct === 'string' && direct) return direct;
  const steps: any[] = Array.isArray(root.steps) ? root.steps : [];
  for (const step of steps) {
    const contents: any[] = Array.isArray(step?.content) ? step.content : [];
    for (const c of contents) {
      if (c?.type !== 'audio') continue;
      const d = c.data ?? c.audio?.data ?? c.inline_data?.data ?? c.inlineData?.data;
      if (typeof d === 'string' && d) return d;
    }
  }
  throw new Error(`応答に音声データがありません（観測したキー: ${Object.keys(root).join(', ') || 'なし'}）`);
}

export function pcmFromWav(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'data') return buf.subarray(body, Math.min(buf.length, body + size));
    pos = body + size + (size % 2);
  }
  return buf.subarray(Math.min(44, buf.length));
}

const RISKY_TITLES = [
  '首相', '総理', '大統領', '官房長官', '長官', '大臣', '知事', '市長',
  '社長', '会長', '頭取', '総裁', '党首', 'CEO',
] as const;

const TITLE_PREFIXES = ['前', '元', '次期', '現', '新', '副'] as const;

const TITLED_NAME_RE = new RegExp(
  `([\\u4e00-\\u9fff]{2,6}?|[\\u30a1-\\u30f6\\u30fc]{2,12}|[A-Za-z]{2,15})`
  + `((?:${TITLE_PREFIXES.join('|')})?(?:${RISKY_TITLES.join('|')}))`,
  'g',
);

const NOT_A_NAME = new Set([
  '上級', '筆頭', '首席', '代表', '代表取締役', '取締役', '最高',
  '同社', '同国', '同省', '同庁', '同市', '同県', '同党', '同行', '同局',
  '両社', '両国', '各社', '当社', '前任', '後任', '歴代', '初代', '現職',
]);

const ROLE_PARTS = [
  '創業', '共同', '執行', '責任', '取締', '役員', '会長', '社長', '理事', '担当',
  '産業', '経済', '外務', '財務', '総務', '法務', '防衛', '環境', '厚生', '労働', '文部', '科学',
  '農林', '水産', '国土', '交通', '復興', '内閣', '官房', '国務', '特命', '再生', '安全保障', '国家',
  '司法', '国防', '商務', '運輸', '内務', '保健', '教育', '農務', '住宅', '退役軍人', '国土安全', '通商',
];

function isNotAName(name: string): boolean {
  if (NOT_A_NAME.has(name)) return true;
  if (ROLE_PARTS.some((p) => name.includes(p))) return true;
  return name.length > 1 && name.endsWith('兼');
}

export interface TitledName {
  name: string;
  title: string;
}

const DEPARTMENT_TITLES = new Set(['長官', '大臣']);

function isDepartmentBeforeTitle(text: string, index: number, kanjiName: string, title: string): boolean {
  if (!/^[\u4e00-\u9fff]+$/.test(kanjiName) || !DEPARTMENT_TITLES.has(title.replace(/^(?:前|元|次期|現|新|副)/, ''))) return false;
  const before = text.slice(Math.max(0, index - 1), index);
  return /[\u30a1-\u30f6\u30fcA-Za-z]/.test(before);
}

export function extractTitledNames(text: string): TitledName[] {
  const out: TitledName[] = [];
  const seen = new Set<string>();
  const src = String(text);
  for (const m of src.matchAll(TITLED_NAME_RE)) {
    if (isNotAName(m[1])) continue;
    if (isDepartmentBeforeTitle(src, m.index ?? 0, m[1], m[2])) continue;
    const key = `${m[1]}${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: m[1], title: m[2] });
  }
  return out;
}

export function normalizeKana(text: string): string {
  return String(text)
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\sー・、。，．,.!！?？「」『』（）()]/g, '');
}

const KATAKANA_ONLY = /^[\u30a1-\u30f6\u30fc]+$/;

export function readingOfName(name: string, readings: Map<string, string>): string | undefined {
  if (KATAKANA_ONLY.test(name)) return normalizeKana(name);
  const r = normalizeKana(readings.get(name) ?? '');
  return r || undefined;
}

export function familyReadingOf(name: string, readings: Map<string, string>): string | undefined {
  if (KATAKANA_ONLY.test(name)) return undefined;
  const parts = String(readings.get(name) ?? '').trim().split(/[\s　]+/);
  if (parts.length < 2) return undefined;
  const family = normalizeKana(parts[0]);
  return family.length >= 2 ? family : undefined;
}

export function findMisreadByReading(
  names: TitledName[],
  readings: Map<string, string>,
  transcript: string,
): { misread: TitledName[]; unresolved: TitledName[] } {
  const heard = normalizeKana(transcript);
  const misread: TitledName[] = [];
  const unresolved: TitledName[] = [];
  for (const n of names) {
    const r = readingOfName(n.name, readings);
    if (!r) {
      unresolved.push(n);
      continue;
    }
    const family = familyReadingOf(n.name, readings);
    if (!heard.includes(r) && !(family && heard.includes(family))) misread.push(n);
  }
  return { misread, unresolved };
}

export type TtsFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

interface TtsChunkOptions {
  apiKey?: string;
  fetchFn?: TtsFetchLike;
  voices?: VoicePair;
  attempts?: number;
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string } }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export interface TtsUsage {
  promptTokens: number;
  audioTokens: number;
}

interface TtsChunkResult {
  pcm: Buffer;
  usage: TtsUsage;
  usageMissingKeys?: string[];
}

async function ttsUtteranceOnce(segment: ScriptSegment, { apiKey, fetchFn = fetch as unknown as TtsFetchLike, voices }: TtsChunkOptions): Promise<TtsChunkResult> {
  const interactions = usesInteractionsApi(getTtsModel());
  const url = interactions
    ? `${API_BASE}/interactions`
    : `${API_BASE}/models/${getTtsModel()}:generateContent?key=${apiKey}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(interactions ? { 'x-goog-api-key': String(apiKey ?? '') } : {}),
    },
    body: JSON.stringify(
      interactions
        ? buildInteractionsRequest(segment, { voices })
        : buildUtteranceRequest(segment, { voices }),
    ),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Gemini TTS HTTP ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as GeminiTtsResponse & Record<string, any>;
  if (interactions) {
    const promptTokens = json.usage?.input_tokens ?? json.usage?.total_input_tokens
      ?? json.usageMetadata?.promptTokenCount ?? 0;
    const audioTokens = json.usage?.output_tokens ?? json.usage?.total_output_tokens
      ?? json.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      pcm: pcmFromWav(Buffer.from(extractInteractionsAudio(json), 'base64')),
      usage: { promptTokens, audioTokens },
      ...(promptTokens === 0 && audioTokens === 0 ? { usageMissingKeys: Object.keys(json) } : {}),
    };
  }
  const data = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) throw new Error('応答に音声データがありません');
  return {
    pcm: Buffer.from(data, 'base64'),
    usage: {
      promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
      audioTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function readingCheckModel(): string {
  return process.env.DIGEST_TTS_CHECK_MODEL || 'gemini-3.1-flash-lite';
}

export interface ReadingCheckResult {
  target: boolean;
  checked: boolean;
  misread: TitledName[];
  unresolved?: number;
  error?: string;
  heard?: string;
}

export interface NameReadingLookup {
  asked: string[];
  readings: Map<string, string>;
  missing: string[];
  error?: string;
}

export async function lookupNameReadings(
  names: string[],
  { apiKey, fetchFn = fetch as unknown as TtsFetchLike }: { apiKey?: string; fetchFn?: TtsFetchLike } = {},
): Promise<NameReadingLookup> {
  const asked = [...new Set(names)].filter((n) => !KATAKANA_ONLY.test(n));
  const failed = (error: string): NameReadingLookup => ({ asked, readings: new Map(), missing: asked, error });
  if (asked.length === 0) return { asked, readings: new Map(), missing: [] };
  try {
    const res = await fetchFn(
      `${API_BASE}/models/${readingCheckModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: [
                '次の人名の読みを、ひらがなで答えてください。',
                '姓と名が両方ある名前は、姓と名の間に半角スペースを1つ入れてください（例: "やまだ いちろう"）。',
                '確信が持てない名前は空文字 "" にしてください（推測で埋めないでください）。',
                '出力は {"名前": "よみ", ...} の形のJSONオブジェクトだけにしてください。',
                '',
                ...asked.map((n) => `- ${n}`),
              ].join('\n'),
            }],
          }],
        }),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 100);
      return failed(`HTTP ${res.status} ${detail}`.trim());
    }
    const json = (await res.json()) as any;
    const text: string = json?.candidates?.[0]?.content?.parts?.map((x: any) => x?.text ?? '').join('') ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return failed(`答えの形が崩れた: ${text.replace(/\s+/g, ' ').slice(0, 80) || '（空）'}`);
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch (err) {
      return failed(`答えの形が崩れた: ${String((err as Error).message).slice(0, 80)}`);
    }
    const readings = new Map<string, string>();
    for (const n of asked) {
      const v = typeof obj[n] === 'string' ? String(obj[n]).trim() : '';
      if (v) readings.set(n, v);
    }
    return { asked, readings, missing: asked.filter((n) => !readings.has(n)) };
  } catch (err) {
    return failed(String((err as Error).message || err).slice(0, 100));
  }
}

export function formatNameReadingLog(lookup: NameReadingLookup): { line: string; noneObtained: boolean } | null {
  if (lookup.asked.length === 0) return null;
  const line = `[Digest:tts] 名前の読み: 調べた${lookup.asked.length}件 → 取得${lookup.readings.size}件`
    + (lookup.missing.length > 0 ? ` / 取れず${lookup.missing.length}件（${lookup.missing.join('、')}）` : '')
    + (lookup.error ? ` / 呼び出し失敗（${lookup.error}）` : '');
  return { line, noneObtained: lookup.readings.size === 0 };
}

export async function checkUtteranceReading(
  text: string,
  pcm: Buffer,
  { apiKey, fetchFn = fetch as unknown as TtsFetchLike, readings = new Map<string, string>(), readingsError }:
    { apiKey?: string; fetchFn?: TtsFetchLike; readings?: Map<string, string>; readingsError?: string } = {},
): Promise<ReadingCheckResult> {
  const names = extractTitledNames(text);
  if (names.length === 0) return { target: false, checked: false, misread: [] };
  if (names.every((n) => !readingOfName(n.name, readings))) {
    const why = readingsError ?? `AIが読みを返さなかった: ${names.map((n) => n.name).join('、')}`;
    return { target: true, checked: false, misread: [], unresolved: names.length, error: `読みを取得できませんでした（${why}）` };
  }
  try {
    const res = await fetchFn(
      `${API_BASE}/models/${readingCheckModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'この音声を、すべてひらがなで一字一句書き起こしてください。漢字・カタカナ・アルファベットは使わないでください。書き起こしだけを出力し、説明は書かないでください。' },
              { inlineData: { mimeType: 'audio/wav', data: pcmToWav(pcm).toString('base64') } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120);
      return { target: true, checked: false, misread: [], error: `HTTP ${res.status} ${detail}`.trim() };
    }
    const json = (await res.json()) as any;
    const heard: string = json?.candidates?.[0]?.content?.parts?.map((x: any) => x?.text ?? '').join('') ?? '';
    if (!heard.trim()) return { target: true, checked: false, misread: [], error: '文字起こしが空' };
    const { misread, unresolved } = findMisreadByReading(names, readings, heard);
    return {
      target: true, checked: true, misread, unresolved: unresolved.length,
      ...(misread.length > 0 ? { heard: normalizeKana(heard).slice(0, 120) } : {}),
    };
  } catch (err) {
    return { target: true, checked: false, misread: [], error: String((err as Error).message || err).slice(0, 120) };
  }
}

export function formatMisreadWarning(m: TitledName, readings: Map<string, string>, heard?: string): string {
  const reading = readings.get(m.name) ?? (KATAKANA_ONLY.test(m.name) ? m.name : '（不明）');
  return `[Digest:tts] 読み上げ警告: 台本の「${m.name}${m.title}」が音声で確認できません。`
    + `TTSが知識で別の名前に置き換えた可能性があります（モデル: ${getTtsModel()}）`
    + ` — 探した読み: ${reading} / 書き起こし: ${heard ?? '（なし）'}`;
}

export function summarizeReadingChecks(results: ReadingCheckResult[]): {
  line: string;
  allFailed: boolean;
} {
  const targets = results.filter((r) => r.target);
  const checked = targets.filter((r) => r.checked).length;
  const failed = targets.length - checked;
  const warned = targets.reduce((n, r) => n + r.misread.length, 0);
  const unresolved = targets.reduce((n, r) => n + (r.unresolved ?? 0), 0);
  const firstError = targets.find((r) => r.error)?.error;
  const line = `[Digest:tts] 読み上げ照合: 対象${targets.length}発言 → 照合${checked}件`
    + ` / 警告${warned}件`
    + (unresolved > 0 ? ` / 読み不明の名前${unresolved}件` : '')
    + (failed > 0 ? ` / 照合できず${failed}件（${firstError ?? '理由不明'}）` : '');
  return { line, allFailed: targets.length > 0 && checked === 0 };
}

async function ttsUtterance(segment: ScriptSegment, opts: TtsChunkOptions = {}): Promise<TtsChunkResult> {
  const attempts = opts.attempts ?? 3;
  for (let i = 1; ; i++) {
    try {
      return await ttsUtteranceOnce(segment, opts);
    } catch (err) {
      const msg = String((err as Error).message || err);
      const clientError = /HTTP 4\d\d/.test(msg) && !msg.includes('HTTP 429');
      if (clientError || i >= attempts) throw err;
      console.log(`[Digest:tts] リトライ ${i}/${attempts - 1}: ${msg.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, i * 5000));
    }
  }
}

function peak(pcm: Buffer, start: number, end: number): number {
  let max = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > max) max = v;
  }
  return max;
}

export function trailingSilenceBytes(pcm: Buffer, { thresh = SILENCE_THRESH, winMs = WIN_MS }: { thresh?: number; winMs?: number } = {}): number {
  const win = Math.max(1, Math.floor((RATE * winMs) / 1000)) * 2;
  let pos = pcm.length;
  while (pos > 0) {
    const start = Math.max(0, pos - win);
    if (peak(pcm, start, pos) > thresh) break;
    pos = start;
  }
  return pcm.length - pos;
}

export function leadingSilenceBytes(pcm: Buffer, { thresh = SILENCE_THRESH, winMs = WIN_MS }: { thresh?: number; winMs?: number } = {}): number {
  const win = Math.max(1, Math.floor((RATE * winMs) / 1000)) * 2;
  let pos = 0;
  while (pos < pcm.length) {
    const end = Math.min(pcm.length, pos + win);
    if (peak(pcm, pos, end) > thresh) break;
    pos = end;
  }
  return pos;
}

export function trimForJoin(pcm: Buffer, { isFirst = false }: { isFirst?: boolean } = {}): Buffer {
  const keepLead = Math.floor(RATE * LEAD_KEEP_SEC) * 2;
  const start = isFirst ? 0 : Math.max(0, leadingSilenceBytes(pcm) - keepLead);
  const keepTail = Math.floor(RATE * TAIL_KEEP_SEC) * 2;
  const end = pcm.length - Math.max(0, trailingSilenceBytes(pcm) - keepTail);
  return pcm.subarray(start, Math.max(start, end));
}

export function closeCutBytes(pcm: Buffer, {
  sentinelMaxSec = SENTINEL_MAX_SEC, thresh = SILENCE_THRESH, winMs = WIN_MS,
  gapMinMs = GAP_MIN_MS, marginMs = SENTINEL_MARGIN_MS,
}: { sentinelMaxSec?: number; thresh?: number; winMs?: number; gapMinMs?: number; marginMs?: number } = {}): number {
  const win = Math.max(1, Math.floor((RATE * winMs) / 1000)) * 2;
  const gapMin = Math.floor((RATE * gapMinMs) / 1000) * 2;
  const speechEnd = pcm.length - trailingSilenceBytes(pcm, { thresh, winMs });
  if (speechEnd <= 0) return pcm.length;

  let pos = speechEnd;
  let silentRun = 0;
  let lastRunStart = 0;
  while (pos > 0) {
    const start = Math.max(0, pos - win);
    if (peak(pcm, start, pos) > thresh) {
      silentRun = 0;
      lastRunStart = start;
    } else {
      silentRun += pos - start;
      if (silentRun >= gapMin) break;
    }
    pos = start;
  }
  const lastRunSec = (speechEnd - lastRunStart) / BYTES_PER_SEC;
  if (lastRunStart > 0 && lastRunSec <= sentinelMaxSec) {
    const margin = Math.floor((RATE * marginMs) / 1000) * 2;
    return Math.max(0, lastRunStart - margin);
  }
  return speechEnd;
}

export function finishPcm(pcm: Buffer): Buffer {
  const out = Buffer.from(pcm);
  const fadeSamples = Math.floor(RATE * END_FADE_SEC);
  for (let i = 0; i < fadeSamples; i++) {
    const idx = out.length - (fadeSamples - i) * 2;
    if (idx < 0 || idx + 1 >= out.length) continue;
    const gain = (fadeSamples - i) / fadeSamples;
    out.writeInt16LE(Math.round(out.readInt16LE(idx) * gain), idx);
  }
  return Buffer.concat([out, Buffer.alloc(Math.floor(RATE * END_SILENCE_SEC) * 2)]);
}

export function pcmToWav(pcm: Buffer, rate: number = RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function ffmpegPath(): string | null {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    return execFileSync('which', ['ffmpeg']).toString().trim() || null;
  } catch {
    return null;
  }
}

export function wavToMp3(wav: Buffer): Buffer | null {
  const ff = ffmpegPath();
  if (!ff) {
    console.log('[Digest:tts] ffmpegが見つからないためWAVのまま保存します（Docker のイメージには ffmpeg が入っている。それ以外で動かすときは FFMPEG_PATH か PATH に置く）');
    return null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-tts-'));
  try {
    const wavFile = path.join(tmp, 'in.wav');
    const mp3File = path.join(tmp, 'out.mp3');
    fs.writeFileSync(wavFile, wav);
    execFileSync(ff, ['-y', '-loglevel', 'error', '-i', wavFile, '-codec:a', 'libmp3lame', '-b:a', '64k', mp3File]);
    return fs.readFileSync(mp3File);
  } catch (err) {
    console.error('[Digest:tts] mp3変換に失敗したためWAVのまま保存します:', err);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export interface SynthesizeResult {
  buffer: Buffer;
  ext: 'mp3' | 'wav';
  mimeType: 'audio/mpeg' | 'audio/wav';
  durationSec: number;
  usage: TtsUsage;
}

export interface SynthesizeOptions {
  apiKey?: string;
  fetchFn?: TtsFetchLike;
  voices?: VoicePair;
  onProgress?: (done: number, total: number) => void;
}

export async function synthesizeScript(segments: ScriptSegment[], {
  apiKey = process.env.GEMINI_API_KEY, fetchFn, voices, onProgress,
}: SynthesizeOptions = {}): Promise<SynthesizeResult> {
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません（.env か環境変数で指定）');
  const cleaned = segments.map((s) => ({ ...s }));
  while (cleaned.length) {
    const last = cleaned[cleaned.length - 1];
    const stripped = stripTrailingFarewell(last.text);
    if (stripped === last.text) break;
    if (stripped) { last.text = stripped; break; }
    cleaned.pop();
  }
  const utterances = [...mergeAdjacentSpeakers(cleaned), END_UTTERANCE];

  const totalChars = cleaned.reduce((n, s) => n + s.text.length, 0);
  console.log(`[Digest:tts] 合成開始: ${getTtsModel()} / ${cleaned.length}セグメント / ${totalChars}字 / ${utterances.length}発言`);

  const concurrency = Math.max(1, Number(process.env.DIGEST_TTS_CONCURRENCY || 3));
  const pcms: Buffer[] = new Array(utterances.length);
  const usage: TtsUsage = { promptTokens: 0, audioTokens: 0 };
  const readingChecks: ReadingCheckResult[] = [];
  let usageMissingKeys: string[] | undefined;
  const checkEnabled = process.env.DIGEST_TTS_READING_CHECK !== 'false';
  const lookup: NameReadingLookup = checkEnabled
    ? await lookupNameReadings(utterances.flatMap((u) => extractTitledNames(u.text).map((n) => n.name)), { apiKey, fetchFn })
    : { asked: [], readings: new Map(), missing: [] };
  const readingLog = formatNameReadingLog(lookup);
  if (readingLog) {
    if (readingLog.noneObtained) console.error(readingLog.line);
    else console.log(readingLog.line);
  }
  const readings = lookup.readings;
  let nextIndex = 0;
  let doneCount = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++;
      if (i >= utterances.length) return;
      const result = await ttsUtterance(utterances[i], { apiKey, fetchFn, voices });
      usage.promptTokens += result.usage.promptTokens;
      usage.audioTokens += result.usage.audioTokens;
      usageMissingKeys ??= result.usageMissingKeys;
      let pcm = result.pcm;
      if (i === utterances.length - 1) {
        pcm = pcm.subarray(0, closeCutBytes(pcm));
        pcm = finishPcm(pcm);
      } else {
        pcm = trimForJoin(pcm, { isFirst: i === 0 });
      }
      pcms[i] = pcm;
      if (checkEnabled) {
        const check = await checkUtteranceReading(utterances[i].text, result.pcm, { apiKey, fetchFn, readings, readingsError: lookup.error });
        readingChecks.push(check);
        for (const m of check.misread) console.error(formatMisreadWarning(m, readings, check.heard));
      }
      onProgress?.(++doneCount, utterances.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, utterances.length) }, worker));

  if (readingChecks.length > 0) {
    const { line, allFailed } = summarizeReadingChecks(readingChecks);
    if (allFailed) console.error(`${line} ← 照合が1件も動いていません`);
    else console.log(line);
  }
  if (usageMissingKeys && usage.promptTokens === 0 && usage.audioTokens === 0) {
    console.error(
      `[Digest:tts] 利用量を読み取れませんでした（${getTtsModel()}）。費用が $0 で記録されます。`
      + ` 応答のキー: ${usageMissingKeys.join(', ') || 'なし'}`,
    );
  }

  const pcmAll = Buffer.concat(pcms);
  const durationSec = Math.round(pcmAll.length / BYTES_PER_SEC);
  const wav = pcmToWav(pcmAll);
  const mp3 = wavToMp3(wav);
  return mp3
    ? { buffer: mp3, ext: 'mp3', mimeType: 'audio/mpeg', durationSec, usage }
    : { buffer: wav, ext: 'wav', mimeType: 'audio/wav', durationSec, usage };
}
