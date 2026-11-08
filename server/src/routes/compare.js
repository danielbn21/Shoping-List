import { getSetting } from '../util.js';
import { makeAccess } from '../access.js';
import { makeChains, publicChain } from '../chains.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const round2 = (n) => Math.round(n * 100) / 100;
const CITY_KEY = /^[\p{L}\d\s'’".\-]{1,60}$/u;

// Price comparison for one list. Everyone who can see the list can look (a Shopper at the checkout included);
// choosing the cities, chains and branches is an Editor/Owner job and lives in Manage list.
export default async function compareRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { listAccess, canEdit } = makeAccess(db);
  const chains = makeChains(db);
  const dir = app.directory;

  const selectionOf = (listId) => db.prepare('SELECT chain, branch_id, branch_name FROM list_compare_stores WHERE list_id = ? ORDER BY position, id').all(listId)
    .filter((r) => chains.usable(r.chain))
    .map((r) => {
      const b = r.branch_id ? dir.getBranch(r.chain, r.branch_id) : null;
      return { chain: r.chain, branchId: r.branch_id, branchName: b?.name ?? r.branch_name, cityKey: b?.cityKey ?? '', cityName: b?.cityName ?? '', address: b?.address ?? '', banner: b?.banner ?? '' };
    });
  const citiesOf = (listId) => db.prepare('SELECT city_key FROM list_compare_cities WHERE list_id = ? ORDER BY rowid').all(listId)
    .map((r) => ({ key: r.city_key, name: dir.cityName(r.city_key) || `#${r.city_key}` }));

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
    const out = { enabled, canEdit: canEdit(acc), chains: chains.all().map(publicChain), selection: [], cities: [], results: [], openCount: 0, source: 'receipts' };
    if (!enabled) return out;
    out.selection = selectionOf(acc.list.id);
    out.cities = citiesOf(acc.list.id);

    const items = db.prepare(`SELECT e.item_id, e.quantity, i.name FROM list_entries e JOIN items i ON i.id = e.item_id
      WHERE e.list_id = ? AND e.deleted = 0 AND e.state = 'open' ORDER BY e.position, e.id`).all(acc.list.id);
    out.openCount = items.length;

    // One row per chain; the chosen branches are listed under it (live branch prices arrive in a later release).
    const order = [...new Set(out.selection.map((s) => s.chain))];
    const results = order.map((id) => {
      const c = chains.get(id);
      let total = 0, priced = 0, asOf = null;
      const missing = [];
      for (const it of items) {
        const p = lastPaid.get(it.item_id, id, acc.list.household_id, req.user.id);
        if (p) { total += p.unit_price * it.quantity; priced++; asOf = Math.max(asOf ?? 0, p.purchased_at); }
        else missing.push({ itemId: it.item_id, name: it.name, quantity: it.quantity });
      }
      return {
        chain: id, nameEn: c.nameEn, nameHe: c.nameHe,
        branches: out.selection.filter((s) => s.chain === id && s.branchId).map((s) => ({ storeId: s.branchId, name: s.branchName, cityName: s.cityName })),
        total: priced ? round2(total) : null, priced, of: items.length, missing, asOf, source: 'receipts',
      };
    });
    // Best coverage first, then cheapest. A low total from a store that only prices a few items is not a bargain.
    results.sort((a, b) => (b.priced - a.priced) || ((a.total ?? Infinity) - (b.total ?? Infinity)));
    out.results = results;
    return out;
  });

  // Replace the selection: [{chain, branchId?}] and, optionally, the cities the pickers were filtered by.
  app.put('/api/lists/:id/compare/stores', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    if (!getSetting(db, 'compare_enabled')) return bad(reply, 'compare_disabled', 403);
    const { selection: sel, cities } = req.body || {};
    if (!Array.isArray(sel) || sel.length > 120) return bad(reply, 'invalid_value');
    if (cities !== undefined && (!Array.isArray(cities) || cities.length > 40 || cities.some((c) => typeof c !== 'string' || !CITY_KEY.test(c)))) return bad(reply, 'invalid_value');

    const seen = new Set(), clean = [];
    const add = (chain, branchId, branchName) => { const k = `${chain}|${branchId}`; if (!seen.has(k)) { seen.add(k); clean.push({ chain, branchId, branchName }); } };
    for (const s of sel) {
      if (!s || typeof s.chain !== 'string' || !chains.usable(s.chain)) return bad(reply, 'invalid_value');
      const bid = s.branchId === undefined || s.branchId === null || s.branchId === '' ? '' : String(s.branchId);
      if (!bid) { add(s.chain, '', null); continue; }
      const b = dir.getBranch(s.chain, bid);
      if (!b) return bad(reply, 'unknown_branch');
      add(s.chain, '', null); // a chosen branch always keeps its chain selected
      add(s.chain, b.storeId, b.name);
    }
    db.transaction(() => {
      db.prepare('DELETE FROM list_compare_stores WHERE list_id = ?').run(acc.list.id);
      clean.forEach((c, i) => db.prepare('INSERT INTO list_compare_stores(list_id, chain, branch_id, branch_name, position) VALUES (?,?,?,?,?)').run(acc.list.id, c.chain, c.branchId, c.branchName, i));
      if (cities !== undefined) {
        db.prepare('DELETE FROM list_compare_cities WHERE list_id = ?').run(acc.list.id);
        for (const c of [...new Set(cities)]) db.prepare('INSERT INTO list_compare_cities(list_id, city_key) VALUES (?,?)').run(acc.list.id, c);
      }
    })();
    return { selection: selectionOf(acc.list.id), cities: citiesOf(acc.list.id) };
  });
}
