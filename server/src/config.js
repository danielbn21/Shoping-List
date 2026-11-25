// The admin configuration as one thing (1.9.0): what the settings are and may be, a snapshot of them, saved checkpoints and restore.
//
// A snapshot holds the core settings (never the SMTP password), which modules are enabled, and the settings each module declares as
// configuration in its manifest (`config`). It never holds users, households, lists, personal keys, or anything a module stores about
// the household's things, and a restore never installs or removes a module or touches its data.
import { getSetting, setSetting, audit } from './util.js';

export const FORMAT = 'shoplist-config';
export const FORMAT_VERSION = 1;
const KEEP_AUTO = 30;   // automatic checkpoints kept; named ones and restore points are kept until the admin deletes them

// Core settings that may be saved and restored. Types: int (min..max), bool, enum (values), url, language, currency, smtp, categories.
export const FIELDS = {
  registration_mode: { type: 'enum', values: ['open', 'invite-only', 'admin-only'] },
  session_days: { type: 'int', min: 1, max: 3650 },
  min_password_length: { type: 'int', min: 6, max: 64 },
  app_url: { type: 'url' },
  match_strictness: { type: 'enum', values: ['loose', 'normal', 'strict'] },
  allow_user_households: { type: 'bool' },
  estimates_default: { type: 'bool' },
  default_language: { type: 'language' },
  default_currency: { type: 'currency' },
  max_image_mb: { type: 'int', min: 1, max: 50, group: 'limits' },
  max_module_mb: { type: 'int', min: 1, max: 100, group: 'limits' },
  max_csv_mb: { type: 'int', min: 1, max: 20, group: 'limits' },
  max_trip_lines: { type: 'int', min: 10, max: 1000, group: 'limits' },
  rl_login_per_min: { type: 'int', min: 1, max: 100, group: 'abuse' },
  rl_register_per_min: { type: 'int', min: 1, max: 100, group: 'abuse' },
  rl_forgot_per_min: { type: 'int', min: 1, max: 60, group: 'abuse' },
  rl_reset_per_min: { type: 'int', min: 1, max: 100, group: 'abuse' },
  invite_default_days: { type: 'int', min: 1, max: 365, group: 'abuse' },
  invite_max_days: { type: 'int', min: 1, max: 3650, group: 'abuse' },
  invite_max_uses: { type: 'int', min: 1, max: 1000, group: 'abuse' },
  smtp: { type: 'smtp' },
  default_categories: { type: 'categories' },
};
// What a settings screen needs to draw a field (the ranges live here only).
export const fieldMeta = () => Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { type: f.type, min: f.min, max: f.max, values: f.values, group: f.group }]));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bad = { error: 'invalid_value' };

