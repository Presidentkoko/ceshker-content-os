import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { api } from './routes.js';
import { media } from './mediaRoute.js';
import { sessionMiddleware } from './auth.js';
import { mountLegalPages } from './legalPages.js';
import { errorHandler } from './http.js';
import { pool } from './db/pool.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameSrc: ['https://drive.google.com', 'https://www.youtube.com'],
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Basic CSRF defence for cookie-authenticated writes: same-origin requests only.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/hooks/')) return next();
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    next();
  });

  mountLegalPages(app);
  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use(media);
  app.use('/api', sessionMiddleware, api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const web = [path.resolve(here, '../../dist-web'), path.resolve(here, '../dist-web')].find((p) => existsSync(p));
  if (web) {
    app.use(express.static(web, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(web, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
