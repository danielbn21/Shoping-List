// Shared permission helpers for routes that touch households, lists and entries.
export function makeAccess(db) {
  const householdRole = (userId, hid) =>
    db.prepare('SELECT role FROM household_members WHERE household_id = ? AND user_id = ?').get(hid, userId)?.role ?? null;

  // Effective list role: owner | contributor (editor) | viewer (shopper), or null for no access.
  function listAccess(user, listId) {
    const list = db.prepare('SELECT * FROM lists WHERE id = ? AND archived = 0').get(listId);
    if (!list) return null;
    const hRole = householdRole(user.id, list.household_id);
    const lRole = db.prepare('SELECT role FROM list_members WHERE list_id = ? AND user_id = ?').get(listId, user.id)?.role ?? null;
    if (list.visibility === 'private') return lRole ? { list, role: lRole } : null;
    if (!hRole && !lRole) return null;
    if (lRole === 'owner' || (!lRole && hRole === 'owner')) return { list, role: 'owner' };
    return { list, role: lRole ?? 'contributor' };
  }
  const canEdit = (acc) => acc.role === 'owner' || acc.role === 'contributor';

  const entryAccess = (user, entryId) => {
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ? AND deleted = 0').get(entryId);
    if (!e) return null;
    const acc = listAccess(user, e.list_id);
    return acc ? { entry: e, acc } : null;
  };

  return { householdRole, listAccess, canEdit, entryAccess };
}
