import { makeAccess } from '../access.js';
import { audit, getSetting, cleanName } from '../util.js';
import { findReceiptMatch, normalize, isHebrew } from '../match.js';
import { addToList, checkEntry } from '../entries.js';

// The API modules get instead of SQL access to the core database. Everything here is read-only apart from audit(), scanItem() and renameItem().
// Each function takes the acting user's row (req.user) where permissions matter, so a module can never see more than the user may.
export function makeCoreApi(app) {
  const db = app.db;
  const { householdRole, listAccess, canEdit } = makeAccess(db);
  const lastPaidStmt = (n) => db.prepare(`SELECT p.unit_price, p.purchased_at, p.store_id
    FROM purchase_events p
    LEFT JOIN trips t ON t.id = p.trip_id
    LEFT JOIN lists l ON l.id = p.list_id
    WHERE p.item_id = ? AND p.store_id IN (${new Array(n).fill('?').join(',')}) AND p.unit_price IS NOT NULL
      AND (t.currency IS NULL OR t.currency = 'ILS')
      AND (p.list_id IS NULL OR l.visibility = 'household' OR p.list_id IN (SELECT list_id FROM list_members WHERE user_id = ?))
    ORDER BY p.purchased_at DESC, p.id DESC LIMIT 1`);
  const cache = new Map();

  return Object.freeze({
    version: app.coreVersion,
    // { list, role } or null. role: owner | contributor | viewer
    listAccess: (user, listId) => listAccess(user, Number(listId)),
    canEdit: (acc) => canEdit(acc),
    // Open (not yet ticked) entries of a list: [{ itemId, quantity, name }]
    listOpenEntries: (listId) => db.prepare(`SELECT e.item_id AS itemId, e.quantity, i.name FROM list_entries e JOIN items i ON i.id = e.item_id
      WHERE e.list_id = ? AND e.deleted = 0 AND e.state = 'open' ORDER BY e.position, e.id`).all(Number(listId)),
    // An item of the household's item bank ({ id, name }), or null when it is not one of the household's.
    // The items a list has had (its "past items"), most recently added first. Read-only; archived items are left out.
    listPastItems: (listId) => db.prepare(`SELECT i.id AS itemId, i.name FROM list_items li JOIN items i ON i.id = li.item_id WHERE li.list_id = ? AND i.archived = 0 ORDER BY li.added_at DESC, i.id LIMIT 500`).all(Number(listId)),
    itemInHousehold: (householdId, itemId) => db.prepare('SELECT id, name FROM items WHERE id = ? AND household_id = ? AND archived = 0').get(Number(itemId), Number(householdId)) ?? null,
    // The household's own item that a product name is most like (every word of the item appears in the name), or null: { id, name, categoryId, defaultNote }.
    similarItem: (householdId, name) => {
      const items = db.prepare('SELECT * FROM items WHERE household_id = ? AND archived = 0').all(Number(householdId));
      const it = findReceiptMatch(String(name || ''), items, { strictness: getSetting(db, 'match_strictness') });
      return it ? { id: it.id, name: it.name, categoryId: it.category_id ?? null, defaultNote: it.default_note ?? null } : null;
    },
    // The household's stores for a list: [{ id, name }]
    householdStores: (householdId) => db.prepare('SELECT id, name FROM stores WHERE household_id = ? ORDER BY id').all(Number(householdId)),
    // The store when the user belongs to its household, else null.
    storeAccess: (user, storeId) => {
      const s = db.prepare('SELECT id, name, household_id AS householdId FROM stores WHERE id = ?').get(Number(storeId));
      return s && householdRole(user.id, s.householdId) ? s : null;
    },
    // Last unit price paid for an item at any of the given store ids (shekel trips only, private lists respected), or null.
    lastPaid: ({ itemId, storeIds, userId }) => {
      const ids = (storeIds || []).map(Number).filter(Number.isFinite);
      if (!ids.length) return null;
      if (!cache.has(ids.length)) cache.set(ids.length, lastPaidStmt(ids.length));
      return cache.get(ids.length).get(Number(itemId), ...ids, Number(userId)) ?? null;
    },
    // A scanned item (since 1.6.0): the one write a module may do. Puts the item on the list through the same code as everything else
    // (so it joins the list's past items), or ticks it. Give itemId (an item of the list's household) or a name (an exact normalised name
    // reuses the household item, otherwise a new item is created). price, when given, becomes the item's saved price.
    //   tick = true  (shopping): on the list and open -> ticked; already in the cart -> quantity + 1; not on the list -> added already ticked.
    //   tick = false (managing): added to the list, or merged into the open entry.
    // Ticking needs any role that can see the list; adding or creating needs Owner or Editor.
    // -> { itemId, name, entryId, action: 'ticked'|'more'|'added_ticked'|'added'|'merged', created, quantity, priceSaved } or { error: 'not_found'|'forbidden'|'invalid_name' }
    // Renames a household item (the one a barcode points to). The name stays unique in the household. Needs edit rights on the list.
    renameItem: ({ user, listId, itemId, name }) => {
      const acc = listAccess(user, Number(listId));
      if (!acc) return { error: 'not_found' };
      if (!canEdit(acc)) return { error: 'forbidden' };
      const item = db.prepare('SELECT id, name, name_norm FROM items WHERE id = ? AND household_id = ? AND archived = 0').get(Number(itemId), acc.list.household_id);
      if (!item) return { error: 'not_found' };
      const nm = cleanName(name ?? '').slice(0, 100), norm = normalize(nm);
      if (!norm) return { error: 'invalid_name' };
      if (db.prepare('SELECT 1 FROM items WHERE household_id = ? AND name_norm = ? AND id != ? AND archived = 0').get(acc.list.household_id, norm, item.id)) return { error: 'item_exists' };
      db.prepare('UPDATE items SET name = ?, name_norm = ? WHERE id = ?').run(nm, norm, item.id);
      if (norm !== item.name_norm) app.modules.events.emit('item.renamed', { itemId: item.id, householdId: acc.list.household_id });
      return { itemId: item.id, name: nm, previousName: item.name };
    },
    scanItem: ({ user, listId, itemId = null, name = null, price = null, tick = false, categoryId = null }) => {
      const acc = listAccess(user, Number(listId));
      if (!acc) return { error: 'not_found' };
      const hid = acc.list.household_id, lid = acc.list.id;
      return db.transaction(() => {
        let item = itemId ? db.prepare('SELECT * FROM items WHERE id = ? AND household_id = ?').get(Number(itemId), hid) : null;
        if (itemId && !item) return { error: 'not_found' };
        let created = false;
        if (!item) {
          const nm = cleanName(name ?? '').slice(0, 100), norm = normalize(nm);
          if (!norm) return { error: 'invalid_name' };
          item = db.prepare('SELECT * FROM items WHERE household_id = ? AND name_norm = ?').get(hid, norm);
          if (!item) {
            if (!canEdit(acc)) return { error: 'forbidden' };
            const id = Number(db.prepare('INSERT INTO items(household_id, name, name_norm, language, created_at) VALUES (?,?,?,?,?)').run(hid, nm, norm, isHebrew(nm) ? 'he' : 'en', Date.now()).lastInsertRowid);
            item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
            created = true;
          }
        }
        const entryOf = (state) => db.prepare('SELECT * FROM list_entries WHERE list_id = ? AND item_id = ? AND deleted = 0 AND state = ? ORDER BY id LIMIT 1').get(lid, item.id, state);
        let action, entryId;
        if (tick) {
          const open = entryOf('open'), cart = entryOf('in_cart');
          if (open) { checkEntry(db, { entry: open, householdId: hid, userId: user.id, checked: true }); action = 'ticked'; entryId = open.id; }
          else if (cart) { db.prepare('UPDATE list_entries SET quantity = quantity + 1, updated_at = ? WHERE id = ?').run(Date.now(), cart.id); action = 'more'; entryId = cart.id; }
          else {
            if (!canEdit(acc)) return { error: 'forbidden' };
            const r = addToList(db, { listId: lid, item, quantity: 1, userId: user.id });
            checkEntry(db, { entry: db.prepare('SELECT * FROM list_entries WHERE id = ?').get(r.entryId), householdId: hid, userId: user.id, checked: true });
            action = 'added_ticked'; entryId = r.entryId;
          }
        } else {
          if (!canEdit(acc)) return { error: 'forbidden' };
          const r = addToList(db, { listId: lid, item, quantity: 1, userId: user.id });
          action = r.merged ? 'merged' : 'added'; entryId = r.entryId;
        }
        // since 1.8.0: a category (one of the household's) is given to an item made by this scan, or to an existing one that has none; a category the item has is left alone
        const cat = categoryId ? db.prepare('SELECT id FROM categories WHERE id = ? AND household_id = ?').get(Number(categoryId), hid) : null;
        if (cat && (created || !item.category_id) && canEdit(acc)) db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(cat.id, item.id);
        const p = Number(price);
        const priceSaved = Number.isFinite(p) && p > 0 && p < 1e5;
        const previousPrice = item.price ?? null, savedPrice = priceSaved ? Math.round(p * 100) / 100 : null;   // since 1.8.0, so a reversal can put the old price back
        if (priceSaved) db.prepare('UPDATE items SET price = ? WHERE id = ?').run(savedPrice, item.id);
        return { itemId: item.id, name: item.name, entryId, action, created, quantity: db.prepare('SELECT quantity FROM list_entries WHERE id = ?').get(entryId).quantity, priceSaved, previousPrice, savedPrice, categoryId: db.prepare('SELECT category_id FROM items WHERE id = ?').get(item.id).category_id ?? null };
      })();
    },

    // ---- since 1.8.0 ----
    // The household's categories: [{ id, nameEn, nameHe }] in the household's order.
    listCategories: (householdId) => db.prepare('SELECT id, name_en AS nameEn, name_he AS nameHe FROM categories WHERE household_id = ? ORDER BY sort, id').all(Number(householdId)),
    // The household's items (archived ones left out): [{ id, name, categoryId, createdAt }]. With q, only items whose name has every word of q
    // (normalised, so English and Hebrew spellings match), best first; limit is at most 5000.
    householdItems: (householdId, { q = '', limit = 20 } = {}) => {
      const lim = Math.max(1, Math.min(5000, Number(limit) || 20));
      const rows = db.prepare('SELECT id, name, name_norm, category_id, created_at FROM items WHERE household_id = ? AND archived = 0 ORDER BY id DESC').all(Number(householdId));
      const words = normalize(String(q || '')).split(' ').filter(Boolean);
      const out = words.length
        ? rows.filter((r) => words.every((w) => r.name_norm.includes(w))).sort((a, b) => (b.name_norm.startsWith(words[0]) - a.name_norm.startsWith(words[0])) || a.name.length - b.name.length)
        : rows;
      return out.slice(0, lim).map((r) => ({ id: r.id, name: r.name, categoryId: r.category_id ?? null, createdAt: r.created_at }));
    },
    // Sets (or clears, with categoryId null) an item's category. Needs edit rights on the list; the category must be the household's.
    setItemCategory: ({ user, listId, itemId, categoryId }) => {
      const acc = listAccess(user, Number(listId));
      if (!acc) return { error: 'not_found' };
      if (!canEdit(acc)) return { error: 'forbidden' };
      const hid = acc.list.household_id;
      const item = db.prepare('SELECT id, category_id FROM items WHERE id = ? AND household_id = ? AND archived = 0').get(Number(itemId), hid);
      if (!item) return { error: 'not_found' };
      let cid = null;
      if (categoryId) {
        cid = Number(categoryId);
        if (!db.prepare('SELECT 1 FROM categories WHERE id = ? AND household_id = ?').get(cid, hid)) return { error: 'invalid_category' };
      }
      db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(cid, item.id);
      return { itemId: item.id, categoryId: cid, previousCategoryId: item.category_id ?? null };
    },
    // Takes back what scanItem() did, using what it returned ({ itemId, entryId, action, created }). Only while the entry is still as the scan left it:
    //   ticked -> unticked; more -> quantity - 1; added or merged -> removed (merged: quantity - 1); added_ticked -> removed.
    // An item that the scan itself created, and nothing else uses, is deleted again. -> { reversed: true, result, itemRemoved } | { reversed: false, reason: 'changed' } | { error }
    reverseScan: ({ user, listId, itemId, entryId, action, created = false, restorePrice = null }) => {
      const acc = listAccess(user, Number(listId));
      if (!acc) return { error: 'not_found' };
      const hid = acc.list.household_id, lid = acc.list.id;
      if (action !== 'ticked' && action !== 'more' && !canEdit(acc)) return { error: 'forbidden' };
      if (!['ticked', 'more', 'merged', 'added', 'added_ticked'].includes(action)) return { error: 'invalid_action' };
      const done = db.transaction(() => {
        const entry = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_id = ? AND item_id = ? AND deleted = 0').get(Number(entryId), lid, Number(itemId));
        if (!entry) return { reversed: false, reason: 'changed' };
        const now = Date.now();
        const drop = () => {
          db.prepare('UPDATE list_entries SET deleted = 1, updated_at = ? WHERE id = ?').run(now, entry.id);
          const left = db.prepare("SELECT COUNT(*) c FROM list_entries WHERE list_id = ? AND state = 'in_cart' AND deleted = 0").get(lid).c;
          if (!left) db.prepare('DELETE FROM trips WHERE list_id = ? AND finished_at IS NULL').run(lid);   // nobody is shopping any more
        };
        let result;
        if (action === 'ticked') {
          if (entry.state !== 'in_cart') return { reversed: false, reason: 'changed' };
          checkEntry(db, { entry, householdId: hid, userId: user.id, checked: false }); result = 'unticked';
        } else if (action === 'more' || action === 'merged') {
          if (entry.state !== (action === 'more' ? 'in_cart' : 'open')) return { reversed: false, reason: 'changed' };
          const q = entry.quantity - 1;
          if (q > 0) { db.prepare('UPDATE list_entries SET quantity = ?, updated_at = ? WHERE id = ?').run(q, now, entry.id); result = 'less'; }
          else if (action === 'merged') { drop(); result = 'removed'; }
          else return { reversed: false, reason: 'changed' };
        } else {
          if (entry.state !== (action === 'added_ticked' ? 'in_cart' : 'open')) return { reversed: false, reason: 'changed' };
          drop(); result = 'removed';
        }
        // the scan saved a price on the item: put the old one back, unless the price has been changed since
        if (restorePrice && Number.isFinite(Number(restorePrice.to))) {
          const cur = db.prepare('SELECT price FROM items WHERE id = ?').get(Number(itemId))?.price;
          if (cur === Number(restorePrice.to)) db.prepare('UPDATE items SET price = ? WHERE id = ?').run(restorePrice.from === null || restorePrice.from === undefined ? null : Number(restorePrice.from), Number(itemId));
        }
        let itemRemoved = false;
        if (created && result === 'removed') {
          const used = db.prepare('SELECT (SELECT COUNT(*) FROM list_entries WHERE item_id = ? AND deleted = 0) + (SELECT COUNT(*) FROM purchase_events WHERE item_id = ?) AS n').get(Number(itemId), Number(itemId)).n;
          if (!used) { db.prepare('DELETE FROM items WHERE id = ? AND household_id = ?').run(Number(itemId), hid); itemRemoved = true; }
        }
        return { reversed: true, result, itemRemoved };
      })();
      if (done.itemRemoved) app.modules.events.emit('item.deleted', { itemId: Number(itemId), householdId: hid });
      return done;
    },
    audit: (actorId, action, target = null, detail = null) => audit(db, actorId, action, target, detail),
  });
}
