// Working out, once per change, what each item that has no match at a chain probably is there.
//   exact  -> applied as an 'auto' match straight away (the item's name is the product's name)
//   likely / guess -> kept in match_guess and shown pre-filled for the user to accept with one tap
//   nothing close -> kept as "looked, nothing" so the same work is not repeated until something changes
// The work is done a little at a time (a time budget per request) because a household may have hundreds of past items and several chains.

import { phraseKey } from './translate.js';

const VERSION = 'v1';
const WEEK = 7 * 86_400_000;

export function createGuesser({ db, prices, suggester, auto, now = Date.now }) {
  const get = db.prepare('SELECT * FROM match_guess WHERE household_id = ? AND item_id = ? AND chain = ?');
  const put = db.prepare(`INSERT INTO match_guess(household_id, item_id, chain, stamp, code, name, manufacturer, price, score, tier, alts, searched, made_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(household_id, item_id, chain) DO UPDATE SET stamp = excluded.stamp, code = excluded.code, name = excluded.name, manufacturer = excluded.manufacturer, price = excluded.price,
      score = excluded.score, tier = excluded.tier, alts = excluded.alts, searched = excluded.searched, made_at = excluded.made_at`);
  const del = db.prepare('DELETE FROM match_guess WHERE household_id = ? AND item_id = ? AND chain = ?');

  // A product already right at another chain (confirmed first, then matched by name or carried), with its full text from that chain's file.
  function sourceOf(itemId, chain, byChain, maps) {
    const rows = [...maps.byKey.values()].filter((m) => m.item_id === itemId && m.chain !== chain && m.code && (m.status === 'confirmed' || m.status === 'auto'))
      .sort((a, b) => (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1));
    for (const m of rows) {
      const branches = byChain.get(m.chain) ?? [];
      const r = branches.map((b) => prices.priceAt(m.chain, b, m.code)).find(Boolean);
      if (r) return { text: r.description || r.name, manufacturer: r.manufacturer || '', pack: r.pack_amount ? { amount: r.pack_amount, unit: r.pack_unit } : null, key: `${m.chain}:${m.code}` };
      if (m.name) return { text: m.name, manufacturer: m.manufacturer || '', pack: m.pack_amount ? { amount: m.pack_amount, unit: m.pack_unit } : null, key: `${m.chain}:${m.code}` };
    }
    return null;
  }

  // items: [{ itemId, name }] (the list's open items first, then its past items); byChain: Map chain -> branch ids with prices; maps: mappingsOf().
  // -> { made, exact, pending } (pending: items left for the next request because the time budget ran out)
  function run({ householdId, items, byChain, maps, budgetMs = 1200 }) {
    const t0 = Date.now(), xlat = suggester.loadTranslations();
    let made = 0, exact = 0, pending = 0;
    for (const [chain, branchIds] of byChain) {
      if (!branchIds.length) continue;
      // Suggestions hardly change from one daily file to the next, so they are made again weekly (or when a branch gets its first file); a price is always read live when accepted.
      const files = branchIds.map((b) => Math.floor((prices.stateOf(chain, b)?.updated_at ?? 0) / WEEK)).join(',');
      for (const it of items) {
        if (maps.byKey.has(`${it.itemId}|${chain}`)) continue;                      // confirmed, "not sold here", or already matched
        const bc = maps.barcode.get(it.itemId);                                      // the same barcode already prices it here
        if (bc && bc.chain !== chain && branchIds.some((b) => prices.priceAt(chain, b, bc.code))) continue;
        const src = sourceOf(it.itemId, chain, byChain, maps);
        const stamp = [VERSION, it.name, files, src?.key ?? '', xlat.get(phraseKey(it.name)) ?? ''].join('|');
        if (get.get(householdId, it.itemId, chain)?.stamp === stamp) continue;
        if (Date.now() - t0 > budgetMs) { pending++; continue; }
        const r = suggester.suggest({ name: it.name, chain, branchIds, source: src, xlat });
        if (r.kind === 'exact') { auto.applyExact({ householdId, itemId: it.itemId, chain, product: r.best, maps }); del.run(householdId, it.itemId, chain); exact++; continue; }
        const b = r.best;
        put.run(householdId, it.itemId, chain, stamp, b?.code ?? null, b?.name ?? null, b?.manufacturer ?? null, b?.price ?? null, b?.score ?? null, r.kind, JSON.stringify(r.alts), r.searched, now());
        made++;
      }
    }
    return { made, exact, pending };
  }

  // The kept suggestion for an item at a chain: { tier, product, alts, searched } or null.
  function guessOf(householdId, itemId, chain) {
    const g = get.get(householdId, itemId, chain);
    if (!g) return null;
    let alts = []; try { alts = JSON.parse(g.alts || '[]'); } catch { /* keep none */ }
    return { tier: g.tier, searched: g.searched, product: g.code ? { code: g.code, name: g.name, manufacturer: g.manufacturer, price: g.price, score: g.score } : null, alts };
  }

  return { run, guessOf, forget: (householdId, itemId, chain) => del.run(householdId, itemId, chain) };
}
