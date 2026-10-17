import { Resend } from 'resend';
import { siteConfig } from './siteConfig.js';

const APP_NAME = siteConfig().appName;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escUrlAttr(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return '';
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return escapeHtml(s);
}

function getBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  return 'http://localhost:3000';
}

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error('RESEND_API_KEY が設定されていません。サーバの環境変数（.env）に追加してください。');
    }
    _resend = new Resend(key);
  }
  return _resend;
}

type MailPayload = Parameters<Resend['emails']['send']>[0];

interface MailError {
  statusCode?: number | null;
  message?: string;
  name?: string;
}

export function isTransientMailError(error: MailError | null | undefined): boolean {
  if (!error) return false;
  const code = error.statusCode;
  if (code == null) return true;
  if (code === 408 || code === 429) return true;
  return code >= 500;
}

const MAIL_RETRY_BASE_MS = 2000;

async function sendWithRetry(
  payload: MailPayload,
  label: string,
  { attempts = 3, sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<void> {
  const resend = getResend();
  let last: MailError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { error } = await resend.emails.send(payload);
    if (!error) {
      if (attempt > 1) console.log(`[Mail] ${label}: ${attempt}回目で送信できました`);
      return;
    }
    last = error as MailError;
    if (!isTransientMailError(last) || attempt === attempts) break;
    const waitMs = MAIL_RETRY_BASE_MS * 2 ** (attempt - 1);
    console.warn(`[Mail] ${label}の送信に失敗、${waitMs / 1000}秒後に再試行`
      + ` (${attempt}/${attempts - 1}): ${JSON.stringify(last).slice(0, 200)}`);
    await sleepFn(waitMs);
  }
  throw new Error(`${label}の送信に失敗: ${JSON.stringify(last)}`);
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string
): Promise<void> {
  const baseUrl = getBaseUrl();
  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject: `[${APP_NAME}] パスワードリセット`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">${APP_NAME}</h2>
        <p>パスワードリセットのリクエストを受け付けました。</p>
        <p>下のボタンをクリックして、新しいパスワードを設定してください。</p>
        <div style="margin: 30px 0; text-align: center;">
          <a href="${resetUrl}"
             style="background-color: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            パスワードをリセット
          </a>
        </div>
        <p style="color: #666; font-size: 14px;">
          このリンクは1時間後に無効になります。
        </p>
        <p style="color: #666; font-size: 14px;">
          このメールに心当たりがない場合は、無視してください。パスワードは変更されません。
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          ボタンが機能しない場合は、以下のURLをブラウザに貼り付けてください：<br />
          <a href="${resetUrl}" style="color: #666;">${resetUrl}</a>
        </p>
      </div>
    `,
  }, 'パスワード再設定メール');
}

export function digestEditionUrl(baseUrl: string, editionId: number): string {
  return `${baseUrl}/digest?edition=${editionId}`;
}

export interface DigestEditionEmailParams {
  to: string;
  editionId: number;
  title: string;
  content: {
    format: 'brief' | 'paper';
    sections: Array<{ name: string; articles: Array<{ headline: string; lead: string; url: string; sourceTitle: string | null }> }>;
    note?: string;
    coverage?: string;
  } | null;
  isFirstIssue: boolean;
  growingNotice: boolean;
}

export function buildDigestEditionEmailHtml(
  params: Omit<DigestEditionEmailParams, 'to'>,
  baseUrl: string,
): string {
  const { title, editionId, content, isFirstIssue, growingNotice } = params;
  const esc = escapeHtml;
  const sections = content?.sections ?? [];
  const isBrief = (content?.format ?? 'brief') === 'brief';

  const sectionHtml = sections.map((sec) => `
    ${isBrief ? '' : `<h3 style="margin: 24px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; color: #333;">${esc(sec.name)}</h3>`}
    ${sec.articles.map((a) => `
      <div style="margin: 0 0 16px;">
        <div style="font-weight: bold; font-size: 15px;"><a href="${escUrlAttr(a.url)}" style="color: #1a1a1a; text-decoration: none;">${esc(a.headline)}</a></div>
        <div style="color: #444; font-size: 13px; margin-top: 2px;">${esc(a.lead)}</div>
        <div style="color: #888; font-size: 11px; margin-top: 2px;">${esc(a.sourceTitle ?? '')}</div>
      </div>`).join('')}
  `).join('');

  const noticeHtml = growingNotice
    ? `<div style="background: #fdf3e3; border: 1px solid #e0c48a; padding: 10px 14px; font-size: 12px; color: #6b4e0e; margin: 16px 0;">
         このダイジェストは育成中です。情報源が増え、記事への評価（👍👎）が貯まるほど紙面は良くなります。</div>`
    : '';
  const noteHtml = content?.note
    ? `<p style="color: #666; font-size: 13px;">${esc(content.note)}</p>`
    : '';

  return `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <h2 style="margin: 0 0 4px; color: #1a1a1a;">${esc(title)}</h2>
        <div style="color: #888; font-size: 12px; margin-bottom: 8px;">あなた専用の情報ダイジェスト${content?.coverage ? `・記事対象期間: ${esc(content.coverage)}` : ''}</div>
        ${isFirstIssue ? `<p style="font-size: 14px;">${escapeHtml(APP_NAME)}の創刊号をお届けします。</p>` : ''}
        ${noticeHtml}
        ${noteHtml}
        ${sectionHtml}
        <div style="margin: 24px 0; text-align: center;">
          <a href="${digestEditionUrl(baseUrl, editionId)}"
             style="background-color: #0f172a; color: white; padding: 10px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            アプリで紙面を読む
          </a>
        </div>
        <p style="color: #999; font-size: 11px;">配信停止や頻度の変更は、アプリの設定画面から行えます。</p>
      </div>
    `;
}

export async function sendDigestEditionEmail(params: DigestEditionEmailParams): Promise<void> {
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [params.to],
    subject: `【${APP_NAME}】${params.title}${params.isFirstIssue ? ' 🎉' : ''}`,
    html: buildDigestEditionEmailHtml(params, getBaseUrl()),
  }, '朝刊の配信メール');
}

export async function sendDigestProfileReviewEmail(params: {
  to: string;
  proposalId: number;
  proposal: string;
  ratedCount: number;
  opinionCount: number;
}): Promise<void> {
  const { to, proposalId, proposal, ratedCount, opinionCount } = params;
  const baseUrl = getBaseUrl();
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  const esc = escapeHtml;

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject: `【${APP_NAME}】編集方針の見直し提案 #${proposalId}（評価${ratedCount}件・意見${opinionCount}件を分析）`,
    html: `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <h2 style="margin: 0 0 4px; color: #1a1a1a;">編集方針の見直し提案</h2>
        <div style="color: #888; font-size: 12px; margin-bottom: 12px;">
          あなたの👍👎評価 ${ratedCount}件と意見 ${opinionCount}件をもとに、編集方針の改定案を作成しました。
        </div>
        <pre style="white-space: pre-wrap; font-family: 'Hiragino Sans', sans-serif; font-size: 13px; line-height: 1.7; background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px;">${esc(proposal)}</pre>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${baseUrl}/digest?review=1"
             style="background-color: #0f172a; color: white; padding: 10px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            アプリで案を確認・相談する
          </a>
        </div>
        <p style="color: #999; font-size: 11px;">この案はあなたが承認するまで反映されません。アプリでは「ここはこう直して」と指摘を送ると、その場で案を作り直します。納得できたら承認、合わなければ見送りを選べます。</p>
      </div>
    `,
  }, '編集方針の見直し提案メール');
}

