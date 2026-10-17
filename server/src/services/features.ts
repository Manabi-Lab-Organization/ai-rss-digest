export interface ServerFeatures {
  googleLogin: boolean;
  email: boolean;
  podcast: boolean;
}

export function serverFeatures(env: NodeJS.ProcessEnv = process.env): ServerFeatures {
  return {
    googleLogin: !!env.GOOGLE_CLIENT_ID,
    email: !!env.RESEND_API_KEY,
    podcast: !!env.GEMINI_API_KEY,
  };
}

export function logFeatureSummary(): void {
  if (!process.env.INITIAL_ADMIN_EMAIL) {
    console.warn('[Features] INITIAL_ADMIN_EMAIL が未設定：初期設定コードを知っている人なら、どのアドレスでも最初の管理者になれます。立ち上げたらすぐに管理者を登録してください');
  }
  const f = serverFeatures();
  if (!process.env.ANTHROPIC_API_KEY) console.warn('[Features] ANTHROPIC_API_KEY が未設定：紙面を作れません（必須）');
  if (!f.podcast) console.warn('[Features] GEMINI_API_KEY が未設定：音声版（ポッドキャスト）は使えません');
  if (!f.email) console.warn('[Features] RESEND_API_KEY が未設定：メールは送りません（朝刊は画面で読む。パスワードの再設定は管理者が行う）');
  console.log(`[Features] ${JSON.stringify(f)}`);
}
