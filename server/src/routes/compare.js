import { getSetting } from '../util.js';
import { makeAccess } from '../access.js';
import { CHAINS, chainList } from '../chains.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const round2 = (n) => Math.round(n * 100) / 100;

// Price comparison for one list. Everyone who can see the list can look (a Shopper at the checkout included);
// choosing which chains to compare is an Editor/Owner job and lives in Manage list.
export default async function compareRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { listAccess, canEdit } = makeAccess(db);

  const selectionOf = (listId) => db.prepare('SELECT chain, branch_id, branch_name FROM list_compare_stores WHERE list_id = ? ORDER BY position, id').all(listId)
    .map((r) => ({ chain: r.chain, branchId: r.branch_id, branchName: r.branch_name }));

  // Last price paid for an item at a household store linked to this chain (shekels only; private lists stay private).
  const lastPaid = db.prepare(`SELECT p.unit_price, p.purchased_at
    FROM purchase_events p
    JOIN stores s ON s.id = p.store_id
    LEFT JOIN trips t ON t.id = p.trip_id
    LEFT JOIN lists l ON l.id = p.list_id
    WHERE p.item_id = ? AND s.chain = ? AND s.household_id = ? AND p.unit_price IS NOT NULL
      AND (t.currency IS NULL OR t.currency = 'ILS')
      AND (p.list_id IS NULL OR l.visibility = 'household' OR p.list_id IN (SELECT list_id FROM list_members WHERE user_id = ?))
    ORDER BY p.purchased_at DESC, p.id DESC LIMIT 1`);

  app.get('/api/lists/:id/compare', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    const enabled = !!getSetting(db, 'compare_enabled');
    const out = { enabled, canEdit: canEdit(acc), chains: chainList(), selection: [], results: [], openCount: 0, source: 'receipts' };
    if (!enabled) return out;
    out.selection = selectionOf(acc.list.id);

    const items = db.prepare(`SELECT e.item_id, e.quantity, i.name FROM list_entries e JOIN items i ON i.id = e.item_id
      WHERE e.list_id = ? AND e.deleted = 0 AND e.state = 'open' ORDER BY e.position, e.id`).all(acc.list.id);
    out.openCount = items.length;

    const results = out.selection.map((sel) => {
      const c = CHAINS[sel.chain];
      let total = 0, priced = 0, asOf = null;
      const missing = [];
      for (const it of items) {
        const p = lastPaid.get(it.item_id, sel.chain, acc.list.household_id, req.user.id);
        if (p) { total += p.unit_price * it.quantity; priced++; asOf = Math.max(asOf ?? 0, p.purchased_at); }
        else missing.push({ itemId: it.item_id, name: it.name, quantity: it.quantity });
      }
      return {
        chain: sel.chain, branchId: sel.branchId, branchName: sel.branchName, nameEn: c.nameEn, nameHe: c.nameHe,
        total: priced ? round2(total) : null, priced, of: items.length, missing, asOf, source: 'receipts',
      };
    });
    // Best coverage first, then cheapest. A low total from a store that only prices a few items is not a bargain.
    results.sort((a, b) => (b.priced - a.priced) || ((a.total ?? Infinity) - (b.total ?? Infinity)));
    out.results = results;
    return out;
  });

  app.put('/api/lists/:id/compare/stores', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    if (!getSetting(db, 'compare_enabled')) return bad(reply, 'compare_disabled', 403);
    const sel = (req.body || {}).selection;
    if (!Array.isArray(sel) || sel.length > 30) return bad(reply, 'invalid_value');
    const seen = new Set(), clean = [];
    for (const s of sel) {
      if (!s || !CHAINS[s.chain]) return bad(reply, 'invalid_value');
      if (s.branchId) return bad(reply, 'branches_unavailable'); // branch lists arrive with live prices
      if (seen.has(s.chain)) continue;
      seen.add(s.chain); clean.push(s.chain);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM list_compare_stores WHERE list_id = ?').run(acc.list.id);
      clean.forEach((chain, i) => db.prepare('INSERT INTO list_compare_stores(list_id, chain, branch_id, position) VALUES (?,?,?,?)').run(acc.list.id, chain, '', i));
    })();
    return { selection: selectionOf(acc.list.id) };
  });
}
