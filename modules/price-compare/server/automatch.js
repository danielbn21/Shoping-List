import { norm, rank, searchStems, tokens, packsDiffer, isBarcode } from './matching.js';
import { productOf } from './prices.js';

// Matching once for everything. A choice the household confirms at one chain is carried to the other chains by itself when the product is
// clearly the same: the same words (the brand aside), the same pack size when both sides know it, and no other product that fits as well.
// The result is stored as an "auto" mapping that is labelled in the screen and replaced the moment the user chooses something else.
// Anything less certain is left for the user.

const tokenSet = (name, brand) => {
  const skip = new Set(tokens(brand || '').flatMap((t) => [t]));
  return new Set(tokens(name).filter((t) => !skip.has(t)));
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// source: the confirmed product { name, manufacturer, pack_amount, pack_unit, weighted }; rows: candidate rows of the target chain.
export function strongMatch(source, rows) {
  const ranked = rank(source.name, rows.map(productOf), { limit: 3 });
  const best = ranked[0];
  if (!best) return null;
  const want = tokenSet(source.name, source.manufacturer);
  if (!want.size || !sameSet(want, tokenSet(best.name, best.manufacturer))) return null;           // the same words
  if (source.manufacturer && best.manufacturer && norm(source.manufacturer) !== norm(best.manufacturer)) return null; // a different brand is a different product
  const pack = source.pack_amount ? { amount: source.pack_amount, unit: source.pack_unit } : null;
  if (pack && best.pack && packsDiffer(pack, best.pack)) return null;                                // not the same size
  if (!!source.weighted !== !!best.weighted) return null;                                            // sold by weight at one and by the pack at the other
  // another product that fits just as well makes it a guess, not a match
  const rival = ranked.slice(1).find((r) => r.code !== best.code && sameSet(want, tokenSet(r.name, r.manufacturer)) && (!pack || !r.pack || !packsDiffer(pack, r.pack)));
  return rival ? null : best;
}

export function createAutoMatcher({ db, prices, chains, now = Date.now }) {
  const tried = new Map(); // 'household|item|chain' -> what was true when we last tried and found nothing

  const upsertAuto = db.prepare(`INSERT INTO product_map(household_id, item_id, chain, status, code, item_type, name, manufacturer, pack_amount, pack_unit, weighted, amount_kg, source_chain, source_code, auto_via, confirmed_by, confirmed_at)
    VALUES (?,?,?,'auto',?,?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(household_id, item_id, chain) DO NOTHING`);

  // items: the list's open items; byChain: Map chain -> branch ids that have prices; maps: current mappings. Returns how many were created.
  function run({ householdId, items, byChain, maps }) {
    let made = 0;
    for (const it of items) {
      const sources = [...maps.byKey.values()].filter((m) => m.item_id === it.itemId && m.status === 'confirmed' && m.code);
      if (!sources.length) continue;
      for (const [chainId, branchIds] of byChain) {
        if (!branchIds.length || maps.byKey.has(`${it.itemId}|${chainId}`)) continue;
        const srcs = sources.filter((m) => m.chain !== chainId);
        if (!srcs.length) continue;
        const bc = maps.barcode.get(it.itemId);                                   // the same barcode already prices it here: nothing to derive
        if (bc && bc.chain !== chainId && branchIds.some((b) => prices.priceAt(chainId, b, bc.code))) continue;
        const stamp = `${branchIds.map((b) => prices.stateOf(chainId, b)?.updated_at ?? 0).join(',')}|${srcs.map((m) => `${m.chain}:${m.code}:${m.confirmed_at}`).join(',')}`;
        const key = `${householdId}|${it.itemId}|${chainId}`;
        if (tried.get(key) === stamp) continue;
        const found = new Map();
        for (const src of srcs) {
          const rows = prices.candidateRows(chainId, branchIds, searchStems(src.name || ''), 2000);
          const best = strongMatch(src, rows);
          if (best) found.set(best.code, { best, src });
        }
        if (found.size !== 1) { tried.set(key, stamp); continue; }       // nothing sure, or two sources disagree
        const { best, src } = [...found.values()][0];
        const row = rowsOf(chainId, branchIds, best.code);
        upsertAuto.run(householdId, it.itemId, chainId, best.code, row?.item_type ?? 1, best.name, best.manufacturer || '', best.pack?.amount ?? null, best.pack?.unit ?? null,
          best.weighted ? 1 : 0, best.weighted ? (src.amount_kg ?? 1) : null, src.chain, src.code, 'equivalent', now());
        maps.byKey.set(`${it.itemId}|${chainId}`, { household_id: householdId, item_id: it.itemId, chain: chainId, status: 'auto', code: best.code, name: best.name, amount_kg: best.weighted ? (src.amount_kg ?? 1) : null, source_chain: src.chain, auto_via: 'equivalent' });
        made++;
      }
    }
    return made;
  }
  const rowsOf = (chainId, branchIds, code) => branchIds.map((b) => prices.priceAt(chainId, b, code)).find(Boolean);

  // A confirmed choice changed or was forgotten: what was derived from it is derived again.
  const forgetDerived = (householdId, itemId, sourceChain) => db.prepare("DELETE FROM product_map WHERE household_id = ? AND item_id = ? AND status = 'auto' AND source_chain = ?").run(householdId, itemId, sourceChain);

  // The item's name is the product's name: matched without anyone being asked (the screen says "matched by name"). A weighed product is
  // counted as one kilo per list entry until the user says otherwise.
  function applyExact({ householdId, itemId, chain, product, maps }) {
    const kg = product.weighted ? 1 : null;
    upsertAuto.run(householdId, itemId, chain, product.code, product.itemType ?? 1, product.name, product.manufacturer || '', product.pack?.amount ?? null, product.pack?.unit ?? null,
      product.weighted ? 1 : 0, kg, null, null, 'name', now());
    maps.byKey.set(`${itemId}|${chain}`, { household_id: householdId, item_id: itemId, chain, status: 'auto', code: product.code, item_type: product.itemType ?? 1, name: product.name, amount_kg: kg, source_chain: null, auto_via: 'name' });
    // its barcode now prices the item at the other chains too (in this same request), unless the user's own choice already provides one
    if (isBarcode(product.code, product.itemType ?? 1) && !maps.barcode.has(itemId)) maps.barcode.set(itemId, { code: product.code, chain, name: product.name });
  }

  return { run, forgetDerived, applyExact };
}
