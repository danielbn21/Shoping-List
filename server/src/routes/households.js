import fs from 'node:fs';
import path from 'node:path';
import { audit, createHousehold, getSetting, cleanName } from '../util.js';
import { makeAccess } from '../access.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default async function householdRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { householdRole } = makeAccess(db);

  // The server admin can manage any household; otherwise you must be one of its owners.
  const isOwner = (user, hid) =>
    user.role === 'admin' ? !!db.prepare('SELECT 1 FROM households WHERE id = ?').get(hid) : householdRole(user.id, hid) === 'owner';
  const ownerCount = (hid, exceptUserId = -1) =>
    db.prepare("SELECT COUNT(*) c FROM household_members WHERE household_id = ? AND role = 'owner' AND user_id != ?").get(hid, exceptUserId).c;

  // ---- create / rename / delete ----
  app.post('/api/households', pre, async (req, reply) => {
    if (req.user.role !== 'admin' && !getSetting(db, 'allow_user_households')) return bad(reply, 'household_creation_disabled', 403);
    const name = cleanName((req.body || {}).name);
    if (!name) return bad(reply, 'invalid_name');
    const id = db.transaction(() => createHousehold(db, name, req.user.id))();
    audit(db, req.user.id, 'household.created', String(id));
    return { id };
  });

  app.patch('/api/households/:hid', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    const name = cleanName((req.body || {}).name);
    if (!name) return bad(reply, 'invalid_name');
    db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, hid);
    return { ok: true };
  });

  // Deleting wipes the household's lists, item bank and purchase history, so the name must be typed back.
  app.delete('/api/households/:hid', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    const h = db.prepare('SELECT * FROM households WHERE id = ?').get(hid);
    const confirm = String((req.body || {}).confirmName || '').trim().toLowerCase();
    if (!confirm || confirm !== h.name.trim().toLowerCase()) return bad(reply, 'name_mismatch');
    db.prepare('DELETE FROM households WHERE id = ?').run(hid);
    fs.rmSync(path.join(app.dataDir, 'receipts', String(hid)), { recursive: true, force: true });
    audit(db, req.user.id, 'household.deleted', h.name);
    return { ok: true };
  });

  // ---- members ----
  function removeMember(hid, targetId) {
    db.transaction(() => {
      // Lists the leaving person owned go to a remaining household owner so they are never orphaned.
      const heir = db.prepare("SELECT user_id FROM household_members WHERE household_id = ? AND role = 'owner' AND user_id != ? ORDER BY user_id").get(hid, targetId)?.user_id;
      if (heir) {
        db.prepare(`INSERT INTO list_members(list_id, user_id, role)
          SELECT lm.list_id, ?, 'owner' FROM list_members lm JOIN lists l ON l.id = lm.list_id
          WHERE lm.user_id = ? AND lm.role = 'owner' AND l.household_id = ?
          ON CONFLICT(list_id, user_id) DO UPDATE SET role = 'owner'`).run(heir, targetId, hid);
      }
      db.prepare('DELETE FROM list_members WHERE user_id = ? AND list_id IN (SELECT id FROM lists WHERE household_id = ?)').run(targetId, hid);
      db.prepare('DELETE FROM user_list_order WHERE user_id = ? AND list_id IN (SELECT id FROM lists WHERE household_id = ?)').run(targetId, hid);
      db.prepare('DELETE FROM user_household_order WHERE user_id = ? AND household_id = ?').run(targetId, hid);
      db.prepare('DELETE FROM household_members WHERE household_id = ? AND user_id = ?').run(hid, targetId);
    })();
  }

  // Add someone who already has an account, by their exact username.
  app.post('/api/households/:hid/members', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    const username = String((req.body || {}).username || '').trim();
    const u = username && db.prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(username);
    if (!u) return bad(reply, 'user_not_found', 404);
    if (householdRole(u.id, hid)) return bad(reply, 'already_member', 409);
    db.prepare("INSERT INTO household_members(household_id, user_id, role) VALUES (?,?,'member')").run(hid, u.id);
    audit(db, req.user.id, 'household.member_added', String(hid), { user: u.id });
    return { ok: true };
  });

  app.patch('/api/households/:hid/members/:uid', pre, async (req, reply) => {
    const hid = Number(req.params.hid), uid = Number(req.params.uid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    const role = (req.body || {}).role;
    if (!['owner', 'member'].includes(role)) return bad(reply, 'invalid_value');
    const cur = householdRole(uid, hid);
    if (!cur) return bad(reply, 'not_found', 404);
    if (cur === 'owner' && role === 'member' && ownerCount(hid, uid) === 0) return bad(reply, 'last_owner', 409);
    db.prepare('UPDATE household_members SET role = ? WHERE household_id = ? AND user_id = ?').run(role, hid, uid);
    return { ok: true };
  });

  app.delete('/api/households/:hid/members/:uid', pre, async (req, reply) => {
    const hid = Number(req.params.hid), uid = Number(req.params.uid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    if (uid === req.user.id) return bad(reply, 'use_leave');
    const cur = householdRole(uid, hid);
    if (!cur) return bad(reply, 'not_found', 404);
    if (cur === 'owner' && ownerCount(hid, uid) === 0) return bad(reply, 'last_owner', 409);
    removeMember(hid, uid);
    audit(db, req.user.id, 'household.member_removed', String(hid), { user: uid });
    return { ok: true };
  });

  app.post('/api/households/:hid/leave', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    const cur = householdRole(req.user.id, hid);
    if (!cur) return bad(reply, 'not_found', 404);
    const others = db.prepare('SELECT COUNT(*) c FROM household_members WHERE household_id = ? AND user_id != ?').get(hid, req.user.id).c;
    if (!others) return bad(reply, 'last_member', 409); // delete the household instead
    if (cur === 'owner' && ownerCount(hid, req.user.id) === 0) return bad(reply, 'last_owner', 409); // hand over ownership first
    removeMember(hid, req.user.id);
    return { ok: true };
  });

  // ---- invites (create lives in routes/auth.js) ----
  app.get('/api/households/:hid/invites', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!isOwner(req.user, hid)) return bad(reply, 'forbidden', 403);
    const rows = db.prepare(`SELECT id, code, expires_at, max_uses, uses FROM invites
      WHERE household_id = ? AND scope = 'household' AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC`).all(hid, Date.now());
    return { invites: rows.map((r) => ({ id: r.id, code: r.code, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses })) };
  });

  app.delete('/api/invites/:id', pre, async (req, reply) => {
    const inv = db.prepare('SELECT * FROM invites WHERE id = ?').get(Number(req.params.id));
    if (!inv || !inv.household_id) return bad(reply, 'not_found', 404);
    if (!isOwner(req.user, inv.household_id)) return bad(reply, 'forbidden', 403);
    db.prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(inv.id);
    return { ok: true };
  });

  // ---- personal ordering (each user arranges their own home screen) ----
  app.put('/api/households/order', pre, async (req, reply) => {
    const ids = (req.body || {}).ids;
    const mine = new Set(db.prepare('SELECT household_id FROM household_members WHERE user_id = ?').all(req.user.id).map((r) => r.household_id));
    if (!Array.isArray(ids) || !ids.every((i) => mine.has(Number(i)))) return bad(reply, 'invalid_value');
    db.transaction(() => ids.forEach((id, i) =>
      db.prepare('INSERT INTO user_household_order(user_id, household_id, position) VALUES (?,?,?) ON CONFLICT(user_id, household_id) DO UPDATE SET position = excluded.position').run(req.user.id, Number(id), i)))();
    return { ok: true };
  });

  app.put('/api/households/:hid/lists/order', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const ids = (req.body || {}).ids;
    const visible = new Set(db.prepare(`SELECT l.id FROM lists l WHERE l.household_id = ? AND l.archived = 0 AND (l.visibility = 'household'
      OR l.id IN (SELECT list_id FROM list_members WHERE user_id = ?))`).all(hid, req.user.id).map((r) => r.id));
    if (!Array.isArray(ids) || !ids.every((i) => visible.has(Number(i)))) return bad(reply, 'invalid_value');
    db.transaction(() => ids.forEach((id, i) =>
      db.prepare('INSERT INTO user_list_order(user_id, list_id, position) VALUES (?,?,?) ON CONFLICT(user_id, list_id) DO UPDATE SET position = excluded.position').run(req.user.id, Number(id), i)))();
    return { ok: true };
  });
}
