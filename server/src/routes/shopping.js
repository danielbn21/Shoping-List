import { audit } from '../util.js';
import { makeAccess } from '../access.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const cleanText = (s, max) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '');

export default async function shoppingRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { householdRole, listAccess, canEdit, entryAccess } = makeAccess(db);

  const openTrip = (listId) => db.prepare('SELECT * FROM trips WHERE list_id = ? AND finished_at IS NULL ORDER BY id DESC').get(listId);

  // ---------- shop mode: check / uncheck ----------
  // Any role that can see the list (including "shopper") may check things off.
  app.post('/api/entries/:id/check', pre, async (req, reply) => {
    const r = entryAccess(req.user, Number(req.params.id));
    if (!r) return bad(reply, 'not_found', 404);
    const checked = !!(req.body || {}).checked;
    const now = Date.now();
    db.transaction(() => {
      if (checked) {
        db.prepare("UPDATE list_entries SET state = 'in_cart', checked_by = ?, checked_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, now, r.entry.id);
        if (!openTrip(r.entry.list_id)) {
          db.prepare('INSERT INTO trips(household_id, list_id, shopper_id, started_at) VALUES (?,?,?,?)').run(r.acc.list.household_id, r.entry.list_id, req.user.id, now);
        }
      } else {
        db.prepare("UPDATE list_entries SET state = 'open', checked_by = NULL, checked_at = NULL, updated_at = ? WHERE id = ?").run(now, r.entry.id);
        const left = db.prepare("SELECT COUNT(*) c FROM list_entries WHERE list_id = ? AND state = 'in_cart' AND deleted = 0").get(r.entry.list_id).c;
        if (!left) db.prepare('DELETE FROM trips WHERE list_id = ? AND finished_at IS NULL').run(r.entry.list_id); // nobody is shopping any more
      }
    })();
    return { ok: true };
  });

  // ---------- Finish trip: checked items become purchases and leave the list ----------
  app.post('/api/lists/:id/finish', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    const hid = acc.list.household_id;
    const b = req.body || {};
    let storeId = null;
    if (b.storeId) {
      storeId = Number(b.storeId);
      if (!db.prepare('SELECT 1 FROM stores WHERE id = ? AND household_id = ?').get(storeId, hid)) return bad(reply, 'store_not_found');
    }
    let total = null;
    if (b.total !== undefined && b.total !== null && b.total !== '') {
      total = Number(b.total);
      if (!(total >= 0 && total < 1e8)) return bad(reply, 'invalid_total');
    }
    const currency = /^[A-Z]{3}$/.test(b.currency ?? '') ? b.currency : (req.user.currency ?? null);
    const cart = db.prepare("SELECT * FROM list_entries WHERE list_id = ? AND state = 'in_cart' AND deleted = 0").all(acc.list.id);
    if (!cart.length) return bad(reply, 'nothing_checked');
    const now = Date.now();
    const result = db.transaction(() => {
      let trip = openTrip(acc.list.id);
      if (!trip) {
        const id = Number(db.prepare('INSERT INTO trips(household_id, list_id, shopper_id, started_at) VALUES (?,?,?,?)').run(hid, acc.list.id, req.user.id, now).lastInsertRowid);
        trip = { id };
      }
      const ev = db.prepare(`INSERT INTO purchase_events(household_id, item_id, trip_id, list_id, quantity, unit, store_id, buyer_id, purchased_at, unit_price, line_total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const e of cart) {
        const price = db.prepare('SELECT price FROM items WHERE id = ?').get(e.item_id)?.price ?? null;
        ev.run(hid, e.item_id, trip.id, acc.list.id, e.quantity, e.unit, storeId, e.checked_by ?? req.user.id, now, price, price === null ? null : Math.round(price * e.quantity * 100) / 100);
        db.prepare('UPDATE list_entries SET deleted = 1, updated_at = ? WHERE id = ?').run(now, e.id);
      }
      db.prepare('UPDATE trips SET finished_at = ?, store_id = ?, total = ?, currency = ? WHERE id = ?').run(now, storeId, total, currency, trip.id);
      audit(db, req.user.id, 'trip.finished', String(acc.list.id), { items: cart.length });
      const left = db.prepare('SELECT COUNT(*) c FROM list_entries WHERE list_id = ? AND deleted = 0').get(acc.list.id).c;
      return { purchased: cart.length, left, tripId: trip.id };
    })();
    return result;
  });

  // ---------- Manage: drag-and-drop ordering ----------
  // groups: [{ categoryId: number|null, entryIds: number[] }] in display order.
  // Dropping an entry into another group re-files its item in that category.
  app.post('/api/lists/:id/reorder', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const groups = (req.body || {}).groups;
    if (!Array.isArray(groups)) return bad(reply, 'invalid_value');
    const mine = new Set(db.prepare('SELECT id FROM list_entries WHERE list_id = ? AND deleted = 0').all(acc.list.id).map((r) => r.id));
    const cats = new Set(db.prepare('SELECT id FROM categories WHERE household_id = ?').all(acc.list.household_id).map((r) => r.id));
    for (const g of groups) {
      if (g.categoryId !== null && !cats.has(Number(g.categoryId))) return bad(reply, 'invalid_category');
      if (!Array.isArray(g.entryIds) || !g.entryIds.every((id) => mine.has(Number(id)))) return bad(reply, 'invalid_value');
    }
    db.transaction(() => {
      let pos = 0;
      const now = Date.now();
      for (const g of groups) {
        const cid = g.categoryId === null ? null : Number(g.categoryId);
        for (const id of g.entryIds.map(Number)) {
          pos += 1;
          db.prepare('UPDATE list_entries SET position = ?, updated_at = ? WHERE id = ?').run(pos, now, id);
          db.prepare('UPDATE items SET category_id = ? WHERE id = (SELECT item_id FROM list_entries WHERE id = ?) AND category_id IS NOT ?').run(cid, id, cid);
        }
      }
    })();
    return { ok: true };
  });

  // ---------- category order (shared by the household) ----------
  app.put('/api/households/:hid/categories/order', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const ids = (req.body || {}).ids;
    const valid = new Set(db.prepare('SELECT id FROM categories WHERE household_id = ?').all(hid).map((r) => r.id));
    if (!Array.isArray(ids) || !ids.every((i) => valid.has(Number(i)))) return bad(reply, 'invalid_value');
    db.transaction(() => ids.forEach((id, i) => db.prepare('UPDATE categories SET sort = ? WHERE id = ?').run(i, Number(id))))();
    return { ok: true };
  });

  // ---------- stores: a named walking order of categories ----------
  const storeAccess = (user, id) => {
    const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
    return s && householdRole(user.id, s.household_id) ? s : null;
  };

  app.post('/api/households/:hid/stores', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const name = cleanText((req.body || {}).name, 60);
    if (!name) return bad(reply, 'invalid_name');
    const id = Number(db.prepare('INSERT INTO stores(household_id, name) VALUES (?,?)').run(hid, name).lastInsertRowid);
    return { id };
  });

  app.patch('/api/stores/:id', pre, async (req, reply) => {
    const s = storeAccess(req.user, Number(req.params.id));
    if (!s) return bad(reply, 'not_found', 404);
    const name = cleanText((req.body || {}).name, 60);
    if (!name) return bad(reply, 'invalid_name');
    db.prepare('UPDATE stores SET name = ? WHERE id = ?').run(name, s.id);
    return { ok: true };
  });

  app.delete('/api/stores/:id', pre, async (req, reply) => {
    const s = storeAccess(req.user, Number(req.params.id));
    if (!s) return bad(reply, 'not_found', 404);
    db.prepare('DELETE FROM stores WHERE id = ?').run(s.id);
    return { ok: true };
  });

  app.put('/api/stores/:id/layout', pre, async (req, reply) => {
    const s = storeAccess(req.user, Number(req.params.id));
    if (!s) return bad(reply, 'not_found', 404);
    const ids = (req.body || {}).categoryIds;
    const valid = new Set(db.prepare('SELECT id FROM categories WHERE household_id = ?').all(s.household_id).map((r) => r.id));
    if (!Array.isArray(ids) || !ids.every((i) => valid.has(Number(i)))) return bad(reply, 'invalid_value');
    db.transaction(() => {
      db.prepare('DELETE FROM store_layouts WHERE store_id = ?').run(s.id);
      ids.forEach((id, i) => db.prepare('INSERT OR REPLACE INTO store_layouts(store_id, category_id, position) VALUES (?,?,?)').run(s.id, Number(id), i));
    })();
    return { ok: true };
  });

  // ---------- who can do what on a list ----------
  // Roles: owner, contributor ("Editor": manages the list), viewer ("Shopper": checks items off only).
  app.get('/api/lists/:id/members', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const explicit = new Map(db.prepare('SELECT user_id, role FROM list_members WHERE list_id = ?').all(acc.list.id).map((r) => [r.user_id, r.role]));
    const people = db.prepare(`SELECT u.id, u.name, m.role AS hrole FROM household_members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ? AND u.disabled = 0 ORDER BY u.name`).all(acc.list.household_id);
    return {
      private: acc.list.visibility === 'private',
      members: people.map((p) => {
        const ex = explicit.get(p.id);
        let role;
        if (ex === 'owner' || (!ex && p.hrole === 'owner' && acc.list.visibility !== 'private')) role = 'owner';
        else if (acc.list.visibility === 'private') role = ex ?? 'none';
        else role = ex ?? 'contributor';
        return { userId: p.id, name: p.name, role, locked: role === 'owner' };
      }),
    };
  });

  app.put('/api/lists/:id/members/:userId', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (acc.role !== 'owner') return bad(reply, 'forbidden', 403);
    const uid = Number(req.params.userId);
    const role = (req.body || {}).role;
    if (!['contributor', 'viewer', 'none'].includes(role)) return bad(reply, 'invalid_value');
    if (!householdRole(uid, acc.list.household_id)) return bad(reply, 'not_found', 404);
    const current = db.prepare('SELECT role FROM list_members WHERE list_id = ? AND user_id = ?').get(acc.list.id, uid)?.role;
    if (current === 'owner' || (householdRole(uid, acc.list.household_id) === 'owner' && acc.list.visibility !== 'private')) return bad(reply, 'forbidden', 403);
    const isPrivate = acc.list.visibility === 'private';
    if (role === 'none') {
      if (!isPrivate) return bad(reply, 'invalid_value'); // a household list is visible to everyone in it
      db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(acc.list.id, uid);
    } else if (role === 'contributor' && !isPrivate) {
      db.prepare('DELETE FROM list_members WHERE list_id = ? AND user_id = ?').run(acc.list.id, uid); // default for household lists
    } else {
      db.prepare('INSERT INTO list_members(list_id, user_id, role) VALUES (?,?,?) ON CONFLICT(list_id, user_id) DO UPDATE SET role = excluded.role').run(acc.list.id, uid, role);
    }
    return { ok: true };
  });
}
