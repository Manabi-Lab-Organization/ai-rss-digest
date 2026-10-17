import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

const root = resolve(__dir, '../..');
dotenv.config({ path: resolve(root, '.env.local') });
dotenv.config({ path: resolve(root, '.env') });

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  const missing: string[] = [];

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-in-production') {
    missing.push('SESSION_SECRET（でたらめな長い文字列。作り方の例: openssl rand -hex 32）');
  }

  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL（データベースの接続先。Docker では docker-compose.yml が自動で入れる）');
  }

  if (!process.env.INITIAL_ADMIN_EMAIL) {
    missing.push('INITIAL_ADMIN_EMAIL（最初の管理者になる人のメールアドレス）');
  }

  if (!process.env.APP_URL) {
    missing.push('APP_URL（このサーバの公開アドレス。例: https://digest.example.co.jp）');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    missing.push('ANTHROPIC_API_KEY（紙面の編集・要約に必要）');
  }

  if (missing.length > 0) {
    console.error('[Startup] 必須の設定が足りません:');
    for (const m of missing) {
      console.error(`  - ${m}`);
    }
    console.error('[Startup] 起動を止めます。.env に書き込んでから、もう一度立ち上げてください（docker compose up -d）。');
    process.exit(1);
  }

  console.log('[Startup] 必須の設定はそろっています');
} else {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    console.warn('[Startup] SESSION_SECRET が未設定のため、起動ごとにでたらめな値を使います（開発用。再起動するとログインが切れます）');
  }
}