export async function sendDigestResearchEmail(params: {
  to: string;
  headline: string;
  report: string;
  articleUrl: string;
  researchId?: number;
  visualPending?: boolean;
}): Promise<void> {
  const { to, headline, report, articleUrl, researchId, visualPending } = params;
  const baseUrl = getBaseUrl();
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  const esc = escapeHtml;

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject: `【${APP_NAME}】深掘りレポート: ${headline}`,
    html: `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <h2 style="margin: 0 0 4px; color: #1a1a1a;">${esc(headline)}</h2>
        <div style="color: #888; font-size: 12px; margin-bottom: 12px;">ご依頼の深掘りレポートが完成しました。</div>
        ${visualPending ? '<div style="color: #1e40af; font-size: 13px; margin-bottom: 12px;">📊 図解付きのビジュアル版を自動で作成しています。下のボタンからレポートを開くと進捗が確認でき、完成すると「ビジュアル表示」ボタンが出ます。</div>' : ''}
        <pre style="white-space: pre-wrap; font-family: 'Hiragino Sans', sans-serif; font-size: 13px; line-height: 1.7; background: #f8fafc; border: 1px solid #e2e8f0; padding: 16px;">${esc(report)}</pre>
        <p style="font-size: 13px;"><a href="${escUrlAttr(articleUrl)}" style="color: #1e40af;">元記事を読む</a></p>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${baseUrl}/digest${researchId ? `?research=${researchId}` : ''}"
             style="background-color: #0f172a; color: white; padding: 10px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            アプリでレポートを読む
          </a>
        </div>
        <p style="color: #999; font-size: 11px;">このレポートはアプリからいつでも読み返せます。</p>
      </div>
    `,
  }, '深掘りレポートのメール');
}

