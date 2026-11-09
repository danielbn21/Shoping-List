import { publicChain } from './chains.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const round2 = (n) => Math.round(n * 100) / 100;
const CITY_KEY = /^[\p{L}\d\s'’".\-]{1,60}$/u;

// Price comparison for one list. Everyone who can see the list can look (a Shopper at the checkout included);
// choosing the cities, chains and branches is an Editor/Owner job and lives in Manage list.
// Receipt prices are read through the core's read API; this module only owns the chain links and the selections.
export default function compareRoutes(ctx, { chains, dir }) {
  const { db, core } = ctx;

  const selectionOf = (listId) => db.prepare('SELECT chain, branch_id, branch_name FROM list_compare_stores WHERE list_id = ? ORDER BY position, id').all(listId)
    .filter((r) => chains.usable(r.chain))
    .map((r) => {
      const b = r.branch_id ? dir.getBranch(r.chain, r.branch_id) : null;
      return { chain: r.chain, branchId: r.branch_id, branchName: b?.name ?? r.branch_name, cityKey: b?.cityKey ?? '', cityName: b?.cityName ?? '', address: b?.address ?? '', banner: b?.banner ?? '' };
    });
  const citiesOf = (listId) => db.prepare('SELECT city_key FROM list_compare_cities WHERE list_id = ? ORDER BY rowid').all(listId)
    .map((r) => ({ key: r.city_key, name: dir.cityName(r.city_key) || `#${r.city_key}` }));

  // The household's stores with the chain each is linked to (the link is this module's data).
  const storesOf = (householdId) => {
    const link = new Map(db.prepare('SELECT store_id, chain FROM store_chain').all().map((r) => [r.store_id, r.chain]));
    return core.householdStores(householdId).map((s) => ({ id: s.id, name: s.name, chain: link.get(s.id) ?? null }));
  };
  const storeIdsOfChain = (householdId, chain) => {
    const ids = new Set(core.householdStores(householdId).map((s) => s.id));
    return db.prepare('SELECT store_id FROM store_chain WHERE chain = ?').all(chain).map((r) => r.store_id).filter((id) => ids.has(id));
  };

  ctx.routes.get('/lists/:id/compare', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    const out = { canEdit: core.canEdit(acc), chains: chains.all().map(publicChain), stores: storesOf(acc.list.household_id), selection: [], cities: [], results: [], openCount: 0, source: 'receipts' };
    out.selection = selectionOf(acc.list.id);
    out.cities = citiesOf(acc.list.id);

    const items = core.listOpenEntries(acc.list.id);
    out.openCount = items.length;

    // One row per chain; the chosen branches are listed under it (live branch prices arrive in a later release).
    const order = [...new Set(out.selection.map((s) => s.chain))];
    const results = order.map((id) => {
      const c = chains.get(id);
      const storeIds = storeIdsOfChain(acc.list.household_id, id);
      let total = 0, priced = 0, asOf = null;
      const missing = [];
      for (const it of items) {
        const p = core.lastPaid({ itemId: it.itemId, storeIds, userId: req.user.id });
        if (p) { total += p.unit_price * it.quantity; priced++; asOf = Math.max(asOf ?? 0, p.purchased_at); }
        else missing.push({ itemId: it.itemId, name: it.name, quantity: it.quantity });
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
  ctx.routes.put('/lists/:id/stores', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    if (!core.canEdit(acc)) return bad(reply, 'forbidden', 403);
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

  // Link (or unlink, chain: null) one of the household's stores to a supermarket chain.
  ctx.routes.put('/stores/:id/chain', async (req, reply) => {
    const s = core.storeAccess(req.user, req.params.id);
    if (!s) return bad(reply, 'not_found', 404);
    const chain = (req.body || {}).chain || null;
    if (chain !== null && (typeof chain !== 'string' || !chains.get(chain)?.supported)) return bad(reply, 'invalid_value');
    if (chain) db.prepare('INSERT INTO store_chain(store_id, chain) VALUES (?,?) ON CONFLICT(store_id) DO UPDATE SET chain = excluded.chain').run(s.id, chain);
    else db.prepare('DELETE FROM store_chain WHERE store_id = ?').run(s.id);
    return { ok: true };
  });
}
