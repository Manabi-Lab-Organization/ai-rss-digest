import express from 'express';
import { trustProxySetting } from './config/trustProxy.js';
import cors from 'cors';
import { siteConfig } from './services/siteConfig.js';
import { serverFeatures } from './services/features.js';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { sessionMiddleware } from './config/session.js';
import { sessionPolicyMiddleware } from './middleware/sessionPolicy.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import { requestContextMiddleware } from './services/audit/requestContext.js';
import { accessLogMiddleware } from './services/audit/accessLog.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import userRouter from './routes/user.js';
import announcementsRouter from './routes/announcements.js';
import digestRouter from './routes/digest.js';

const CHAT_BODY_LIMIT = '50mb';

export function createApp() {
  const app = express();

  const trustProxy = trustProxySetting(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production');
  if (trustProxy !== false) app.set('trust proxy', trustProxy);

  app.use(requestContextMiddleware);
  app.use(accessLogMiddleware);

  const GOOGLE_IDENTITY_ORIGIN = 'https://accounts.google.com';
  const cspEnforce = process.env.CSP_ENFORCE !== '0';
  app.use(
    helmet({
      contentSecurityPolicy: {
        reportOnly: !cspEnforce,
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", GOOGLE_IDENTITY_ORIGIN],
          connectSrc: ["'self'", GOOGLE_IDENTITY_ORIGIN],
          frameSrc: [GOOGLE_IDENTITY_ORIGIN],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'", GOOGLE_IDENTITY_ORIGIN],
          fontSrc: ["'self'"],
          mediaSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'", GOOGLE_IDENTITY_ORIGIN],
          reportUri: ['/api/csp-report'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      hsts: { maxAge: 15552000, includeSubDomains: true },
    })
  );

  const normalizeOrigin = (url: string): string => url.replace(/\/+$/, '');
  const allowedOrigins = ([
    process.env.APP_URL,
    process.env.CLIENT_URL || 'http://localhost:5173',
  ].filter(Boolean) as string[]).map(normalizeOrigin);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    })
  );

  app.use(sessionMiddleware);
  app.use(sessionPolicyMiddleware);

  app.post('/api/digest/chat', requireAuth, express.json({ limit: CHAT_BODY_LIMIT }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.get('/api/features', (_req, res) => {
    res.json(serverFeatures());
  });
  app.get('/api/site-config', (_req, res) => {
    res.json(siteConfig());
  });
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/user', userRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/digest', digestRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const cspReportParser = express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '50kb',
  });
  let cspReportWindowStart = Date.now();
  let cspReportCount = 0;
  const CSP_REPORT_MAX_PER_MIN = 50;
  app.post('/api/csp-report', cspReportParser, (req, res) => {
    res.status(204).end();
    const now = Date.now();
    if (now - cspReportWindowStart > 60_000) {
      cspReportWindowStart = now;
      cspReportCount = 0;
    }
    cspReportCount++;
    if (cspReportCount === CSP_REPORT_MAX_PER_MIN + 1) {
      console.warn('[CSP] violation reports throttled (>50/min); further reports suppressed this minute');
      return;
    }
    if (cspReportCount > CSP_REPORT_MAX_PER_MIN) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const r = (body['csp-report'] ?? body) as Record<string, unknown>;
      const summary = {
        blocked: r['blocked-uri'],
        directive: r['violated-directive'] ?? r['effective-directive'],
        document: r['document-uri'],
      };
      console.warn('[CSP] violation:', JSON.stringify(summary));
    } catch {
    }
  });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const clientDistPath = path.resolve(__dirname, '../../client/dist');
  const isDev = process.env.NODE_ENV !== 'production';
  const viteDevUrl = process.env.CLIENT_URL || 'http://localhost:5173';

  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(clientDistPath, 'index.html'));
    });
    console.log(`[Static] Serving client from ${clientDistPath}`);
  } else if (isDev) {
    app.get('*', (_req, res) => {
      res.redirect(viteDevUrl + _req.originalUrl);
    });
    console.log(`[Static] Dev mode: redirecting to ${viteDevUrl}`);
  } else {
    console.log(`[Static] Client dist not found at ${clientDistPath} - run 'npm run build --workspace=client' first`);
  }

  app.use(errorHandler);

  return app;
}
