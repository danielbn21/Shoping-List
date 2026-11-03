import {
  hashPassword, generateOneTimePassword, audit, createHousehold, createUser,
  validUsername, validEmail, cleanName, allSettings, getSetting, setSetting,
} from '../util.js';
import { revokeSessions } from '../auth.js';
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
    return {
      users: rows.map((r) => ({
        id: r.id, username: r.username, email: r.email, name: r.name, role: r.role,
        disabled: !!r.disabled, mustChangePassword: !!r.must_change_password,
        createdAt: r.created_at, lastSeenAt: r.last_seen_at, devices: r.devices,
        itemsAdded: r.items_added, purchases: r.purchases, households: r.households || '',
      })),
    };
  });

  app.get('/api/admin/households', pre, async () => ({
    households: db.prepare('SELECT id, name FROM households ORDER BY id').all(),
  }));

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
      const uid = createUser(db, { username: b.username, name, email: b.email, passwordHash: hash, role, mustChange: 1, language: b.language === 'he' ? 'he' : 'en' });
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
    audit(db, req.user.id, 'admin.user_deleted', target.username);
    return { ok: true };
  });

  // ---- settings ----
  const maskSettings = (s) => ({ ...s, smtp: { ...s.smtp, pass: s.smtp.pass ? '********' : '' } });
  app.get('/api/admin/settings', pre, async () => ({ settings: maskSettings(allSettings(db)) }));

  app.put('/api/admin/settings', pre, async (req, reply) => {
    const b = req.body || {};
    if (b.registration_mode !== undefined) {
      if (!['open', 'invite-only', 'admin-only'].includes(b.registration_mode)) return bad(reply, 'invalid_value');
      setSetting(db, 'registration_mode', b.registration_mode);
    }
    if (b.session_days !== undefined) {
      const n = Number(b.session_days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) return bad(reply, 'invalid_value');
      setSetting(db, 'session_days', n);
    }
    if (b.ocr_enabled !== undefined) setSetting(db, 'ocr_enabled', !!b.ocr_enabled);
    if (b.allow_user_households !== undefined) setSetting(db, 'allow_user_households', !!b.allow_user_households);
    if (b.min_password_length !== undefined) {
      const n = Number(b.min_password_length);
      if (!Number.isInteger(n) || n < 6 || n > 64) return bad(reply, 'invalid_value');
      setSetting(db, 'min_password_length', n);
    }
    if (b.app_url !== undefined) {
      const u = String(b.app_url).trim();
      if (u && !/^https?:\/\/[^\s]+$/.test(u)) return bad(reply, 'invalid_value');
      setSetting(db, 'app_url', u);
    }
    if (b.match_strictness !== undefined) {
      if (!['loose', 'normal', 'strict'].includes(b.match_strictness)) return bad(reply, 'invalid_value');
      setSetting(db, 'match_strictness', b.match_strictness);
    }
    if (b.default_categories !== undefined) {
      const ok = Array.isArray(b.default_categories) && b.default_categories.every((c) => c && typeof c.en === 'string' && typeof c.he === 'string' && c.en && c.he);
      if (!ok) return bad(reply, 'invalid_value');
      setSetting(db, 'default_categories', b.default_categories.map((c) => ({ en: c.en.slice(0, 60), he: c.he.slice(0, 60) })));
    }
    if (b.smtp !== undefined) {
      const cur = getSetting(db, 'smtp');
      const s = b.smtp || {};
      const next = {
        host: String(s.host ?? cur.host).trim(),
        port: Number(s.port ?? cur.port) || 587,
        secure: s.secure !== undefined ? !!s.secure : cur.secure,
        user: String(s.user ?? cur.user).trim(),
        pass: s.pass === undefined || s.pass === '********' ? cur.pass : String(s.pass),
        from: String(s.from ?? cur.from).trim(),
      };
      setSetting(db, 'smtp', next);
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