export async function sendOperationsEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { to, subject, text, html } = params;
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject,
    text,
    html: `<div style="font-family: 'Helvetica Neue', Arial, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.7;">${html}</div>`,
  }, '運用連絡メール');
}

export interface DigestPodcastEmailParams {
  to: string;
  editionId: number;
  editionTitle: string;
  durationSec: number;
}

export function buildDigestPodcastEmailHtml(
  params: Omit<DigestPodcastEmailParams, 'to'>,
  baseUrl: string,
): string {
  const { editionId, editionTitle, durationSec } = params;
  const esc = escapeHtml;
  const minutes = Math.max(1, Math.round(durationSec / 60));

  return `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <h2 style="margin: 0 0 4px; color: #1a1a1a;">🎧 音声版が完成しました</h2>
        <div style="color: #444; font-size: 14px; margin-bottom: 12px;">
          ${esc(editionTitle)}（約${minutes}分）
        </div>
        <p style="font-size: 13px; color: #444;">アプリの朝刊タブにあるプレーヤーからお聴きいただけます。</p>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${digestEditionUrl(baseUrl, editionId)}"
             style="background-color: #0f172a; color: white; padding: 10px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            アプリで聴く
          </a>
        </div>
        <p style="color: #999; font-size: 11px;">この通知は設定画面の「メールでも受け取る」で停止できます。</p>
      </div>
    `;
}

export async function sendDigestPodcastEmail(params: DigestPodcastEmailParams): Promise<void> {
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [params.to],
    subject: `【${APP_NAME}】🎧 音声版が完成しました: ${params.editionTitle}`,
    html: buildDigestPodcastEmailHtml(params, getBaseUrl()),
  }, '音声版の完成メール');
}

export async function sendDigestSourceSuggestionEmail(params: {
  to: string;
  proposals: Array<{ title: string; reason: string }>;
}): Promise<void> {
  const { to, proposals } = params;
  const baseUrl = getBaseUrl();
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  const esc = escapeHtml;

  const proposalHtml = proposals.map((p) => `
    <div style="margin: 0 0 14px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e2e8f0;">
      <div style="font-weight: bold; font-size: 14px; color: #1a1a1a;">${esc(p.title)}</div>
      <div style="color: #444; font-size: 12px; margin-top: 4px; line-height: 1.6;">${esc(p.reason)}</div>
    </div>`).join('');

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject: `【${APP_NAME}】新しい情報源のご提案（${proposals.length}件）`,
    html: `
      <div style="font-family: sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
        <h2 style="margin: 0 0 4px; color: #1a1a1a;">新しい情報源のご提案</h2>
        <div style="color: #888; font-size: 12px; margin-bottom: 12px;">
          紙面の記事に付けていただいた評価をもとに、編集長AIが情報源を${proposals.length}件ご提案します。
        </div>
        ${proposalHtml}
        <div style="margin: 24px 0; text-align: center;">
          <a href="${baseUrl}/digest?suggest=1"
             style="background-color: #0f172a; color: white; padding: 10px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            アプリで提案を確認する
          </a>
        </div>
        <p style="color: #999; font-size: 11px;">アプリの「編集長に相談」タブで承認できます。承認するまで収集は始まりません。</p>
        <p style="color: #999; font-size: 11px;">提案は1回につき最大10件に絞っています（提案の質のため）。もっと必要なときは「編集長に相談」タブで「別の角度でもっと提案して」と送ってください。</p>
      </div>
    `,
  }, '情報源の提案メール');
}

