import { publicChain } from './chains.js';
import { rank, searchStems, isBarcode, packsDiffer, norm } from './matching.js';
import { productOf, stampToMs } from './prices.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const round2 = (n) => Math.round(n * 100) / 100;
const CITY_KEY = /^[\p{L}\d\s'’".\-]{1,60}$/u;

// Price comparison for one list. Everyone who can see the list can look (a Shopper at the checkout included); choosing cities, chains and
// branches and matching products to items is an Editor/Owner job. Prices come from the branches' daily files (see prices.js) and are matched
// to the household's items by a confirmation that is remembered per household, item and chain; receipt prices stay as a labelled fallback.
export default function compareRoutes(ctx, { chains, dir, prices, auto, oldAfterDays }) {
  const { db, core } = ctx;
  const now = () => Date.now();
  const DAY = 86_400_000;

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
  const branchesOf = (selection) => selection.filter((s) => s.branchId).map((s) => ({ chain: s.chain, storeId: s.branchId }));

  // What the household has confirmed: { 'itemId|chain' -> row } and, per item, a barcode confirmed at any chain (it is the same product everywhere).
  function mappingsOf(householdId) {
    const rows = db.prepare('SELECT * FROM product_map WHERE household_id = ?').all(householdId);
    const byKey = new Map(), barcode = new Map();
    for (const r of rows) {
      byKey.set(`${r.item_id}|${r.chain}`, r);
      if (r.status === 'confirmed' && isBarcode(r.code, r.item_type) && !barcode.has(r.item_id)) barcode.set(r.item_id, { code: r.code, chain: r.chain, name: r.name });   // only the user's own choices spread by barcode
    }
    return { byKey, barcode };
  }

  // The product an item stands for at a branch, and how it was found: the household's confirmed or carried-over choice (by code, or by exact
  // name when the branch uses another code), or a barcode confirmed at another chain.
  function resolve({ it, chain, branchId, maps }) {
    const m = maps.byKey.get(`${it.itemId}|${chain}`);
    if (m?.status === 'none') return { missing: 'marked' };
    if (!branchId) return { missing: 'needsMatch' };
    // The user's own choice wins; then an exact barcode confirmed at another chain; then what was carried over by name.
    if (m?.code && m.status === 'confirmed') {
      let row = prices.priceAt(chain, branchId, m.code), via = 'confirmed';
      if (!row && m.name) { row = prices.rowByName(chain, branchId, norm(m.name)); via = 'sameName'; }
      return row ? { row, via, m } : { missing: 'notAtBranch' };
    }
    const bc = maps.barcode.get(it.itemId);
    if (bc && bc.chain !== chain) { const row = prices.priceAt(chain, branchId, bc.code); if (row) return { row, via: 'barcode' }; }
    if (m?.code) {
      let row = prices.priceAt(chain, branchId, m.code), via = 'auto';
      if (!row && m.name) { row = prices.rowByName(chain, branchId, norm(m.name)); via = 'sameName'; }
      return row ? { row, via, m } : { missing: 'notAtBranch' };
    }
    return { missing: 'needsMatch' };
  }

  // The prices of one chosen branch for the list's open items.
  function priceBranch({ sel, items, maps, userId, householdId }) {
    const chain = chains.get(sel.chain);
    const st = sel.branchId ? prices.stateOf(sel.chain, sel.branchId) : null;
    const receiptStores = storeIdsOfChain(householdId, sel.chain);
    const oldMs = oldAfterDays() * DAY;
    const lines = [], needsMatch = [], notSold = [];
    let total = 0, receiptCount = 0, oldCount = 0;
    for (const it of items) {
      const r = resolve({ it, chain: sel.chain, branchId: sel.branchId, maps });
      let line = null, missing = r.missing;
      if (r.row) {
        const product = productOf(r.row);
        const amountKg = product.weighted ? (r.m?.amount_kg ?? 1) : null;
        const lineTotal = round2(product.price * it.quantity * (amountKg ?? 1));
        const seen = stampToMs(r.row.seen_file);
        const old = !!seen && now() - seen > oldMs;
        line = { itemId: it.itemId, name: it.name, quantity: it.quantity, via: r.via, autoFrom: r.via === 'auto' ? r.m.source_chain : undefined, product, amountKg, lineTotal, old };
      }
      if (!line && missing !== 'marked' && receiptStores.length) {
        const p = core.lastPaid({ itemId: it.itemId, storeIds: receiptStores, userId });
        if (p) line = { itemId: it.itemId, name: it.name, quantity: it.quantity, via: 'receipt', product: null, amountKg: null, lineTotal: round2(p.unit_price * it.quantity), old: false, paidAt: p.purchased_at, unitPrice: p.unit_price };
      }
      if (line) { lines.push(line); total += line.lineTotal; if (line.via === 'receipt') receiptCount++; if (line.old) oldCount++; }
      else if (missing === 'needsMatch') needsMatch.push({ itemId: it.itemId, name: it.name, quantity: it.quantity });
      else notSold.push({ itemId: it.itemId, name: it.name, quantity: it.quantity, reason: missing });
    }
    return {
      chain: sel.chain, nameEn: chain.nameEn, nameHe: chain.nameHe, branchId: sel.branchId, branchName: sel.branchName, cityName: sel.cityName, address: sel.address, banner: sel.banner,
      total: lines.length ? round2(total) : null, priced: lines.length, receiptCount, oldCount, of: items.length, lines, needsMatch, notSold,
      asOf: st?.file_stamp ? stampToMs(st.file_stamp) : null, checkedAt: st?.checked_at ?? null, error: st?.error ?? null, hasData: !!st?.file_stamp,
    };
  }

  ctx.routes.get('/lists/:id/compare', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    const selection = selectionOf(acc.list.id);
    const items = core.listOpenEntries(acc.list.id);
    const maps = mappingsOf(acc.list.household_id);
    // Lazy: the first look after the refresh interval starts reading the selected branches' files in the background.
    const started = prices.start(branchesOf(selection));
    // One confirmation is enough: clear matches are carried over to the other chains (and the other branches use the same product by code or name).
    const byChain = new Map();
    for (const s of selection) if (s.branchId && prices.stateOf(s.chain, s.branchId)?.file_stamp) { if (!byChain.has(s.chain)) byChain.set(s.chain, []); byChain.get(s.chain).push(s.branchId); }
    auto.run({ householdId: acc.list.household_id, items, byChain, maps });

    // A chain chosen without a branch has no shelf prices: it is priced from receipts only (and says so in the screen).
    const withBranch = new Set(selection.filter((s) => s.branchId).map((s) => s.chain));
    const results = selection.filter((s) => s.branchId || !withBranch.has(s.chain)).map((sel) => priceBranch({ sel, items, maps, userId: req.user.id, householdId: acc.list.household_id }));
    // Different pack sizes for the same item make shelf prices misleading: mark those lines so the screen shows the unit price too.
    const packs = new Map();
    for (const r of results) for (const l of r.lines) if (l.product?.pack) { if (!packs.has(l.itemId)) packs.set(l.itemId, []); packs.get(l.itemId).push(l.product.pack); }
    for (const r of results) for (const l of r.lines) { const ps = packs.get(l.itemId); l.sizeDiffers = !!l.product?.pack && ps.some((p) => packsDiffer(p, l.product.pack)); }
    // Best coverage first, then cheapest: a low total from a branch that prices only a few items is not a bargain.
    results.sort((a, b) => (b.priced - a.priced) || ((a.total ?? Infinity) - (b.total ?? Infinity)));

    // Items to match, once per chain: what no chosen branch of the chain can price and that has no choice yet (all its branches share it).
    const matchGroups = [];
    for (const [chainId] of byChain) {
      const rows = results.filter((r) => r.chain === chainId && r.hasData);
      const ids = rows[0]?.needsMatch.map((m) => m.itemId).filter((id) => rows.every((r) => r.needsMatch.some((m) => m.itemId === id))) ?? [];
      if (!ids.length) continue;
      const ch = chains.get(chainId);
      matchGroups.push({ chain: chainId, nameEn: ch.nameEn, nameHe: ch.nameHe, items: rows[0].needsMatch.filter((m) => ids.includes(m.itemId)) });
    }
    const st = prices.status();
    const ok = st?.results?.filter((x) => x.ok && !x.skipped).length ?? 0, same = st?.results?.filter((x) => x.ok && x.skipped).length ?? 0, failed = st?.results?.filter((x) => !x.ok).length ?? 0;
    return {
      canEdit: core.canEdit(acc), chains: chains.all().map(publicChain), stores: storesOf(acc.list.household_id), selection, cities: citiesOf(acc.list.id),
      results, matchGroups, openCount: items.length,
      prices: {
        running: !!st?.running, done: st?.done ?? 0, total: st?.total ?? 0, current: st?.current ?? null, startedNow: !!started.started,
        refreshHours: prices.interval() / 3_600_000, oldAfterDays: oldAfterDays(),
        lastJob: st && !st.running ? { finishedAt: st.finishedAt, updated: ok, unchanged: same, failed } : null,
      },
    };
  });

  ctx.routes.get('/lists/:id/prices/status', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    const st = prices.status();
    return { running: !!st?.running, done: st?.done ?? 0, total: st?.total ?? 0, current: st?.current ?? null, results: st?.results ?? [] };
  });

  // Refresh prices: read the selected branches' newest files now (a branch checked in the last few minutes is left alone).
  ctx.routes.post('/lists/:id/prices/refresh', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    const r = prices.start(branchesOf(selectionOf(acc.list.id)), { force: true });
    return { started: r.started, reason: r.reason ?? null, running: !!prices.status()?.running };
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
    const selection = selectionOf(acc.list.id);
    prices.start(branchesOf(selection)); // new branches are read straight away
    return { selection, cities: citiesOf(acc.list.id) };
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

  /* ---------- matching: which product at this chain is this item? ---------- */

  const mappingShape = (m) => !m ? null : ({ status: m.status, code: m.code, name: m.name, amountKg: m.amount_kg, confirmedAt: m.confirmed_at, autoFrom: m.status === 'auto' ? m.source_chain : null });
  const chainBranches = (acc, chain) => selectionOf(acc.list.id).filter((s) => s.chain === chain && s.branchId).map((s) => s.branchId);

  // Candidates for one item at one chain, from the list's selected branches of that chain. `q` lets the user search with other words.
  ctx.routes.get('/lists/:id/items/:itemId/match', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    const item = core.itemInHousehold(acc.list.household_id, req.params.itemId);
    const chain = String(req.query.chain || '');
    if (!item || !chains.usable(chain)) return bad(reply, 'not_found', 404);
    const q = String(req.query.q || '').trim().slice(0, 80) || item.name;
    const maps = mappingsOf(acc.list.household_id);
    const current = maps.byKey.get(`${item.id}|${chain}`);
    const bc = maps.barcode.get(item.id);
    const branches = chainBranches(acc, chain);
    const withData = branches.filter((b) => prices.stateOf(chain, b)?.file_stamp);
    const out = { item: { id: item.id, name: item.name }, chain, query: q, current: mappingShape(current), viaBarcode: null, candidates: [], branches: branches.length, noData: withData.length === 0 };
    if (!withData.length) return out;
    const rows = prices.candidateRows(chain, withData, searchStems(q));
    let cands = rank(q, rows.map(productOf), { limit: 8 });
    if (bc && bc.chain !== chain) {
      // The same barcode at this chain is the same product: offered first (and used automatically until the user chooses otherwise).
      const hit = withData.map((b) => prices.priceAt(chain, b, bc.code)).find(Boolean);
      if (hit) { out.viaBarcode = { code: bc.code, name: hit.name, from: bc.chain }; cands = [{ ...productOf(hit), score: 2, barcodeMatch: true }, ...cands.filter((c) => c.code !== bc.code)]; }
    }
    out.candidates = cands.map((c) => ({ code: c.code, itemType: c.itemType, name: c.name, manufacturer: c.manufacturer, price: c.price, unitPrice: c.unitPrice, unit: c.unit, unitPer: c.unitPer, weighted: c.weighted, pack: c.pack, score: c.score, barcodeMatch: !!c.barcodeMatch }));
    return out;
  });

  // Confirm a product ({ chain, code, amountKg? }) or say the chain does not sell it ({ chain, none: true }). Editors and Owners only.
  ctx.routes.put('/lists/:id/items/:itemId/match', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    if (!core.canEdit(acc)) return bad(reply, 'forbidden', 403);
    const item = core.itemInHousehold(acc.list.household_id, req.params.itemId);
    const b = req.body || {};
    if (!item || typeof b.chain !== 'string' || !chains.usable(b.chain)) return bad(reply, 'not_found', 404);
    if (b.none === true) {
      db.prepare(`INSERT INTO product_map(household_id, item_id, chain, status, code, item_type, name, amount_kg, confirmed_by, confirmed_at) VALUES (?,?,?,'none',NULL,NULL,NULL,NULL,?,?)
        ON CONFLICT(household_id, item_id, chain) DO UPDATE SET status = 'none', code = NULL, item_type = NULL, name = NULL, manufacturer = NULL, pack_amount = NULL, pack_unit = NULL, weighted = NULL, amount_kg = NULL,
          source_chain = NULL, source_code = NULL, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`)
        .run(acc.list.household_id, item.id, b.chain, req.user.id, now());
      auto.forgetDerived(acc.list.household_id, item.id, b.chain);
    } else {
      if (typeof b.code !== 'string' || !b.code || b.code.length > 40) return bad(reply, 'invalid_value');
      const row = chainBranches(acc, b.chain).map((id) => prices.priceAt(b.chain, id, b.code)).find(Boolean);
      if (!row) return bad(reply, 'unknown_product');
      let amountKg = null;
      if (row.weighted) {
        amountKg = b.amountKg === undefined || b.amountKg === null ? 1 : Number(b.amountKg);
        if (!(amountKg >= 0.01 && amountKg <= 50)) return bad(reply, 'invalid_value');
      }
      db.prepare(`INSERT INTO product_map(household_id, item_id, chain, status, code, item_type, name, manufacturer, pack_amount, pack_unit, weighted, amount_kg, source_chain, source_code, confirmed_by, confirmed_at)
        VALUES (?,?,?,'confirmed',?,?,?,?,?,?,?,?,NULL,NULL,?,?)
        ON CONFLICT(household_id, item_id, chain) DO UPDATE SET status = 'confirmed', code = excluded.code, item_type = excluded.item_type, name = excluded.name, manufacturer = excluded.manufacturer,
          pack_amount = excluded.pack_amount, pack_unit = excluded.pack_unit, weighted = excluded.weighted, amount_kg = excluded.amount_kg, source_chain = NULL, source_code = NULL, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`)
        .run(acc.list.household_id, item.id, b.chain, row.code, row.item_type, row.name, row.manufacturer || '', row.pack_amount, row.pack_unit, row.weighted, amountKg, req.user.id, now());
      auto.forgetDerived(acc.list.household_id, item.id, b.chain);      // what was carried over from the old choice is worked out again
    }
    return { mapping: mappingShape(db.prepare('SELECT * FROM product_map WHERE household_id = ? AND item_id = ? AND chain = ?').get(acc.list.household_id, item.id, b.chain)) };
  });

  // Forget a confirmation (the barcode rule or a new search can then suggest again).
  ctx.routes.delete('/lists/:id/items/:itemId/match', async (req, reply) => {
    const acc = core.listAccess(req.user, req.params.id);
    if (!acc) return bad(reply, 'not_found', 404);
    if (!core.canEdit(acc)) return bad(reply, 'forbidden', 403);
    const chain = String(req.query.chain || '');
    const item = core.itemInHousehold(acc.list.household_id, req.params.itemId);
    if (!item || !chain) return bad(reply, 'not_found', 404);
    db.prepare('DELETE FROM product_map WHERE household_id = ? AND item_id = ? AND chain = ?').run(acc.list.household_id, item.id, chain);
    auto.forgetDerived(acc.list.household_id, item.id, chain);
    return { ok: true };
  });
}
