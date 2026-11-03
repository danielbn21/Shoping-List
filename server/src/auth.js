import { hashToken, newToken, getSetting, deviceLabel } from './util.js';

export const COOKIE = 'sl_session';

export function setSessionCookie(reply, req, token, days) {
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: req.protocol === 'https',
    maxAge: days * 86400,
  });
}

export function createSession(app, req, reply, userId) {
  const token = newToken();
  const days = getSetting(app.db, 'session_days');
  const now = Date.now();
  const ua = String(req.headers['user-agent'] || '');
  app.db.prepare(`INSERT INTO sessions(user_id, token_hash, device_label, user_agent, ip, created_at, last_seen_at, expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(userId, hashToken(token), deviceLabel(ua), ua.slice(0, 300), req.ip, now, now, now + days * 86400000);
  app.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId);
  setSessionCookie(reply, req, token, days);
}

export function revokeSessions(db, userId, exceptSessionId = null) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?').run(userId, exceptSessionId ?? -1);
}

export function registerAuth(app) {
  const db = app.db;
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  // Usage: preHandler: app.auth() | app.auth({ admin: true }) | app.auth({ allowPending: true })
  app.decorate('auth', (opts = {}) => async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: 'not_authenticated' });
    const row = db.prepare(`SELECT s.id AS sid, s.last_seen_at AS s_seen, s.expires_at AS s_exp, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked = 0`).get(hashToken(token));
    const now = Date.now();
    if (!row || row.s_exp < now || row.disabled) {
      reply.clearCookie(COOKIE, { path: '/' });
      return reply.code(401).send({ error: 'not_authenticated' });
    }
    if (row.must_change_password && !opts.allowPending) return reply.code(403).send({ error: 'password_change_required' });
    if (opts.admin && row.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    if (now - row.s_seen > 5 * 60 * 1000) {
      // sliding expiry: active devices stay logged in
      const days = getSetting(db, 'session_days');
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, now + days * 86400000, row.sid);
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      setSessionCookie(reply, req, token, days);
    }
    req.user = row;
    req.sessionId = row.sid;
  });
}
