import { getSetting, audit } from '../util.js';
import { normalize, findMatches, isHebrew } from '../match.js';
import { makeAccess } from '../access.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const cleanText = (s, max) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const COLORS = ['green', 'yellow', 'blue', 'red', 'plum', 'orange', 'gray'];

export default async function listRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };

  const { householdRole, listAccess, canEdit, entryAccess } = makeAccess(db);

  const publicItem = (i) => ({ id: i.id, name: i.name, categoryId: i.category_id, defaultNote: i.default_note ?? null, price: i.price ?? null });
  const bankFor = (hid) => db.prepare('SELECT * FROM items WHERE household_id = ? AND archived = 0').all(hid);

  // ---------- lists ----------
  app.get('/api/lists', pre, async (req) => {
    const rows = db.prepare(`SELECT l.*, h.name AS household_name,
      (SELECT COUNT(*) FROM list_entries e WHERE e.list_id = l.id AND e.deleted = 0) AS n
      FROM lists l JOIN households h ON h.id = l.household_id
      LEFT JOIN user_list_order o ON o.list_id = l.id AND o.user_id = ?
      WHERE l.archived = 0 AND (
        (l.visibility = 'household' AND l.household_id IN (SELECT household_id FROM household_members WHERE user_id = ?))
        OR l.id IN (SELECT list_id FROM list_members WHERE user_id = ?))
      ORDER BY COALESCE(o.position, 1000000), l.id`).all(req.user.id, req.user.id, req.user.id);
    return { lists: rows.map((l) => ({ id: l.id, name: l.name, color: l.color, visibility: l.visibility, householdId: l.household_id, householdName: l.household_name, itemCount: l.n })) };
  });

  app.get('/api/households/:hid/members', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    return { members: db.prepare(`SELECT u.id, u.name, u.username, m.role FROM household_members m JOIN users u ON u.id = m.user_id
      WHERE m.household_id = ? AND u.disabled = 0 ORDER BY u.name`).all(hid) };
  });

  app.post('/api/lists', pre, async (req, reply) => {
    const b = req.body || {};
    const hid = Number(b.householdId);
    if (!hid || !householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const name = cleanText(b.name, 80);
    if (!name) return bad(reply, 'invalid_name');
    const visibility = b.visibility === 'private' ? 'private' : 'household';
    const color = COLORS.includes(b.color) ? b.color : 'green';
    const id = db.transaction(() => {
      const lid = Number(db.prepare('INSERT INTO lists(household_id, name, color, visibility, created_by, created_at) VALUES (?,?,?,?,?,?)')
        .run(hid, name, color, visibility, req.user.id, Date.now()).lastInsertRowid);
      db.prepare("INSERT INTO list_members(list_id, user_id, role) VALUES (?,?,'owner')").run(lid, req.user.id);
      if (visibility === 'private' && Array.isArray(b.memberIds)) {
        for (const uid of new Set(b.memberIds.map(Number))) {
          if (uid !== req.user.id && householdRole(uid, hid)) {
            db.prepare("INSERT OR IGNORE INTO list_members(list_id, user_id, role) VALUES (?,?,'contributor')").run(lid, uid);
          }
        }
      }
      audit(db, req.user.id, 'list.created', String(lid));
      return lid;
    })();
    return { id };
  });

  app.patch('/api/lists/:id', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (acc.role !== 'owner') return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const name = b.name !== undefined ? cleanText(b.name, 80) : acc.list.name;
    if (!name) return bad(reply, 'invalid_name');
    const color = b.color !== undefined ? (COLORS.includes(b.color) ? b.color : acc.list.color) : acc.list.color;
    db.prepare('UPDATE lists SET name = ?, color = ? WHERE id = ?').run(name, color, acc.list.id);
    return { ok: true };
  });

  app.delete('/api/lists/:id', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (acc.role !== 'owner') return bad(reply, 'forbidden', 403);
    db.prepare('UPDATE lists SET archived = 1 WHERE id = ?').run(acc.list.id);
    audit(db, req.user.id, 'list.deleted', String(acc.list.id));
    app.modules.events.emit('list.deleted', { listId: acc.list.id, householdId: acc.list.household_id });
    return { ok: true };
  });

  app.get('/api/lists/:id', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    const hid = acc.list.household_id;
    const entries = db.prepare(`SELECT e.id, e.item_id, e.quantity, e.unit, e.note, e.state, e.added_at, e.position, e.checked_at,
        i.name, i.category_id, u.name AS added_by_name, cu.name AS checked_by_name
      FROM list_entries e JOIN items i ON i.id = e.item_id
      LEFT JOIN users u ON u.id = e.added_by LEFT JOIN users cu ON cu.id = e.checked_by
      WHERE e.list_id = ? AND e.deleted = 0 ORDER BY e.position, e.id`).all(acc.list.id);
    const categories = db.prepare('SELECT id, name_en, name_he, sort FROM categories WHERE household_id = ? ORDER BY sort, id').all(hid);
    const stores = db.prepare('SELECT id, name FROM stores WHERE household_id = ? ORDER BY id').all(hid).map((s) => ({
      id: s.id, name: s.name,
      categoryOrder: db.prepare('SELECT category_id FROM store_layouts WHERE store_id = ? ORDER BY position').all(s.id).map((r) => r.category_id),
    }));
    const shoppingNow = db.prepare(`SELECT t.shopper_id, t.started_at, u.name FROM trips t LEFT JOIN users u ON u.id = t.shopper_id
      WHERE t.list_id = ? AND t.finished_at IS NULL AND t.started_at > ?`).all(acc.list.id, Date.now() - 12 * 3600 * 1000);
    return {
      list: { id: acc.list.id, name: acc.list.name, color: acc.list.color, visibility: acc.list.visibility, householdId: hid, role: acc.role },
      entries: entries.map((e) => ({
        id: e.id, itemId: e.item_id, name: e.name, categoryId: e.category_id, quantity: e.quantity, unit: e.unit, note: e.note,
        state: e.state, addedAt: e.added_at, position: e.position, addedByName: e.added_by_name,
        checkedAt: e.checked_at, checkedByName: e.checked_by_name,
      })),
      categories: categories.map((c) => ({ id: c.id, nameEn: c.name_en, nameHe: c.name_he, sort: c.sort })),
      stores,
      shoppingNow: shoppingNow.map((t) => ({ userId: t.shopper_id, name: t.name, since: t.started_at })),
    };
  });

  // ---------- adding entries (duplicate-aware) ----------
  // Suggestions from an 'item-catalog' module (for example the products the chosen supermarket branches sell). With no such module, or none
  // for this user, the list is empty and the Add items form works as it always did.
  const catalogProvider = (userId) => app.modules.providerFor('item-catalog', userId);
  app.get('/api/lists/:id/catalog', { ...pre, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const q = cleanText(req.query.q, 80);
    const provider = catalogProvider(req.user.id);
    if (!provider) return { available: false, suggestions: [] };
    if (!q || q.length < 2) return { available: true, suggestions: [] };
    try {
      const found = await provider.search({ user: req.user, listId: acc.list.id, householdId: acc.list.household_id, q, limit: 8 });
      const suggestions = (Array.isArray(found) ? found : []).slice(0, 8).map((s) => ({
        name: cleanText(s.name, 100), note: cleanText(s.note, 200) || null, categoryId: Number.isInteger(s.categoryId) ? s.categoryId : null,
        price: Number.isFinite(s.price) ? s.price : null, priceMax: Number.isFinite(s.priceMax) ? s.priceMax : null, currency: typeof s.currency === 'string' ? s.currency.slice(0, 3) : null,
        perKg: !!s.perKg, chains: (Array.isArray(s.chains) ? s.chains : []).slice(0, 12).map((c) => ({ nameEn: cleanText(c.nameEn, 40), nameHe: cleanText(c.nameHe, 40) })),
        ref: s.ref && typeof s.ref === 'object' && JSON.stringify(s.ref).length <= 300 ? s.ref : null,
      })).filter((s) => s.name);
      return { available: true, suggestions };
    } catch (e) { req.log.warn({ err: e }, 'item catalog search failed'); return { available: true, suggestions: [] }; }
  });

  app.post('/api/lists/:id/entries', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const hid = acc.list.household_id;
    const qty = b.quantity === undefined ? 1 : Number(b.quantity);
    if (!(qty > 0 && qty <= 9999)) return bad(reply, 'invalid_quantity');
    const unit = cleanText(b.unit, 20) || null;
    const note = cleanText(b.note, 200) || null;
    let categoryId = null;
    if (b.categoryId) {
      categoryId = Number(b.categoryId);
      if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').get(categoryId, hid)) return bad(reply, 'invalid_category');
    }

    let item;
    if (b.itemId) {
      item = db.prepare('SELECT * FROM items WHERE id = ? AND household_id = ?').get(Number(b.itemId), hid);
      if (!item) return bad(reply, 'item_not_found');
      if (b.source === 'typeahead') {
        db.prepare("INSERT INTO suggestion_events(household_id, item_id, user_id, type, context, created_at) VALUES (?,?,?,'accepted','typeahead',?)")
          .run(hid, item.id, req.user.id, Date.now());
      }
    } else {
      const name = cleanText(b.name, 100);
      if (!name) return bad(reply, 'invalid_name');
      const norm = normalize(name);
      if (!norm) return bad(reply, 'invalid_name');
      const all = db.prepare('SELECT * FROM items WHERE household_id = ?').all(hid);
      item = all.find((i) => i.name_norm === norm); // same word, plural or case: reuse silently
      if (!item) {
        if (!b.force) {
          const similar = findMatches(name, all.filter((i) => !i.archived), { strictness: getSetting(db, 'match_strictness') });
          if (similar.length) {
            db.prepare("INSERT INTO suggestion_events(household_id, item_id, user_id, type, context, created_at) VALUES (?,?,?,'shown','similar_on_submit',?)")
              .run(hid, similar[0].item.id, req.user.id, Date.now());
            return reply.code(409).send({ error: 'similar_items', matches: similar.map((m) => publicItem(m.item)) });
          }
        }
        const id = Number(db.prepare(`INSERT INTO items(household_id, name, name_norm, language, category_id, default_unit, created_at)
          VALUES (?,?,?,?,?,?,?)`).run(hid, name, norm, isHebrew(name) ? 'he' : 'en', categoryId, unit, Date.now()).lastInsertRowid);
        item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      }
    }
    if (item.archived) db.prepare('UPDATE items SET archived = 0 WHERE id = ?').run(item.id);
    if (categoryId && !item.category_id) db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(categoryId, item.id);

    // The product picked from a catalog suggestion, if any: the catalog module may remember it (for example as the confirmed match for the item).
    const ref = b.catalogRef && typeof b.catalogRef === 'object' && JSON.stringify(b.catalogRef).length <= 300 ? b.catalogRef : null;
    const chosen = async () => {
      const provider = ref && catalogProvider(req.user.id);
      if (provider?.afterAdd) { try { await provider.afterAdd({ user: req.user, listId: acc.list.id, householdId: hid, itemId: item.id, ref }); } catch (e) { req.log.warn({ err: e }, 'item catalog afterAdd failed'); } }
    };
    const now = Date.now();
    const existing = db.prepare("SELECT * FROM list_entries WHERE list_id = ? AND item_id = ? AND deleted = 0 AND state = 'open'").get(acc.list.id, item.id);
    if (existing) {
      db.prepare('UPDATE list_entries SET quantity = quantity + ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(qty, note, now, existing.id);
      await chosen();
      return { entryId: existing.id, itemId: item.id, merged: true };
    }
    db.prepare('INSERT OR IGNORE INTO list_items(list_id, item_id, added_at) VALUES (?, ?, ?)').run(acc.list.id, item.id, now);
    const entryId = Number(db.prepare(`INSERT INTO list_entries(list_id, item_id, quantity, unit, note, added_by, added_at, updated_at, position)
      VALUES (?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(position), 0) + 1 FROM list_entries WHERE list_id = ?))`)
      .run(acc.list.id, item.id, qty, unit ?? item.default_unit, note ?? item.default_note ?? null, req.user.id, now, now, acc.list.id).lastInsertRowid);
    await chosen();
    return { entryId, itemId: item.id, merged: false };
  });

  app.patch('/api/entries/:id', pre, async (req, reply) => {
    const r = entryAccess(req.user, Number(req.params.id));
    if (!r) return bad(reply, 'not_found', 404);
    if (!canEdit(r.acc)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const qty = b.quantity !== undefined ? Number(b.quantity) : r.entry.quantity;
    if (!(qty > 0 && qty <= 9999)) return bad(reply, 'invalid_quantity');
    const unit = b.unit !== undefined ? (cleanText(b.unit, 20) || null) : r.entry.unit;
    const note = b.note !== undefined ? (cleanText(b.note, 200) || null) : r.entry.note;
    if (b.categoryId !== undefined) { // moving an entry to another category re-files the item itself
      const cid = b.categoryId ? Number(b.categoryId) : null;
      if (cid && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').get(cid, r.acc.list.household_id)) return bad(reply, 'invalid_category');
      db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(cid, r.entry.item_id);
    }
    db.prepare('UPDATE list_entries SET quantity = ?, unit = ?, note = ?, updated_at = ? WHERE id = ?').run(qty, unit, note, Date.now(), r.entry.id);
    return { ok: true };
  });

  // Removing an entry is "I changed my mind": no purchase is recorded.
  app.delete('/api/entries/:id', pre, async (req, reply) => {
    const r = entryAccess(req.user, Number(req.params.id));
    if (!r) return bad(reply, 'not_found', 404);
    if (!canEdit(r.acc)) return bad(reply, 'forbidden', 403);
    db.prepare('UPDATE list_entries SET deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), r.entry.id);
    return { ok: true };
  });

  // ---------- item bank ----------
  app.get('/api/households/:hid/items', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const q = String(req.query.q || '').trim();
    const typeahead = req.query.mode === 'typeahead';
    const listId = Number(req.query.listId) || 0;
    const onList = new Map(db.prepare("SELECT item_id, quantity FROM list_entries WHERE list_id = ? AND deleted = 0 AND state = 'open'").all(listId).map((r) => [r.item_id, r.quantity]));
    // With a list given, "past items" means this list's own: items it has had (the item itself, with its category, note and price matches, is shared by the household).
    const listAcc = listId ? listAccess(req.user, listId) : null;
    if (listId && (!listAcc || listAcc.list.household_id !== hid)) return bad(reply, 'not_found', 404);
    const stats = new Map((listId
      ? db.prepare('SELECT item_id, COUNT(*) AS n, MAX(purchased_at) AS last FROM purchase_events WHERE list_id = ? GROUP BY item_id').all(listId)
      : db.prepare('SELECT item_id, COUNT(*) AS n, MAX(purchased_at) AS last FROM purchase_events WHERE household_id = ? GROUP BY item_id').all(hid)).map((r) => [r.item_id, r]));
    let items = bankFor(hid);
    if (listId) { const mine = new Set(db.prepare('SELECT item_id FROM list_items WHERE list_id = ?').all(listId).map((r) => r.item_id)); items = items.filter((i) => mine.has(i.id)); }
    if (q) {
      items = findMatches(q, items, { strictness: getSetting(db, 'match_strictness'), typeahead: true, limit: typeahead ? 6 : 100 }).map((m) => m.item);
    } else {
      if (req.query.sort === 'recent') items.sort((a, b) => (stats.get(b.id)?.last ?? 0) - (stats.get(a.id)?.last ?? 0) || a.name.localeCompare(b.name));
      else items.sort((a, b) => a.name.localeCompare(b.name));
      items = items.slice(0, 500);
    }
    return {
      items: items.map((i) => ({
        ...publicItem(i), onListQty: onList.get(i.id) ?? 0,
        timesPurchased: stats.get(i.id)?.n ?? 0, lastPurchasedAt: stats.get(i.id)?.last ?? null,
      })),
    };
  });

  // Remove items from a list's past items (many at once). Items that are on the list right now are kept: they are not past yet.
  // The item itself stays in the household, so other lists and the price matches are untouched.
  app.post('/api/lists/:id/past-items/remove', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const ids = (req.body || {}).itemIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((i) => !Number.isInteger(i))) return bad(reply, 'invalid_value');
    const onList = db.prepare("SELECT 1 FROM list_entries WHERE list_id = ? AND item_id = ? AND deleted = 0 AND state IN ('open', 'in_cart')");
    const drop = db.prepare('DELETE FROM list_items WHERE list_id = ? AND item_id = ?');
    let removed = 0; const skipped = [];
    db.transaction(() => {
      for (const id of new Set(ids)) {
        if (onList.get(acc.list.id, id)) { skipped.push(id); continue; }
        removed += drop.run(acc.list.id, id).changes;
      }
    })();
    if (removed) audit(db, req.user.id, 'list.past_items_removed', String(acc.list.id), { removed });
    return { removed, skipped };
  });

  // Price estimates for what is on the list: the last price paid for each item at the chosen store (or anywhere when no store is chosen),
  // from your own receipts; an item with no receipt price falls back to the price saved on the item. Only trips in the asked currency count,
  // and purchases from private lists the user is not on are not used.
  app.get('/api/lists/:id/estimates', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    const storeId = Number(req.query.storeId) || null;
    const currency = /^[A-Z]{3}$/.test(String(req.query.currency || '')) ? String(req.query.currency) : 'ILS';
    if (storeId && !db.prepare('SELECT 1 FROM stores WHERE id = ? AND household_id = ?').get(storeId, acc.list.household_id)) return bad(reply, 'not_found', 404);
    const visible = "(p.list_id IS NULL OR l.visibility = 'household' OR p.list_id IN (SELECT list_id FROM list_members WHERE user_id = @uid))";
    const last = db.prepare(`SELECT p.unit_price, p.purchased_at FROM purchase_events p LEFT JOIN trips t ON t.id = p.trip_id LEFT JOIN lists l ON l.id = p.list_id
      WHERE p.item_id = @item AND p.household_id = @hid AND p.unit_price IS NOT NULL AND (t.currency IS NULL OR t.currency = @cur) AND ${visible}
      ${storeId ? 'AND p.store_id = @store' : ''} ORDER BY p.purchased_at DESC, p.id DESC LIMIT 1`);
    const manual = db.prepare('SELECT price FROM items WHERE id = ?');
    const prices = {};
    for (const e of db.prepare("SELECT DISTINCT item_id FROM list_entries WHERE list_id = ? AND deleted = 0 AND state IN ('open', 'in_cart')").all(acc.list.id)) {
      const p = last.get({ item: e.item_id, hid: acc.list.household_id, cur: currency, uid: req.user.id, ...(storeId ? { store: storeId } : {}) });
      if (p) { prices[e.item_id] = { unitPrice: p.unit_price, source: storeId ? 'store' : 'last', at: p.purchased_at }; continue; }
      const m = manual.get(e.item_id)?.price;
      if (Number.isFinite(m) && m > 0) prices[e.item_id] = { unitPrice: m, source: 'item', at: null };
    }
    return { currency, storeId, prices };
  });

  const itemAccess = (user, id) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    return item && householdRole(user.id, item.household_id) ? item : null;
  };

  app.patch('/api/items/:id', pre, async (req, reply) => {
    const item = itemAccess(req.user, Number(req.params.id));
    if (!item) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    let { name, name_norm, category_id, default_note, price } = item;
    if (b.name !== undefined) {
      name = cleanText(b.name, 100);
      name_norm = normalize(name);
      if (!name_norm) return bad(reply, 'invalid_name');
      if (db.prepare('SELECT 1 FROM items WHERE household_id = ? AND name_norm = ? AND id != ? AND archived = 0').get(item.household_id, name_norm, item.id)) return bad(reply, 'item_exists', 409);
    }
    if (b.categoryId !== undefined) {
      category_id = b.categoryId ? Number(b.categoryId) : null;
      if (category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').get(category_id, item.household_id)) return bad(reply, 'invalid_category');
    }
    if (b.defaultNote !== undefined) default_note = cleanText(b.defaultNote, 200) || null;
    if (b.price !== undefined) {
      if (b.price === null || b.price === '') price = null;
      else { price = Number(b.price); if (!(price >= 0 && price < 1e7)) return bad(reply, 'invalid_price'); }
    }
    db.prepare('UPDATE items SET name = ?, name_norm = ?, category_id = ?, default_note = ?, price = ? WHERE id = ?').run(name, name_norm, category_id, default_note, price, item.id);
    return { ok: true };
  });

  app.delete('/api/items/:id', pre, async (req, reply) => {
    const item = itemAccess(req.user, Number(req.params.id));
    if (!item) return bad(reply, 'not_found', 404);
    db.transaction(() => {
      db.prepare('UPDATE items SET archived = 1 WHERE id = ?').run(item.id);
      db.prepare('UPDATE list_entries SET deleted = 1, updated_at = ? WHERE item_id = ? AND deleted = 0').run(Date.now(), item.id);
    })();
    app.modules.events.emit('item.deleted', { itemId: item.id, householdId: item.household_id });
    return { ok: true };
  });

  // ---------- categories (shared by the whole household) ----------
  app.get('/api/households/:hid/categories', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const rows = db.prepare('SELECT id, name_en, name_he, sort FROM categories WHERE household_id = ? ORDER BY sort, id').all(hid);
    return { categories: rows.map((c) => ({ id: c.id, nameEn: c.name_en, nameHe: c.name_he, sort: c.sort })) };
  });

  app.post('/api/households/:hid/categories', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const en = cleanText(b.nameEn, 60), he = cleanText(b.nameHe, 60);
    if (!en && !he) return bad(reply, 'invalid_name');
    const next = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE household_id = ?').get(hid)).n;
    const id = Number(db.prepare('INSERT INTO categories(household_id, name_en, name_he, sort) VALUES (?,?,?,?)').run(hid, en || he, he || en, next).lastInsertRowid);
    return { id };
  });

  const categoryAccess = (user, id) => {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    return c && householdRole(user.id, c.household_id) ? c : null;
  };

  app.patch('/api/categories/:id', pre, async (req, reply) => {
    const c = categoryAccess(req.user, Number(req.params.id));
    if (!c) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const en = b.nameEn !== undefined ? cleanText(b.nameEn, 60) : c.name_en;
    const he = b.nameHe !== undefined ? cleanText(b.nameHe, 60) : c.name_he;
    if (!en || !he) return bad(reply, 'invalid_name');
    const sort = b.sort !== undefined ? Number(b.sort) : c.sort;
    db.prepare('UPDATE categories SET name_en = ?, name_he = ?, sort = ? WHERE id = ?').run(en, he, sort, c.id);
    return { ok: true };
  });

  app.delete('/api/categories/:id', pre, async (req, reply) => {
    const c = categoryAccess(req.user, Number(req.params.id));
    if (!c) return bad(reply, 'not_found', 404);
    db.prepare('DELETE FROM categories WHERE id = ?').run(c.id); // items become uncategorised (ON DELETE SET NULL)
    return { ok: true };
  });
}
