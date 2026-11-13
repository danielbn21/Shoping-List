import {
  hashPassword, verifyPassword, DUMMY_HASH, hashToken, newToken, getSetting, audit,
  createHousehold, createUser, validUsername, validEmail, cleanName,
  generateInviteCode, normalizeCode,
} from '../util.js';
import { createSession, revokeSessions, COOKIE } from '../auth.js';
import { isSmtpConfigured, sendMail } from '../mail.js';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default async function authRoutes(app) {
  const db = app.db;
  const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const minLen = () => getSetting(db, 'min_password_length');
  const pwOk = (pw) => typeof pw === 'string' && pw.length >= minLen() && pw.length <= 200;

  app.get('/api/public-config', async () => ({
    needsSetup: userCount() === 0,
    registrationMode: getSetting(db, 'registration_mode'),
    emailResetAvailable: isSmtpConfigured(db),
    minPasswordLength: minLen(),
    version: VERSION,
  }));

  // ---- first run: create the initial admin ----
  app.post('/api/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (userCount() > 0) return bad(reply, 'already_setup', 409);
    const b = req.body || {};
    const name = cleanName(b.name);
    if (!name) return bad(reply, 'invalid_name');
    if (!validUsername(b.username)) return bad(reply, 'invalid_username');
    if (b.email && !validEmail(b.email)) return bad(reply, 'invalid_email');
    if (!pwOk(b.password)) return bad(reply, 'password_short');
    const hash = await hashPassword(b.password);
    const uid = db.transaction(() => {
      const id = createUser(db, { username: b.username, name, email: b.email, passwordHash: hash, role: 'admin', language: app.modules.languageCodes().includes(b.language) ? b.language : 'en' });
      createHousehold(db, cleanName(b.householdName) || `${name}`, id);
      audit(db, id, 'setup.admin_created', b.username);
      return id;
    })();
    createSession(app, req, reply, uid);
    return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)) };
  });

  // ---- login / logout ----
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { login, password } = req.body || {};
    if (typeof login !== 'string' || typeof password !== 'string') return bad(reply, 'invalid_credentials', 401);
    const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login.trim(), login.trim());
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) return bad(reply, 'invalid_credentials', 401);
    if (u.disabled) return bad(reply, 'account_disabled', 403);
    createSession(app, req, reply, u.id);
    audit(db, u.id, 'auth.login');
    return { user: app.userPayload(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(hashToken(token));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- registration (admin-controlled mode) ----
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const mode = getSetting(db, 'registration_mode');
    if (mode === 'admin-only') return bad(reply, 'registration_closed', 403);
    const b = req.body || {};
    let invite = null;
    const code = normalizeCode(b.inviteCode);
    if (code) {
      invite = db.prepare(`SELECT * FROM invites WHERE code = ? AND revoked = 0
        AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)`).get(code, Date.now());
      if (!invite) return bad(reply, 'invalid_invite', 400);
    } else if (mode !== 'open') {
      return bad(reply, 'invite_required', 403);
    }
    const name = cleanName(b.name);
    if (!name) return bad(reply, 'invalid_name');
    if (!validUsername(b.username)) return bad(reply, 'invalid_username');
    if (b.email && !validEmail(b.email)) return bad(reply, 'invalid_email');
    if (!pwOk(b.password)) return bad(reply, 'password_short');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(b.username)) return bad(reply, 'username_taken', 409);
    if (b.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email)) return bad(reply, 'email_taken', 409);
    const hash = await hashPassword(b.password);
    const uid = db.transaction(() => {
      const id = createUser(db, { username: b.username, name, email: b.email, passwordHash: hash, language: app.modules.languageCodes().includes(b.language) ? b.language : 'en' });
      if (invite && invite.scope === 'household') {
        db.prepare("INSERT INTO household_members(household_id, user_id, role) VALUES (?,?,'member')").run(invite.household_id, id);
      } else {
        createHousehold(db, name, id); // no household invite: user gets their own household
      }
      if (invite) db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(invite.id);
      audit(db, id, 'auth.registered', b.username, { invite: invite?.id ?? null });
      return id;
    })();
    createSession(app, req, reply, uid);
    return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(uid)) };
  });

  // ---- password reset by email (only works when SMTP is configured) ----
  app.post('/api/auth/forgot', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const login = String((req.body || {}).login || '').trim();
    // Always answer "ok" so this endpoint cannot be used to discover accounts.
    if (!login || !isSmtpConfigured(db)) return { ok: true };
    const u = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND disabled = 0').get(login, login);
    if (!u || !u.email) return { ok: true };
    const token = newToken();
    db.prepare('INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES (?,?,?)')
      .run(u.id, hashToken(token), Date.now() + 60 * 60 * 1000);
    const base = getSetting(db, 'app_url') || `${req.protocol}://${req.headers.host}`;
    sendMail(db, {
      to: u.email,
      subject: 'Reset your shopping list password / איפוס סיסמה',
      text: `Reset your password (valid for 1 hour):\n${base.replace(/\/$/, '')}/reset?token=${token}\n\nאיפוס סיסמה (בתוקף לשעה):\n${base.replace(/\/$/, '')}/reset?token=${token}\n`,
    }).catch((e) => req.log.error({ err: e.message }, 'reset email failed'));
    audit(db, u.id, 'auth.reset_requested');
    return { ok: true };
  });

  app.post('/api/auth/reset', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token, password } = req.body || {};
    if (typeof token !== 'string') return bad(reply, 'invalid_token');
    if (!pwOk(password)) return bad(reply, 'password_short');
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?').get(hashToken(token), Date.now());
    if (!r) return bad(reply, 'invalid_token');
    const hash = await hashPassword(password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, r.user_id);
      db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ?').run(r.user_id);
      revokeSessions(db, r.user_id);
      audit(db, r.user_id, 'auth.password_reset');
    })();
    return { ok: true };
  });

  // ---- change password (also completes the one-time-password flow) ----
  app.post('/api/auth/change-password', { preHandler: app.auth({ allowPending: true }) }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!(await verifyPassword(String(currentPassword || ''), req.user.password_hash))) return bad(reply, 'wrong_password', 403);
    if (!pwOk(newPassword)) return bad(reply, 'password_short');
    if (newPassword === currentPassword) return bad(reply, 'password_same');
    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.user.id);
    revokeSessions(db, req.user.id, req.sessionId); // sign out other devices
    audit(db, req.user.id, 'auth.password_changed');
    return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  });

  // ---- profile ----
  app.get('/api/me', { preHandler: app.auth({ allowPending: true }) }, async (req) => ({ user: app.userPayload(req.user) }));

  // Interface preferences that follow the user across devices: the order of the Manage list sections and which are left open.
  // Send only the keys to change; null removes a key.
  const KEY = /^[A-Za-z0-9_.:-]{1,80}$/;
  app.put('/api/me/prefs', { preHandler: app.auth() }, async (req, reply) => {
    const b = req.body || {};
    const cur = (() => { try { return JSON.parse(req.user.ui_prefs || '{}'); } catch { return {}; } })();
    if (b.manageOrder !== undefined) {
      if (b.manageOrder === null) delete cur.manageOrder;
      else if (!Array.isArray(b.manageOrder) || b.manageOrder.length > 40 || b.manageOrder.some((k) => typeof k !== 'string' || !KEY.test(k)) || new Set(b.manageOrder).size !== b.manageOrder.length) return bad(reply, 'invalid_value');
      else cur.manageOrder = b.manageOrder;
    }
    if (b.showEstimates !== undefined) {
      if (b.showEstimates === null) delete cur.showEstimates;   // back to the admin's default
      else if (typeof b.showEstimates !== 'boolean') return bad(reply, 'invalid_value');
      else cur.showEstimates = b.showEstimates;
    }
    if (b.manageOpen !== undefined) {
      if (b.manageOpen === null) delete cur.manageOpen;
      else if (typeof b.manageOpen !== 'object' || Array.isArray(b.manageOpen) || Object.keys(b.manageOpen).length > 60 || Object.entries(b.manageOpen).some(([k, v]) => !KEY.test(k) || typeof v !== 'boolean')) return bad(reply, 'invalid_value');
      else cur.manageOpen = { ...(cur.manageOpen || {}), ...b.manageOpen };
    }
    db.prepare('UPDATE users SET ui_prefs = ? WHERE id = ?').run(JSON.stringify(cur), req.user.id);
    return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  });

  app.patch('/api/me', { preHandler: app.auth() }, async (req, reply) => {
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return bad(reply, 'invalid_name'); sets.push('name = ?'); vals.push(n); }
    if (b.email !== undefined) {
      if (b.email && !validEmail(b.email)) return bad(reply, 'invalid_email');
      if (b.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(b.email, req.user.id)) return bad(reply, 'email_taken', 409);
      sets.push('email = ?'); vals.push(b.email || null);
    }
    if (b.language !== undefined) { if (!app.modules.languageCodes().includes(b.language)) return bad(reply, 'invalid_value'); sets.push('language = ?'); vals.push(b.language); }
    if (b.theme !== undefined) { if (!['system', 'light', 'dark'].includes(b.theme)) return bad(reply, 'invalid_value'); sets.push('theme = ?'); vals.push(b.theme); }
    if (b.colorTheme !== undefined) { if (!['green', 'blue', 'plum', 'orange'].includes(b.colorTheme)) return bad(reply, 'invalid_value'); sets.push('color_theme = ?'); vals.push(b.colorTheme); }
    if (b.currency !== undefined) {
      if (b.currency !== null && !/^[A-Z]{3}$/.test(b.currency)) return bad(reply, 'invalid_value');
      sets.push('currency = ?'); vals.push(b.currency);
    }
    if (b.showAddedBy !== undefined) { sets.push('show_added_by = ?'); vals.push(b.showAddedBy ? 1 : 0); }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.user.id);
    return { user: app.userPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  });

  // ---- devices (sessions) ----
  app.get('/api/devices', { preHandler: app.auth() }, async (req) => {
    const rows = db.prepare(`SELECT id, device_label, created_at, last_seen_at FROM sessions
      WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_seen_at DESC`).all(req.user.id, Date.now());
    return { devices: rows.map((r) => ({ id: r.id, label: r.device_label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === req.sessionId })) };
  });
  app.delete('/api/devices/:id', { preHandler: app.auth() }, async (req) => {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    return { ok: true };
  });

  // ---- household invites (owners and admins) ----
  const canInvite = (user, householdId) => user.role === 'admin' ||
    !!db.prepare("SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ? AND role = 'owner'").get(householdId, user.id);

  app.post('/api/invites', { preHandler: app.auth() }, async (req, reply) => {
    const b = req.body || {};
    const hid = Number(b.householdId);
    if (!hid || !canInvite(req.user, hid)) return bad(reply, 'forbidden', 403);
    const days = Math.min(Math.max(Number(b.expiresInDays) || 7, 1), 365);
    const maxUses = b.maxUses ? Math.min(Math.max(Number(b.maxUses), 1), 100) : null;
    const code = generateInviteCode();
    db.prepare(`INSERT INTO invites(code, scope, household_id, created_by, created_at, expires_at, max_uses)
      VALUES (?, 'household', ?, ?, ?, ?, ?)`).run(code, hid, req.user.id, Date.now(), Date.now() + days * 86400000, maxUses);
    audit(db, req.user.id, 'invite.created', String(hid));
    const base = getSetting(db, 'app_url') || `${req.protocol}://${req.headers.host}`;
    return { code, link: `${base.replace(/\/$/, '')}/join?code=${code}`, expiresInDays: days };
  });
}
