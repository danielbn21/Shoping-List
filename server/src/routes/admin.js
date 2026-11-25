import {
  hashPassword, generateOneTimePassword, audit, createHousehold, createUser,
  validUsername, validEmail, cleanName, allSettings, getSetting, setSetting,
} from '../util.js';
import { revokeSessions } from '../auth.js';
import { FIELDS, fieldMeta, normalizeValue } from '../config.js';
import { sendMail } from '../mail.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default async function adminRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth({ admin: true }) };
  const otherActiveAdmins = (excludeId) =>
    db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(excludeId).c;

  // ---- users ----
  app.get('/api/admin/users', pre, async () => {
    const rows = db.prepare(`SELECT u.id, u.username, u.email, u.name, u.role, u.disabled, u.must_change_password, u.created_at, u.last_seen_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked = 0 AND s.expires_at > ?) AS devices,
      (SELECT COUNT(*) FROM list_entries e WHERE e.added_by = u.id) AS items_added,
      (SELECT COUNT(*) FROM purchase_events p WHERE p.buyer_id = u.id) AS purchases,
      (SELECT group_concat(h.name, ', ') FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.user_id = u.id) AS households
      FROM users u ORDER BY u.id`).all(Date.now());
    const memberships = db.prepare('SELECT m.user_id, m.role, h.id, h.name FROM household_members m JOIN households h ON h.id = m.household_id ORDER BY h.id').all();   // since 1.8.1
    return {
      users: rows.map((r) => ({
        id: r.id, username: r.username, email: r.email, name: r.name, role: r.role,
        disabled: !!r.disabled, mustChangePassword: !!r.must_change_password,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, devices: r.devices,
        itemsAdded: r.items_added, purchases: r.purchases, households: r.households || '',
        householdList: memberships.filter((m) => m.user_id === r.id).map((m) => ({ id: m.id, name: m.name, role: m.role })),
      })),
    };
  });

  // Every household with its members and what is in it (1.8.1). The id and name fields are what the create-user form has always used.
  app.get('/api/admin/households', pre, async () => {
    const members = db.prepare(`SELECT m.household_id, m.role, u.id, u.name, u.username, u.disabled FROM household_members m
      JOIN users u ON u.id = m.user_id ORDER BY m.role = 'owner' DESC, u.name COLLATE NOCASE`).all();
    const one = (sql, hid) => db.prepare(sql).get(hid).c;
    return {
      households: db.prepare('SELECT id, name, created_at FROM households ORDER BY id').all().map((h) => ({
        id: h.id, name: h.name, createdAt: h.created_at,
        members: members.filter((m) => m.household_id === h.id).map((m) => ({ userId: m.id, name: m.name, username: m.username, role: m.role, disabled: !!m.disabled })),
        counts: {
          lists: one('SELECT COUNT(*) c FROM lists WHERE household_id = ?', h.id),
          items: one('SELECT COUNT(*) c FROM items WHERE household_id = ? AND archived = 0', h.id),
          trips: one('SELECT COUNT(*) c FROM trips WHERE household_id = ? AND finished_at IS NOT NULL', h.id),
          receipts: one('SELECT COUNT(*) c FROM receipts WHERE household_id = ?', h.id),
        },
      })),
    };
  });

  // Create a household for a chosen owner (1.8.1). The member, rename and delete routes in households.js already work for an admin on any household.
  app.post('/api/admin/households', pre, async (req, reply) => {
    const b = req.body || {};
    const name = cleanName(b.name);
    if (!name) return bad(reply, 'invalid_name');
    const ownerId = b.ownerId ? Number(b.ownerId) : req.user.id;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0').get(ownerId)) return bad(reply, 'user_not_found', 404);
    const id = db.transaction(() => createHousehold(db, name, ownerId))();
    audit(db, req.user.id, 'household.created', String(id), { owner: ownerId, by: 'admin' });
    return { id };
  });

  // Create a user. If no password is supplied, a one-time password is generated and returned once.
  app.post('/api/admin/users', pre, async (req, reply) => {
    const b = req.body || {};
    const name = cleanName(b.name);
    if (!name) return bad(reply, 'invalid_name');
    if (!validUsername(b.username)) return bad(reply, 'invalid_username');
    if (b.email && !validEmail(b.email)) return bad(reply, 'invalid_email');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) return bad(reply, 'username_taken', 409);
    if (b.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) return bad(reply, 'email_taken', 409);
    const role = b.role === 'admin' ? 'admin' : 'user';
    const generated = !b.password;
    const password = generated ? generateOneTimePassword() : String(b.password);
    if (!generated && password.length < getSetting(db, 'min_password_length')) return bad(reply, 'password_short');
    const hash = await hashPassword(password);
    const id = db.transaction(() => {
      const uid = createUser(db, { username: b.username, name, email: b.email, passwordHash: hash, role, mustChange: 1, language: app.modules.languageCodes().includes(b.language) ? b.language : (app.modules.languageCodes().includes(getSetting(db, 'default_language')) ? getSetting(db, 'default_language') : 'en') });
      if (b.householdId) {
        if (!db.prepare('SELECT 1 FROM households WHERE id = ?').get(Number(b.householdId))) throw Object.assign(new Error('household_not_found'), { code: 'household_not_found' });
        db.prepare("INSERT INTO household_members(household_id, user_id, role) VALUES (?,?,'member')").run(Number(b.householdId), uid);
      } else {
        createHousehold(db, cleanName(b.newHouseholdName) || name, uid);
      }
      audit(db, req.user.id, 'admin.user_created', b.username);
      return uid;
    })();
    return { id, oneTimePassword: generated ? password : undefined };
  });

  app.patch('/api/admin/users/:id', pre, async (req, reply) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const newRole = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'user') : target.role;
    const newDisabled = b.disabled !== undefined ? (b.disabled ? 1 : 0) : target.disabled;
    const losesAdmin = target.role === 'admin' && !target.disabled && (newRole !== 'admin' || newDisabled);
    if (losesAdmin && otherActiveAdmins(id) === 0) return bad(reply, 'last_admin', 409);
    const name = b.name !== undefined ? cleanName(b.name) : target.name;
    if (!name) return bad(reply, 'invalid_name');
    if (b.email && !validEmail(b.email)) return bad(reply, 'invalid_email');
    const email = b.email !== undefined ? (b.email || null) : target.email;
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, disabled = ? WHERE id = ?').run(name, email, newRole, newDisabled, id);
    if (newDisabled) revokeSessions(db, id);
    audit(db, req.user.id, 'admin.user_updated', target.username, { role: newRole, disabled: !!newDisabled });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', pre, async (req, reply) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return bad(reply, 'not_found', 404);
    const otp = generateOneTimePassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await hashPassword(otp), id);
    revokeSessions(db, id);
    audit(db, req.user.id, 'admin.password_reset', target.username);
    return { oneTimePassword: otp };
  });

  app.delete('/api/admin/users/:id', pre, async (req, reply) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return bad(reply, 'not_found', 404);
    if (id === req.user.id) return bad(reply, 'cannot_delete_self', 409);
    if (target.role === 'admin' && !target.disabled && otherActiveAdmins(id) === 0) return bad(reply, 'last_admin', 409);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    app.modules.events.emit('user.deleted', { userId: id });
    audit(db, req.user.id, 'admin.user_deleted', target.username);
    return { ok: true };
  });

  // ---- settings ----
  const maskSettings = (s) => ({ ...s, smtp: { ...s.smtp, pass: s.smtp.pass ? '********' : '' } });
  app.get('/api/admin/settings', pre, async () => ({
    settings: maskSettings(allSettings(db)),
    fields: fieldMeta(),   // the allowed ranges, so the screen draws them from the one place
    languages: ['en', ...app.modules.languageCodes()],
    server: {   // fixed when the server starts (Docker environment); shown, not editable
      version: app.coreVersion, node: process.version, port: process.env.PORT ?? '3000', dataDir: app.dataDir, modulesDir: app.modules.root,
      ocrLangs: process.env.OCR_LANGS || 'heb+eng', webDir: process.env.WEB_DIR || '',
    },
  }));

  app.put('/api/admin/settings', pre, async (req, reply) => {
    // every value goes through the schema in config.js (the same checks a restore uses); what really changes gets a checkpoint first
    const b = req.body || {};
    const next = {};
    for (const [k, v] of Object.entries(b)) {
      if (!FIELDS[k]) continue;
      const cur = getSetting(db, k);
      const r = normalizeValue(FIELDS[k], k === 'smtp' ? { ...cur, ...(v && typeof v === 'object' ? v : {}), ...(v && v.port !== undefined ? { port: Number(v.port) || 587 } : {}) } : v, cur, { languageCodes: () => app.modules.languageCodes() });
      if (r.error) return bad(reply, 'invalid_value');
      if (JSON.stringify(cur) !== JSON.stringify(r.value)) next[k] = r.value;
    }
    const keys = Object.keys(next);
    if (keys.length) {
      app.config.autoBefore(keys, req.user.id);
      for (const [k, v] of Object.entries(next)) setSetting(db, k, v);
    }
    audit(db, req.user.id, 'admin.settings_updated', null, { keys: Object.keys(b) });
    return { settings: maskSettings(allSettings(db)) };
  });


  app.post('/api/admin/settings/test-email', pre, async (req, reply) => {
    const to = String((req.body || {}).to || '');
    if (!validEmail(to)) return bad(reply, 'invalid_email');
    try {
      await sendMail(db, { to, subject: 'Shopping list: test email', text: 'SMTP is working. / שליחת הדוא"ל פועלת.' });
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: 'smtp_failed', detail: String(e.message).slice(0, 200) });
    }
  });

  app.get('/api/admin/audit', pre, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    return { entries: db.prepare(`SELECT a.id, a.ts, a.action, a.target, a.detail, u.username AS actor
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`).all(limit) };
  });
}
