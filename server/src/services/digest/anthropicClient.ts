
const API_URL = process.env.DIGEST_ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export function getTriageModel(): string {
  return process.env.DIGEST_TRIAGE_MODEL || 'claude-haiku-4-5-20251001';
}

export function getGenerateModel(): string {
  return process.env.DIGEST_GENERATE_MODEL || 'claude-sonnet-5';
}

const EFFORTS: readonly AnthropicEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function getEditionEffort(): AnthropicEffort {
  const v = process.env.DIGEST_EDITION_EFFORT as AnthropicEffort | undefined;
  return v && EFFORTS.includes(v) ? v : 'medium';
}

export function getDedupeModel(): string {
  return process.env.DIGEST_DEDUPE_MODEL || getTriageModel();
}

export function getPremiumModel(): string {
  return process.env.DIGEST_PREMIUM_MODEL || 'claude-opus-4-8';
}

export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlockParam {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface AnthropicDocumentBlockParam {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
}

export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicImageBlockParam
  | AnthropicDocumentBlockParam;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlockParam[];
}

export interface AnthropicServerTool {
  type: string;
  name: string;
  max_uses?: number;
}

export interface AnthropicMessageBody {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlockParam[];
  messages: AnthropicMessage[];
  tools?: AnthropicServerTool[];
  output_config?: { effort?: AnthropicEffort };
}

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

export interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  usage?: AnthropicUsage;
  stop_reason?: string;
}

export type CreateMessageFn = (body: AnthropicMessageBody) => Promise<AnthropicMessageResponse>;

export function isRetryableAnthropicError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  const m = msg.match(/Anthropic API HTTP (\d{3})/);
  if (!m) return true;
  const status = Number(m[1]);
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CreateMessageOptions {
  apiKey?: string;
  fetchFn?: FetchLike;
  stage?: string;
}

export interface UsageEvent {
  stage: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type UsageSink = (u: UsageEvent) => void;

let usageSink: UsageSink | null = null;

export function setUsageSink(fn: UsageSink | null): void {
  usageSink = fn;
}

export function stripLoneSurrogates<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '',
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(stripLoneSurrogates) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripLoneSurrogates(v)]),
    ) as unknown as T;
  }
  return value;
}

export async function createMessage(
  body: AnthropicMessageBody,
  { apiKey = process.env.ANTHROPIC_API_KEY, fetchFn = fetch, stage = 'unknown' }: CreateMessageOptions = {},
): Promise<AnthropicMessageResponse> {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY が設定されていません（.env か環境変数で指定）');
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(stripLoneSurrogates(body)),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Anthropic API HTTP ${res.status}: ${detail}`);
  }
  const json = (await res.json()) as AnthropicMessageResponse;
  if (json.usage) {
    const events: UsageEvent[] = [{
      stage,
      model: body.model,
      inputTokens: json.usage.input_tokens ?? 0,
      outputTokens: json.usage.output_tokens ?? 0,
      cacheCreationInputTokens: json.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: json.usage.cache_read_input_tokens ?? 0,
    }];
    const searches = json.usage.server_tool_use?.web_search_requests ?? 0;
    if (searches > 0) {
      events.push({ stage, model: 'web_search', inputTokens: searches, outputTokens: 0 });
    }
    for (const event of events) {
      console.log('[Digest:usage]', JSON.stringify(event));
      if (usageSink) {
        try {
          usageSink(event);
        } catch {
        }
      }
    }
  }
  return json;
}

export function cachedSystem(text: string): AnthropicTextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function withConversationCacheBreakpoint(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length < 3) return messages;
  const idx = messages.length - 2;
  const target = messages[idx];
  const content = target.content;

  let cached: AnthropicContentBlockParam[];
  if (typeof content === 'string') {
    if (content.trim() === '') return messages;
    cached = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  } else {
    const last = content[content.length - 1];
    if (!last || last.type !== 'text') return messages;
    cached = [...content.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }];
  }

  const out = [...messages];
  out[idx] = { role: target.role, content: cached };
  return out;
}

export function messageText(response: AnthropicMessageResponse): string {
  return (response.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}