// One value against its definition. ctx: { languageCodes() }. current: the value now (smtp keeps its password through a restore).
export function normalizeValue(def, raw, current, ctx = {}) {
  switch (def.type) {
    case 'int': { const n = Number(raw); return Number.isInteger(n) && n >= def.min && n <= def.max ? { value: n } : bad; }
    case 'bool': return typeof raw === 'boolean' ? { value: raw } : (raw === 0 || raw === 1 ? { value: !!raw } : bad);
    case 'enum': return def.values.includes(raw) ? { value: raw } : bad;
    case 'url': { const u = String(raw ?? '').trim(); return !u || /^https?:\/\/[^\s]+$/.test(u) ? { value: u } : bad; }
    case 'language': return raw === 'en' || (ctx.languageCodes?.() ?? []).includes(raw) ? { value: raw } : bad;
    case 'currency': return raw === 'auto' || (typeof raw === 'string' && /^[A-Z]{3}$/.test(raw)) ? { value: raw } : bad;
    case 'categories': {
      const ok = Array.isArray(raw) && raw.length <= 60 && raw.every((c) => c && typeof c.en === 'string' && typeof c.he === 'string' && c.en && c.he);
      return ok ? { value: raw.map((c) => ({ en: c.en.slice(0, 60), he: c.he.slice(0, 60) })) } : bad;
    }
    case 'smtp': {
      const s = raw && typeof raw === 'object' ? raw : null;
      if (!s) return bad;
      const cur = current || {};
      const port = s.port === undefined ? cur.port : Number(s.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return bad;
      return { value: {
        host: String(s.host ?? cur.host ?? '').trim(), port, secure: s.secure !== undefined ? !!s.secure : !!cur.secure,
        user: String(s.user ?? cur.user ?? '').trim(),
        pass: s.pass === undefined || s.pass === '********' ? (cur.pass ?? '') : String(s.pass),   // a file or a checkpoint never carries it: the one the server has stays
        from: String(s.from ?? cur.from ?? '').trim(),
      } };
    }
    default: return bad;
  }
}

export function createConfig(app) {
  const db = app.db;
  const ctx = { languageCodes: () => app.modules.languageCodes() };
  const recent = new Map();   // coalesce key -> when an automatic checkpoint was last taken for it

  const rows = () => app.modules.rows().filter((r) => r.status === 'installed' || r.status === 'quarantined');

  // The configuration as it is now.
  function snapshot() {
    const core = {};
    for (const k of Object.keys(FIELDS)) {
      let v = getSetting(db, k);
      if (k === 'smtp') { v = { ...v }; delete v.pass; }
      core[k] = v;
    }
    const modules = {};
    for (const r of rows()) modules[r.id] = { enabled: !!r.enabled, version: r.version, settings: app.modules.readConfig(r.id) };
    return { format: FORMAT, formatVersion: FORMAT_VERSION, appVersion: app.coreVersion, createdAt: Date.now(), core, modules, omitted: ['smtp.pass'] };
  }

  // What restoring `data` would do, without doing it:
  //   { changes: [{ key, from, to }], skipped: [{ key, reason }], warnings: [{ code, detail }], core, enabled, moduleSettings } or { error }
  function plan(data) {
    if (!data || typeof data !== 'object' || data.format !== FORMAT) return { error: 'not_a_config_file' };
    if (!Number.isInteger(data.formatVersion) || data.formatVersion < 1) return { error: 'not_a_config_file' };
    if (data.formatVersion > FORMAT_VERSION) return { error: 'config_too_new' };
    const out = { changes: [], skipped: [], warnings: [], core: {}, enabled: {}, moduleSettings: {} };
    const note = (key, from, to) => out.changes.push({ key, from, to });

    for (const [k, raw] of Object.entries(data.core && typeof data.core === 'object' ? data.core : {})) {
      const def = FIELDS[k];
      if (!def) { out.skipped.push({ key: k, reason: 'unknown_setting' }); continue; }
      const cur = getSetting(db, k);
      const r = normalizeValue(def, raw, cur, ctx);
      if (r.error) { out.skipped.push({ key: k, reason: 'invalid_value' }); continue; }
      if (k === 'smtp') {
        for (const f of ['host', 'port', 'secure', 'user', 'from']) if (!same(cur[f], r.value[f])) note(`smtp.${f}`, cur[f], r.value[f]);
        if (['host', 'port', 'secure', 'user', 'from'].some((f) => !same(cur[f], r.value[f]))) out.core[k] = r.value;
      } else if (!same(cur, r.value)) { note(k, cur, r.value); out.core[k] = r.value; }
    }

    for (const [id, m] of Object.entries(data.modules && typeof data.modules === 'object' ? data.modules : {})) {
      const row = app.modules.row(id);
      if (!row || row.status === 'removed') { out.skipped.push({ key: `module:${id}`, reason: 'module_not_installed' }); continue; }
      if (m && typeof m.version === 'string' && m.version !== row.version) out.warnings.push({ code: 'module_version_differs', detail: `${id}: ${m.version} → ${row.version}` });
      if (m && typeof m.enabled === 'boolean' && m.enabled !== !!row.enabled) { out.enabled[id] = m.enabled; note(`module:${id}:enabled`, !!row.enabled, m.enabled); }
      const defs = app.modules.configDefs(id);
      const have = app.modules.readConfig(id);
      for (const [k, raw] of Object.entries(m && m.settings && typeof m.settings === 'object' ? m.settings : {})) {
        const def = defs[k];
        if (!def) { out.skipped.push({ key: `module:${id}:${k}`, reason: 'unknown_setting' }); continue; }
        if (have === null) { out.skipped.push({ key: `module:${id}:${k}`, reason: 'module_not_running' }); continue; }
        const r = normalizeValue(def, raw, have[k], ctx);
        if (r.error) { out.skipped.push({ key: `module:${id}:${k}`, reason: 'invalid_value' }); continue; }
        if (!same(have[k], r.value)) { note(`module:${id}:${k}`, have[k], r.value); (out.moduleSettings[id] ??= {})[k] = r.value; }
      }
    }
    return out;
  }

  const saveRow = ({ kind, name = null, keys = null, actorId = null, data }) => {
    const id = Number(db.prepare('INSERT INTO config_checkpoints(created_at, created_by, kind, name, keys, data) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), actorId, kind, name, keys ? JSON.stringify(keys) : null, JSON.stringify(data)).lastInsertRowid);
    const old = db.prepare("SELECT id FROM config_checkpoints WHERE kind = 'auto' ORDER BY id DESC LIMIT -1 OFFSET ?").all(KEEP_AUTO);
    for (const o of old) db.prepare('DELETE FROM config_checkpoints WHERE id = ?').run(o.id);
    return id;
  };

  return {
    snapshot, plan, fieldMeta,
    // Named checkpoint of the configuration as it is.
    save(name, actorId) { return saveRow({ kind: 'named', name: String(name ?? '').trim().slice(0, 80) || null, actorId, data: snapshot() }); },
    // Called just before something changes the configuration; keys say what is about to change. A change that sets several keys in one go
    // (a module's settings) passes a coalesce key so that only the first of them takes a checkpoint.
    autoBefore(keys, actorId = null, coalesce = null) {
      if (coalesce) {
        const t = recent.get(coalesce);
        if (t && Date.now() - t < 2000) return null;
        recent.set(coalesce, Date.now());
      }
      return saveRow({ kind: 'auto', keys, actorId, data: snapshot() });
    },
    list() {
      return db.prepare(`SELECT c.id, c.created_at, c.kind, c.name, c.keys, c.created_by, u.name AS by_name FROM config_checkpoints c
        LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id DESC`).all()
        .map((r) => ({ id: r.id, createdAt: r.created_at, kind: r.kind, name: r.name, keys: r.keys ? JSON.parse(r.keys) : [], by: r.by_name ?? null }));
    },
    get(id) { const r = db.prepare('SELECT data FROM config_checkpoints WHERE id = ?').get(Number(id)); try { return r ? JSON.parse(r.data) : null; } catch { return null; } },
    remove(id) { return db.prepare('DELETE FROM config_checkpoints WHERE id = ?').run(Number(id)).changes > 0; },

    // Makes the configuration what `p` (from plan()) says. A restore point of the current configuration is saved first, so a restore can be undone.
    apply(p, actorId) {
      const restoreId = saveRow({ kind: 'restore', keys: p.changes.map((c) => c.key), actorId, data: snapshot() });
      db.transaction(() => { for (const [k, v] of Object.entries(p.core)) setSetting(db, k, v); })();
      for (const [id, v] of Object.entries(p.moduleSettings)) app.modules.writeConfig(id, v);
      const failed = [];
      for (const [id, on] of Object.entries(p.enabled)) {
        try { app.modules.setEnabled(id, on, actorId); } catch (e) { failed.push({ key: `module:${id}:enabled`, reason: e.code || 'failed' }); }
      }
      audit(db, actorId, 'admin.config_restored', null, { changes: p.changes.length, restorePoint: restoreId, failed: failed.length });
      return { restorePointId: restoreId, failed };
    },
  };
}
