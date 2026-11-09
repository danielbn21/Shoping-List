import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { checkManifest } from './manifest.js';
import { readZip, checkImports } from './zip.js';
import { compareVersions } from './semver.js';
import { createEvents } from './events.js';
import { makeCoreApi } from './coreApi.js';
import { audit } from '../util.js';

const IGNORE_TOP = new Set(['web', 'test', 'tests', 'node_modules', '.git']);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const coded = (code, detail) => { const e = new Error(code); e.code = code; e.detail = detail; e.coded = true; return e; };

// Reads a module folder (a bundled module or a development checkout) as { relative/path: Buffer }, skipping sources and tests.
export function readModuleDir(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || (rel === '' && IGNORE_TOP.has(ent.name))) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), r);
      else if (ent.isFile()) out[r] = fs.readFileSync(path.join(abs, ent.name));
    }
  };
  walk(dir, '');
  return out;
}

// A hash of the module's files that does not depend on how they were delivered (zip or folder).
export function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(files).sort()) { h.update(k); h.update('\0'); h.update(files[k]); h.update('\0'); }
  return h.digest('hex');
}

export function createModules(app, { bundledDir = null, moduleOptions = {}, coreVersion }) {
  const db = app.db;
  const root = path.join(app.dataDir, 'modules');
  fs.mkdirSync(root, { recursive: true });
  const events = createEvents(app.log);
  const core = makeCoreApi(app);
  const loaded = new Map();      // id -> { manifest, dir, db, routes, providers }
  const providers = [];          // { capability, moduleId, impl }
  const staged = new Map();      // token -> { files, sha, name, expires }
  const log = app.log;

  const row = (id) => db.prepare('SELECT * FROM modules WHERE id = ?').get(id);
  const rows = () => db.prepare('SELECT * FROM modules ORDER BY installed_at, id').all();
  const verDir = (id, v) => path.join(root, id, v);
  const manifestOf = (r) => {
    try { return JSON.parse(fs.readFileSync(path.join(verDir(r.id, r.version), 'manifest.json'), 'utf8')); } catch { return null; }
  };

  /* ---------------- install ---------------- */

  // Validates a set of files and returns { manifest, sha } without touching the disk. Throws coded errors.
  function inspectFiles(files, sha = null, { lenient = false } = {}) {
    let parsed;
    try { parsed = JSON.parse(files['manifest.json'].toString('utf8')); } catch { throw coded('manifest_invalid', 'manifest.json is not valid JSON'); }
    const c = checkManifest(parsed, { coreVersion });
    if (!c.ok) throw coded(c.error, c.detail);
    const m = c.manifest;
    checkImports(files, new Set([m.web, m.css].filter(Boolean)));
    // A development checkout may not have built its browser files yet; uploads must be complete.
    for (const k of lenient ? ['server', 'strings'] : ['server', 'web', 'css', 'i18n', 'strings']) if (m[k] && !files[m[k]]) throw coded('manifest_invalid', `${k} file ${m[k]} is not in the module`);
    if (m.kind === 'language') {
      let dict;
      try { dict = JSON.parse(files[m.strings].toString('utf8')); } catch { throw coded('manifest_invalid', 'the strings file is not valid JSON'); }
      if (!dict || typeof dict !== 'object' || Array.isArray(dict) || Object.keys(dict).length > 5000 || Object.values(dict).some((v) => typeof v !== 'string')) throw coded('manifest_invalid', 'the strings file must map keys to text');
    }
    return { manifest: m, sha: sha ?? hashFiles(files), files: Object.keys(files).length };
  }

  function writeVersion(m, files) {
    const target = verDir(m.id, m.version), tmp = `${target}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const [rel, buf] of Object.entries(files)) {
      const abs = path.join(tmp, rel);
      if (!abs.startsWith(tmp + path.sep)) throw coded('zip_unsafe', rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    // Module folders live under /data, outside the app's package: tell Node their .js files are ES modules.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"private":true,"type":"module"}\n');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
  }

  function pruneVersions(id, keep) {
    const base = path.join(root, id);
    if (!fs.existsSync(base)) return;
    for (const d of fs.readdirSync(base)) if (!keep.includes(d) && d !== 'data.db' && d !== 'data.db-wal' && d !== 'data.db-shm' && d !== 'files') fs.rmSync(path.join(base, d), { recursive: true, force: true });
  }

  // source: 'upload' | 'bundled'. A new module starts disabled when uploaded, enabled when bundled with the app.
  function installFiles(files, { source, sha, actorId = null }) {
    const { manifest: m, sha: hash } = inspectFiles(files, sha, { lenient: source === 'bundled' });
    const cur = row(m.id);
    if (cur && cur.status !== 'removed' && cur.version === m.version) {
      if (source === 'bundled') return { manifest: m, changed: false };
      throw coded('already_installed', `${m.id} ${m.version}`);
    }
    writeVersion(m, files);
    const now = Date.now();
    if (cur && cur.status !== 'removed') {
      db.prepare("UPDATE modules SET name = ?, kind = ?, version = ?, prev_version = ?, status = 'installed', error = NULL, sha256 = ?, updated_at = ?, remove_pending = 0, purge_pending = 0 WHERE id = ?")
        .run(m.name, m.kind, m.version, cur.version, hash, now, m.id);
      pruneVersions(m.id, [m.version, cur.version]);
    } else {
      const enabled = source === 'bundled' ? 1 : 0;
      db.prepare(`INSERT INTO modules(id, name, kind, version, prev_version, enabled, status, source, sha256, installed_at, updated_at)
        VALUES (?,?,?,?,NULL,?, 'installed', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, version = excluded.version, prev_version = NULL, enabled = excluded.enabled,
          status = 'installed', error = NULL, source = excluded.source, sha256 = excluded.sha256, updated_at = excluded.updated_at, remove_pending = 0, purge_pending = 0`)
        .run(m.id, m.name, m.kind, m.version, enabled, source, hash, now, now);
      pruneVersions(m.id, [m.version]);
    }
    if (source === 'upload') audit(db, actorId, 'module.installed', m.id, { version: m.version, sha256: hash });
    return { manifest: m, changed: true, sha: hash };
  }

  // Step 1 of an upload: validate and hold the zip in memory so the admin can confirm the name, version and hash.
  function stageZip(buf) {
    const files = readZip(buf);
    const info = inspectFiles(files, sha256(buf));
    const cur = row(info.manifest.id);
    for (const [k, v] of staged) if (v.expires < Date.now()) staged.delete(k);
    const token = crypto.randomBytes(18).toString('hex');
    staged.set(token, { files, sha: info.sha, manifest: info.manifest, expires: Date.now() + 10 * 60 * 1000 });
    return { token, manifest: info.manifest, sha256: info.sha, files: info.files, installed: cur && cur.status !== 'removed' ? { version: cur.version, enabled: !!cur.enabled } : null, serverCode: !!info.manifest.server };
  }
  function installStaged(token, actorId) {
    const s = staged.get(token);
    if (!s || s.expires < Date.now()) throw coded('stage_expired');
    staged.delete(token);
    return installFiles(s.files, { source: 'upload', sha: s.sha, actorId });
  }

  /* ---------------- boot: pending removals, bundled modules, loading ---------------- */

  function applyPending() {
    for (const r of rows().filter((x) => x.remove_pending)) {
      const base = path.join(root, r.id);
      if (r.purge_pending) fs.rmSync(base, { recursive: true, force: true });
      else if (fs.existsSync(base)) {
        // Keep the module's database and files so a later reinstall finds its data again.
        for (const d of fs.readdirSync(base)) if (!['data.db', 'data.db-wal', 'data.db-shm', 'files'].includes(d)) fs.rmSync(path.join(base, d), { recursive: true, force: true });
      }
      // A bundled module keeps a "removed" marker so it is not quietly installed again at the next start.
      if (r.source === 'bundled') db.prepare("UPDATE modules SET status = 'removed', enabled = 0, remove_pending = 0, purge_pending = 0, error = NULL WHERE id = ?").run(r.id);
      else db.prepare('DELETE FROM modules WHERE id = ?').run(r.id);
      db.prepare('DELETE FROM module_access WHERE module_id = ?').run(r.id);
      audit(db, null, 'module.removed', r.id, { dataDeleted: !!r.purge_pending });
    }
  }

  function bundledList() {
    if (!bundledDir || !fs.existsSync(bundledDir)) return [];
    return fs.readdirSync(bundledDir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(bundledDir, d.name, 'manifest.json'))).map((d) => d.name);
  }
  function ensureBundled() {
    for (const name of bundledList()) {
      try {
        const files = readModuleDir(path.join(bundledDir, name));
        const { manifest: m } = inspectFiles(files, null, { lenient: true });
        const cur = row(m.id);
        if (cur?.status === 'removed') continue;                       // the admin removed it on purpose
        if (cur && (cur.source !== 'bundled' || compareVersions(m.version, cur.version) <= 0)) continue; // uploaded copies and equal or newer versions stay
        installFiles(files, { source: 'bundled' });
      } catch (e) { log.error({ err: e, detail: e.detail, module: name }, 'bundled module could not be installed'); }
    }
  }
  const bundledAvailable = () => bundledList().map((n) => { try { return inspectFiles(readModuleDir(path.join(bundledDir, n)), null, { lenient: true }).manifest; } catch { return null; } }).filter(Boolean);
  function installBundled(id, actorId) {
    const name = bundledList().find((n) => { try { return JSON.parse(fs.readFileSync(path.join(bundledDir, n, 'manifest.json'), 'utf8')).id === id; } catch { return false; } });
    if (!name) throw coded('not_found');
    const out = installFiles(readModuleDir(path.join(bundledDir, name)), { source: 'bundled', actorId });
    audit(db, actorId, 'module.installed', id, { version: out.manifest.version, bundled: true });
    return out;
  }

  function quarantine(id, message) {
    db.prepare("UPDATE modules SET status = 'quarantined', enabled = 0, error = ?, updated_at = ? WHERE id = ?").run(String(message).slice(0, 400), Date.now(), id);
    audit(db, null, 'module.quarantined', id, { error: String(message).slice(0, 400) });
    log.error({ module: id, error: String(message) }, 'module quarantined');
  }

  function openModuleDb(id) {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const mdb = new Database(path.join(dir, 'data.db'));
    mdb.pragma('journal_mode = WAL');
    mdb.exec('CREATE TABLE IF NOT EXISTS _settings (key TEXT PRIMARY KEY, value TEXT)');
    return mdb;
  }
  function runMigrations(mdb, steps) {
    if (!Array.isArray(steps)) return;
    const cur = mdb.pragma('user_version', { simple: true });
    for (let i = cur; i < steps.length; i++) mdb.transaction(() => { mdb.exec(steps[i]); mdb.pragma(`user_version = ${i + 1}`); })();
  }

  function makeCtx(m, mdb, routes, provided) {
    const get = mdb.prepare('SELECT value FROM _settings WHERE key = ?'), put = mdb.prepare('INSERT INTO _settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    const verb = (method) => (p, a, b) => { const [opts, handler] = typeof a === 'function' ? [{}, a] : [a || {}, b]; if (typeof handler !== 'function') throw new Error('route needs a handler'); routes.push({ method, path: p, opts, handler }); };
    return {
      id: m.id, version: m.version, coreVersion, db: mdb, filesDir: path.join(root, m.id, 'files'), options: moduleOptions[m.id] ?? {}, log: log.child ? log.child({ module: m.id }) : log,
      core,
      secrets: app.secrets,
      settings: {
        get: (k, fallback = null) => { const r = get.get(k); if (!r) return fallback; try { return JSON.parse(r.value); } catch { return fallback; } },
        set: (k, v) => { put.run(k, JSON.stringify(v)); },
      },
      routes: { get: verb('GET'), post: verb('POST'), put: verb('PUT'), patch: verb('PATCH'), delete: verb('DELETE') },
      events: { on: (name, fn) => events.on(name, fn, m.id) },
      provide: (capability, impl) => { if (!m.provides.includes(capability)) throw new Error(`manifest does not declare the capability ${capability}`); provided.push({ capability, moduleId: m.id, impl }); },
      onClose: (fn) => app.addHook('onClose', async () => { try { await fn(); } catch { /* shutting down */ } }),
      audit: (actorId, action, target, detail) => audit(db, actorId, `module.${m.id}.${action}`, target, detail),
    };
  }

  const available = (userId, id) => {
    const l = loaded.get(id), r = row(id);
    if (!l || !r || !r.enabled || r.status !== 'installed') return false;
    const a = db.prepare('SELECT granted, user_on FROM module_access WHERE user_id = ? AND module_id = ?').get(userId, id);
    return !a || (a.granted === 1 && a.user_on === 1);
  };
  const enabledLive = (id) => { const r = row(id); return !!r && r.enabled === 1 && r.status === 'installed' && loaded.has(id); };

  async function loadOne(r) {
    const m = (() => { const raw = manifestOf(r); if (!raw) return null; const c = checkManifest(raw, { coreVersion }); return c.ok ? c.manifest : c; })();
    if (!m) return quarantine(r.id, 'The module files are missing.');
    if (m.ok === false) return quarantine(r.id, `${m.error}: ${m.detail ?? ''}`);
    for (const d of m.dependsOn) {
      const dr = row(d);
      if (!dr || !dr.enabled || dr.status !== 'installed' || !loaded.has(d)) return quarantine(r.id, `dependency_missing: ${d}`);
    }
    let mdb = null;
    const routes = [], provided = [];
    try {
      if (m.server) {
        mdb = openModuleDb(m.id);
        const mod = await import(pathToFileURL(path.join(verDir(m.id, m.version), m.server)).href);
        runMigrations(mdb, mod.migrations);
        const ctx = makeCtx(m, mdb, routes, provided);
        if (typeof mod.default === 'function') await mod.default(ctx);
        mountRoutes(m, routes);
      }
    } catch (e) {
      events.dropOwner(m.id);
      try { mdb?.close(); } catch { /* ignore */ }
      return quarantine(r.id, e.message || String(e));
    }
    providers.push(...provided);
    loaded.set(m.id, { manifest: m, dir: verDir(m.id, m.version), db: mdb, version: m.version });
    if (mdb) app.addHook('onClose', async () => { try { mdb.close(); } catch { /* ignore */ } });
    log.info({ module: m.id, version: m.version }, 'module loaded');
  }

  function mountRoutes(m, routes) {
    if (!routes.length) return;
    const userGate = async (req, reply) => { if (!available(req.user.id, m.id)) return reply.code(404).send({ error: 'module_unavailable' }); };
    const adminGate = async (req, reply) => { if (!enabledLive(m.id)) return reply.code(404).send({ error: 'module_unavailable' }); };
    app.register(async (inst) => {
      for (const r of routes) {
        const { access = 'user', ...rest } = r.opts;
        const pre = access === 'admin' ? [app.auth({ admin: true }), adminGate] : [app.auth(), userGate];
        inst.route({ method: r.method, url: r.path, preHandler: pre, ...rest, handler: r.handler });
      }
    }, { prefix: `/api/m/${m.id}` });
  }

  // Order enabled modules so that dependencies load first; anything stuck in a cycle is quarantined.
  async function load() {
    applyPending();
    ensureBundled();
    const todo = rows().filter((r) => r.enabled && r.status === 'installed' && !r.remove_pending);
    const manifests = new Map(todo.map((r) => [r.id, manifestOf(r)]));
    const done = new Set();
    let progress = true;
    while (todo.length && progress) {
      progress = false;
      for (const r of [...todo]) {
        const deps = (manifests.get(r.id)?.dependsOn ?? []).filter((d) => todo.some((x) => x.id === d));
        if (deps.every((d) => done.has(d))) { await loadOne(row(r.id)); done.add(r.id); todo.splice(todo.indexOf(r), 1); progress = true; }
      }
    }
    for (const r of todo) quarantine(r.id, 'dependency_cycle');
  }

  /* ---------------- queries used by routes ---------------- */

  const dependentsOf = (id) => rows().filter((r) => r.id !== id && r.enabled && r.status === 'installed' && (manifestOf(r)?.dependsOn ?? []).includes(id)).map((r) => r.id);
  const needsRestart = (r) => {
    if (r.remove_pending) return true;
    if (r.status === 'removed') return false;
    const l = loaded.get(r.id);
    if (r.enabled && r.status === 'installed') return !l || l.version !== r.version;
    return !!l; // disabled in this run but still loaded
  };
  function describe(r) {
    const m = manifestOf(r);
    return {
      id: r.id, name: r.name, kind: r.kind, version: r.version, prevVersion: r.prev_version, enabled: !!r.enabled, status: r.status, error: r.error,
      source: r.source, sha256: r.sha256, installedAt: r.installed_at, updatedAt: r.updated_at, description: m?.description ?? '',
      provides: m?.provides ?? [], slots: m?.slots ?? [], dependsOn: m?.dependsOn ?? [], requiresCore: m?.requires?.core ?? '*',
      loaded: loaded.has(r.id), needsRestart: needsRestart(r), removePending: !!r.remove_pending, dependents: dependentsOf(r.id),
    };
  }

  function setEnabled(id, on, actorId) {
    const r = row(id);
    if (!r || r.status === 'removed') throw coded('not_found');
    if (on) {
      for (const d of manifestOf(r)?.dependsOn ?? []) { const dr = row(d); if (!dr || !dr.enabled || dr.status !== 'installed') throw coded('missing_dependency', d); }
      db.prepare("UPDATE modules SET enabled = 1, status = 'installed', error = NULL, remove_pending = 0, purge_pending = 0, updated_at = ? WHERE id = ?").run(Date.now(), id);
    } else {
      const deps = dependentsOf(id);
      if (deps.length) throw coded('has_dependents', deps.join(', '));
      db.prepare('UPDATE modules SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
    audit(db, actorId, on ? 'module.enabled' : 'module.disabled', id);
  }
  function uninstall(id, { deleteData = false } = {}, actorId) {
    const r = row(id);
    if (!r || r.status === 'removed') throw coded('not_found');
    const deps = dependentsOf(id);
    if (deps.length) throw coded('has_dependents', deps.join(', '));
    db.prepare('UPDATE modules SET enabled = 0, remove_pending = 1, purge_pending = ?, updated_at = ? WHERE id = ?').run(deleteData ? 1 : 0, Date.now(), id);
    audit(db, actorId, 'module.uninstall_requested', id, { deleteData });
    if (!loaded.has(id)) applyPending(); // never started in this run: remove right away
  }
  function rollback(id, actorId) {
    const r = row(id);
    if (!r || !r.prev_version || !fs.existsSync(verDir(id, r.prev_version))) throw coded('no_previous_version');
    db.prepare("UPDATE modules SET version = ?, prev_version = ?, status = CASE WHEN status = 'quarantined' THEN 'installed' ELSE status END, error = NULL, updated_at = ? WHERE id = ?").run(r.prev_version, r.version, Date.now(), id);
    audit(db, actorId, 'module.rolled_back', id, { from: r.version, to: r.prev_version });
  }

  /* ---------------- per user ---------------- */

  const accessRow = (userId, id) => db.prepare('SELECT granted, user_on FROM module_access WHERE user_id = ? AND module_id = ?').get(userId, id);
  function setGranted(userId, id, granted) {
    db.prepare('INSERT INTO module_access(user_id, module_id, granted, user_on) VALUES (?,?,?,1) ON CONFLICT(user_id, module_id) DO UPDATE SET granted = excluded.granted').run(userId, id, granted ? 1 : 0);
  }
  function setUserOn(userId, id, on) {
    const a = accessRow(userId, id);
    if (a && a.granted === 0) throw coded('forbidden');
    db.prepare('INSERT INTO module_access(user_id, module_id, granted, user_on) VALUES (?,?,1,?) ON CONFLICT(user_id, module_id) DO UPDATE SET user_on = excluded.user_on').run(userId, id, on ? 1 : 0);
  }
  function accessList(id) {
    return db.prepare("SELECT u.id, u.username, u.name, COALESCE(a.granted, 1) AS granted, COALESCE(a.user_on, 1) AS userOn FROM users u LEFT JOIN module_access a ON a.user_id = u.id AND a.module_id = ? WHERE u.disabled = 0 ORDER BY u.username").all(id)
      .map((u) => ({ id: u.id, username: u.username, name: u.name, granted: !!u.granted, on: !!u.userOn }));
  }

  // What the web app needs to know about the signed-in user's modules (part of /api/me).
  function payloadFor(user) {
    const mods = [];
    for (const r of rows()) {
      if (!r.enabled || r.status !== 'installed' || !loaded.has(r.id)) continue;
      const lm = loaded.get(r.id).manifest;
      if (lm.kind === 'language') {   // languages are for everyone: no grant, no personal switch
        mods.push({ id: r.id, name: r.name, kind: 'language', version: r.version, description: lm.description, on: true, slots: [], web: null, css: null, i18n: null,
          lang: { code: lm.code, nativeName: lm.nativeName, dir: lm.dir, locale: lm.locale }, strings: `/api/modules/${r.id}/asset/strings.json?v=${encodeURIComponent(r.version)}` });
        continue;
      }
      const a = accessRow(user.id, r.id);
      if (a && a.granted === 0) continue;
      const m = loaded.get(r.id).manifest, on = !a || a.user_on === 1, v = encodeURIComponent(r.version);
      mods.push({
        id: r.id, name: r.name, kind: r.kind, version: r.version, description: m.description, on, slots: m.slots,
        web: on && m.web ? `/api/modules/${r.id}/asset/web.js?v=${v}` : null,
        css: on && m.css ? `/api/modules/${r.id}/asset/web.css?v=${v}` : null,
        i18n: on && m.i18n ? `/api/modules/${r.id}/asset/i18n.json?v=${v}` : null,
      });
    }
    const caps = [...new Set(providers.filter((p) => available(user.id, p.moduleId)).map((p) => p.capability))];
    return { modules: mods, capabilities: caps };
  }

  // Language codes a user may choose: English (built in) plus every enabled language module.
  const languageCodes = () => ['en', ...rows().filter((r) => r.enabled && r.status === 'installed' && loaded.has(r.id) && loaded.get(r.id).manifest.kind === 'language').map((r) => loaded.get(r.id).manifest.code)];
  const isLanguage = (id) => loaded.get(id)?.manifest.kind === 'language';
  // Feature modules follow the per-user rules; language modules are open to every signed-in user while enabled.
  const assetAllowed = (userId, id) => (isLanguage(id) ? enabledLive(id) : available(userId, id));

  const providerFor = (capability, userId) => providers.find((p) => p.capability === capability && available(userId, p.moduleId))?.impl ?? null;

  function assetFor(id, name) {
    const l = loaded.get(id);
    if (!l) return null;
    const file = { 'web.js': l.manifest.web, 'web.css': l.manifest.css, 'i18n.json': l.manifest.i18n, 'strings.json': l.manifest.strings }[name];
    if (!file) return null;
    const abs = path.join(l.dir, file);
    return fs.existsSync(abs) ? abs : null;
  }

  return {
    events, core, load, rows, row, describe, loaded, providers, root,
    inspectFiles, installFiles, stageZip, installStaged, bundledAvailable, installBundled,
    setEnabled, uninstall, rollback, setGranted, setUserOn, accessList, accessRow,
    available, enabledLive, payloadFor, providerFor, assetFor, languageCodes, isLanguage, assetAllowed,
    capabilityProviders: (capability) => providers.filter((p) => p.capability === capability).map((p) => p.moduleId),
  };
}
