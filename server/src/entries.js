// Put an item on a list: merge into the open entry if there is one, otherwise append at the end.
export function addToList(db, { listId, item, quantity, note = null, userId }) {
  const now = Date.now();
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
