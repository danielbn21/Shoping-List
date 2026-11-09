import { makeAccess } from '../access.js';
import { audit } from '../util.js';

// The read API modules get instead of SQL access to the core database. Everything here is read-only apart from audit().
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
    audit: (actorId, action, target = null, detail = null) => audit(db, actorId, action, target, detail),
  });
}
