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
    scanItem: ({ user, listId, itemId = null, name = null, price = null, tick = false }) => {
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
        const p = Number(price);
        const priceSaved = Number.isFinite(p) && p > 0 && p < 1e5;
        if (priceSaved) db.prepare('UPDATE items SET price = ? WHERE id = ?').run(Math.round(p * 100) / 100, item.id);
        return { itemId: item.id, name: item.name, entryId, action, created, quantity: db.prepare('SELECT quantity FROM list_entries WHERE id = ?').get(entryId).quantity, priceSaved };
      })();
    },
    audit: (actorId, action, target = null, detail = null) => audit(db, actorId, action, target, detail),
  });
}
