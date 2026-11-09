import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { registerAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import listRoutes from './routes/lists.js';
import shoppingRoutes from './routes/shopping.js';
import householdRoutes from './routes/households.js';
import historyRoutes from './routes/history.js';
import itemsCsvRoutes from './routes/itemsCsv.js';
import moduleRoutes from './routes/modules.js';
import { makeSecrets } from './secrets.js';
import { createModules } from './modules/manager.js';
import { createReceiptQueue } from './receipts.js';
import { userPayload } from './util.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Modules that ship with the app are looked for in MODULES_DIR, then next to src/ (Docker image), then in the repository root.
function findBundledDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [process.env.MODULES_DIR, path.resolve(here, '../modules'), path.resolve(here, '../../modules')].find((d) => d && fs.existsSync(d)) ?? null;
}

// bundledDir: false starts without bundled modules (core tests). moduleOptions[<id>] reaches that module as ctx.options (tests).
// onRestart replaces the default "close and exit" so tests can observe the admin's Restart button.
export async function buildApp({ dataDir, webDir, logger = true, bundledDir, moduleOptions = {}, onRestart } = {}) {
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 1_000_000 });
  app.decorate('db', openDb(dataDir));
  app.decorate('dataDir', dataDir);
  app.decorate('coreVersion', VERSION);
  app.decorate('secrets', makeSecrets(dataDir));
  app.decorate('modules', createModules(app, { bundledDir: bundledDir === false ? null : (bundledDir ?? findBundledDir()), moduleOptions, coreVersion: VERSION }));
  app.decorate('receipts', createReceiptQueue(app));
  app.decorate('userPayload', (u) => ({ ...userPayload(app.db, u), ...app.modules.payloadFor(u) }));
  app.decorate('requestRestart', () => setTimeout(() => (onRestart ? onRestart() : app.close().finally(() => process.exit(0))), 400).unref?.());
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerAuth(app);
  // Receipt photos arrive as raw image bytes (the web app compresses them first).
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: 12 * 1024 * 1024 }, (req, body, done) => done(null, body));
  // Module zips arrive as raw bytes too.
  app.addContentTypeParser(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 21 * 1024 * 1024 }, (req, body, done) => done(null, body));

  // CSRF defence in depth (cookies are also SameSite=Lax): API writes must carry our custom header.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-sl-client'] !== 'web') {
      return reply.code(403).send({ error: 'bad_client' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.code === 'household_not_found') return reply.code(400).send({ error: 'household_not_found' });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'too_many_requests' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code || 'bad_request' });
    req.log.error(err);
    return reply.code(500).send({ error: 'server_error' });
  });

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(listRoutes);
  await app.register(shoppingRoutes);
  await app.register(householdRoutes);
  await app.register(historyRoutes);
  await app.register(itemsCsvRoutes);
  await app.register(moduleRoutes);
  await app.modules.load(); // installed and enabled modules register their routes, capabilities and event handlers here

  if (webDir && fs.existsSync(webDir)) {
    await app.register(fstatic, {
      root: path.resolve(webDir),
      cacheControl: false,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html'); // SPA fallback
    });
  }

  // Housekeeping: drop expired sessions and reset tokens hourly.
  const timer = setInterval(() => {
    const now = Date.now();
    app.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked = 1 AND last_seen_at < ?)').run(now, now - 7 * 86400000);
    app.db.prepare('DELETE FROM password_resets WHERE expires_at < ? OR used = 1').run(now);
  }, 3600 * 1000);
  timer.unref();
  app.addHook('onReady', async () => { app.receipts.resume(); });
  app.addHook('onClose', async () => { clearInterval(timer); app.db.close(); });

  return app;
}
