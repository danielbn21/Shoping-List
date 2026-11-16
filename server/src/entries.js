// RULE (1.4.5): a list's "past items" are the rows of list_items. Every code path that puts an item on a list, records a
// purchase for it on a list, or imports it into a list MUST call rememberForList(). Writers today: addToList (below),
// POST /api/lists/:id/entries, CSV import (every created/updated row, whatever its quantity) and receipt-review apply.
// Any new writer (e.g. unplanned trips in 1.5.0) must follow it too.
export function rememberForList(db, listId, itemId, at = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO list_items(list_id, item_id, added_at) VALUES (?, ?, ?)').run(listId, itemId, at);
}

// Tick (move to the cart) or untick an entry, starting the list's open trip when the first item goes in the cart and dropping it when the last one leaves.
// Used by POST /api/entries/:id/check and by the scan API for modules.
export function checkEntry(db, { entry, householdId, userId, checked }) {
  const now = Date.now();
  const openTrip = db.prepare('SELECT 1 FROM trips WHERE list_id = ? AND finished_at IS NULL');
  if (checked) {
    db.prepare("UPDATE list_entries SET state = 'in_cart', checked_by = ?, checked_at = ?, updated_at = ? WHERE id = ?").run(userId, now, now, entry.id);
    if (!openTrip.get(entry.list_id)) db.prepare('INSERT INTO trips(household_id, list_id, shopper_id, started_at) VALUES (?,?,?,?)').run(householdId, entry.list_id, userId, now);
  } else {
    db.prepare("UPDATE list_entries SET state = 'open', checked_by = NULL, checked_at = NULL, updated_at = ? WHERE id = ?").run(now, entry.id);
    const left = db.prepare("SELECT COUNT(*) c FROM list_entries WHERE list_id = ? AND state = 'in_cart' AND deleted = 0").get(entry.list_id).c;
    if (!left) db.prepare('DELETE FROM trips WHERE list_id = ? AND finished_at IS NULL').run(entry.list_id); // nobody is shopping any more
  }
}

// Put an item on a list: merge into the open entry if there is one, otherwise append at the end.
export function addToList(db, { listId, item, quantity, note = null, userId }) {
  const now = Date.now();
  rememberForList(db, listId, item.id, now);
  if (item.archived) db.prepare('UPDATE items SET archived = 0 WHERE id = ?').run(item.id);
  const ex = db.prepare("SELECT id FROM list_entries WHERE list_id = ? AND item_id = ? AND deleted = 0 AND state = 'open'").get(listId, item.id);
  if (ex) {
    db.prepare('UPDATE list_entries SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(quantity, now, ex.id);
    return { entryId: ex.id, merged: true };
  }
  const id = Number(db.prepare(`INSERT INTO list_entries(list_id, item_id, quantity, unit, note, added_by, added_at, updated_at, position)
    VALUES (?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(position), 0) + 1 FROM list_entries WHERE list_id = ?))`)
    .run(listId, item.id, quantity, item.default_unit, note ?? item.default_note ?? null, userId, now, now, listId).lastInsertRowid);
  return { entryId: id, merged: false };
}
