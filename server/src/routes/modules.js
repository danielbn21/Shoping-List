import fs from 'node:fs';
import { audit } from '../util.js';

const bad = (reply, error, code = 400, detail) => reply.code(code).send(detail ? { error, detail } : { error });
const TYPES = { 'web.js': 'application/javascript; charset=utf-8', 'web.css': 'text/css; charset=utf-8', 'i18n.json': 'application/json; charset=utf-8' };
const STATUS = { not_found: 404, already_installed: 409, has_dependents: 409, missing_dependency: 409, no_previous_version: 409, stage_expired: 410, forbidden: 403 };

// Turns the manager's coded errors into API errors; anything else is a real bug and goes to the error handler.
const guard = (reply, fn) => {
  try { return fn(); } catch (e) {
    if (e.coded) return bad(reply, e.code, STATUS[e.code] ?? 400, e.detail);
    throw e;
  }
};

export default async function moduleRoutes(app) {
  const db = app.db, mods = app.modules;
  const user = { preHandler: app.auth() };
  const admin = { preHandler: app.auth({ admin: true }) };

  /* ---------- everyone ---------- */

  // Browser code, styles and strings of a module. The URL carries ?v=<version>, so it can be cached for good.
  app.get('/api/modules/:id/asset/:name', user, async (req, reply) => {
    const { id, name } = req.params;
    if (!TYPES[name] || !mods.available(req.user.id, id)) return bad(reply, 'not_found', 404);
    const file = mods.assetFor(id, name);
    if (!file) return bad(reply, 'not_found', 404);
    return reply.header('Cache-Control', 'private, max-age=31536000, immutable').type(TYPES[name]).send(fs.createReadStream(file));
  });

  // The user's own switch for a module the admin has granted them (takes effect at once).
  app.put('/api/modules/:id/me', user, async (req, reply) => {
    const id = req.params.id, on = (req.body || {}).on;
    if (typeof on !== 'boolean') return bad(reply, 'invalid_value');
    if (!mods.loaded.has(id) || !mods.enabledLive(id)) return bad(reply, 'not_found', 404);
    return guard(reply, () => { mods.setUserOn(req.user.id, id, on); return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) }; });
  });

  /* ---------- admin ---------- */

  app.get('/api/admin/modules', admin, async () => {
    const installed = mods.rows().map((r) => mods.describe(r));
    const have = new Set(mods.rows().filter((r) => r.status !== 'removed').map((r) => r.id));
    return {
      coreVersion: app.coreVersion, modules: installed.filter((m) => m.status !== 'removed'),
      available: mods.bundledAvailable().filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, name: m.name, version: m.version, description: m.description })),
    };
  });

  // Step 1 of an upload: look inside the zip and report what it is. Nothing is installed yet.
  app.post('/api/admin/modules/inspect', { ...admin, bodyLimit: 21 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) =>
    guard(reply, () => {
      if (!Buffer.isBuffer(req.body)) return bad(reply, 'zip_invalid');
      return mods.stageZip(req.body);
    }));

  // Step 2: the admin saw the name, version and hash and confirmed. The module is installed switched off.
  app.post('/api/admin/modules/install', admin, async (req, reply) =>
    guard(reply, () => {
      const out = mods.installStaged(String((req.body || {}).token || ''), req.user.id);
      return { module: mods.describe(mods.row(out.manifest.id)) };
    }));

  app.post('/api/admin/modules/bundled/:id/install', admin, async (req, reply) =>
    guard(reply, () => { mods.installBundled(req.params.id, req.user.id); return { module: mods.describe(mods.row(req.params.id)) }; }));

  app.post('/api/admin/modules/:id/enable', admin, async (req, reply) =>
    guard(reply, () => { mods.setEnabled(req.params.id, true, req.user.id); return { module: mods.describe(mods.row(req.params.id)) }; }));
  app.post('/api/admin/modules/:id/disable', admin, async (req, reply) =>
    guard(reply, () => { mods.setEnabled(req.params.id, false, req.user.id); return { module: mods.describe(mods.row(req.params.id)) }; }));
  app.post('/api/admin/modules/:id/uninstall', admin, async (req, reply) =>
    guard(reply, () => { mods.uninstall(req.params.id, { deleteData: !!(req.body || {}).deleteData }, req.user.id); const r = mods.row(req.params.id); return { module: r && r.status !== 'removed' ? mods.describe(r) : null }; }));
  app.post('/api/admin/modules/:id/rollback', admin, async (req, reply) =>
    guard(reply, () => { mods.rollback(req.params.id, req.user.id); return { module: mods.describe(mods.row(req.params.id)) }; }));

  // Who may use a module: the admin's grant (the user's own on/off switch is shown but is theirs to change).
  app.get('/api/admin/modules/:id/access', admin, async (req, reply) => {
    if (!mods.row(req.params.id)) return bad(reply, 'not_found', 404);
    return { users: mods.accessList(req.params.id) };
  });
  app.put('/api/admin/modules/:id/access', admin, async (req, reply) => {
    const b = req.body || {};
    if (!mods.row(req.params.id)) return bad(reply, 'not_found', 404);
    if (!Number.isInteger(b.userId) || typeof b.granted !== 'boolean') return bad(reply, 'invalid_value');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(b.userId)) return bad(reply, 'not_found', 404);
    mods.setGranted(b.userId, req.params.id, b.granted);
    audit(db, req.user.id, 'module.access_changed', req.params.id, { userId: b.userId, granted: b.granted });
    return { users: mods.accessList(req.params.id) };
  });

  // The only way the server restarts: the admin presses the button. Docker (restart: unless-stopped) starts it again.
  app.post('/api/admin/server/restart', admin, async (req) => {
    audit(db, req.user.id, 'server.restart_requested', null);
    app.requestRestart();
    return { ok: true };
  });
}
