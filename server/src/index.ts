import './env.js';
import { createServer } from 'http';
import { createApp } from './app.js';
import { ensureTables, pool } from './db/index.js';
import { auditSchemaDrift, shouldBlockStartup, blockingDriftMessage } from './db/schemaAudit.js';
import { startDigestScheduler, stopDigestScheduler } from './services/digest/scheduler.js';
import { logFeatureSummary } from './services/features.js';
import { recoverOrphanedDigestJobs } from './services/digest/orphanRecovery.js';
import { startAuditExportScheduler, stopAuditExportScheduler } from './services/audit/auditExport.js';
import { isAwaitingFirstAdmin } from './services/authService.js';
import { issueSetupCode } from './services/setupCode.js';

const app = createApp();
const httpServer = createServer(app);

const PORT = Number(process.env.PORT) || 3000;

logFeatureSummary();

startDigestScheduler();
process.on('SIGTERM', () => stopDigestScheduler());
process.on('SIGINT', () => stopDigestScheduler());

ensureTables().then(async () => {
  const client = await pool.connect();
  let drift = null;
  try {
    drift = await auditSchemaDrift(client);
  } finally {
    client.release();
  }
  if (shouldBlockStartup(drift)) {
    for (const line of blockingDriftMessage(drift!)) console.error(line);
    process.exit(1);
  }
  void recoverOrphanedDigestJobs();
  try {
    if (await isAwaitingFirstAdmin()) issueSetupCode();
  } catch (err) {
    console.error('[Setup] 管理者がいるかどうかを確かめられませんでした:', err);
  }
  startAuditExportScheduler();
  process.on('SIGTERM', () => stopAuditExportScheduler());
  process.on('SIGINT', () => stopAuditExportScheduler());
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}).catch((err) => {
  if (process.env.NODE_ENV === 'production') {
    console.error('[DB] ensureTables failed: データベースに繋がりません。起動を止めます。');
    console.error('[DB] .env の POSTGRES_PASSWORD（英数字だけにする。Docker の外なら DATABASE_URL）を見直してください:', err);
    process.exit(1);
  }
  console.error('[DB] ensureTables failed, starting server anyway (development only):', err);
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });
});
