import { rank, searchStems, isBarcode } from './matching.js';
import { productOf } from './prices.js';

// Add items autocomplete: the products the list's chosen branches sell, offered while typing, and the match remembered when one is added.
// A price file has a name, brand, pack size and price, but no category and no notes: the category is suggested from the household's own most
// similar item (when it has one), the note is the brand and pack size, the price is shown in the drop-down, and adding the product records it
// as the confirmed match for the new item, so the Compare tab can price it at once.
const packText = (p) => {
  if (!p) return '';
  if (p.unit === 'g') return p.amount >= 1000 ? `${+(p.amount / 1000).toFixed(2)} kg` : `${+p.amount.toFixed(0)} g`;
  if (p.unit === 'ml') return p.amount >= 1000 ? `${+(p.amount / 1000).toFixed(2)} l` : `${+p.amount.toFixed(0)} ml`;
  if (p.unit === 'item') return p.amount === 1 ? '' : `× ${p.amount}`;
  return `${p.amount} ${p.unit}`;
};

export function createCatalog({ db, prices, chains, core, auto }) {
  // The chosen branches of a list that have prices, grouped by chain: Map chain -> [branch ids].
  function branchesWithData(listId) {
    const byChain = new Map();
    for (const r of db.prepare("SELECT chain, branch_id FROM list_compare_stores WHERE list_id = ? AND branch_id != '' ORDER BY position, id").all(listId)) {
      if (!chains.usable(r.chain) || !prices.stateOf(r.chain, r.branch_id)?.file_stamp) continue;
      if (!byChain.has(r.chain)) byChain.set(r.chain, []);
      byChain.get(r.chain).push(r.branch_id);
    }
    return byChain;
  }

  function search({ householdId, listId, q, limit = 8 }) {
    const byChain = branchesWithData(listId), stems = searchStems(q);
    if (!byChain.size || !stems.length) return [];
    const merged = new Map();   // the same barcode in several chains is one product
    for (const [chainId, ids] of byChain) {
      const ranked = rank(q, prices.candidateRows(chainId, ids, stems, 1500).map(productOf), { limit: 10 });
      for (const p of ranked) {
        const key = isBarcode(p.code, p.itemType) ? p.code : `${chainId}:${p.code}`;
        const e = merged.get(key) ?? { p, score: p.score, chains: [], prices: [] };
        e.score = Math.max(e.score, p.score);
        e.chains.push(chains.get(chainId));
        e.prices.push(p.price);
        merged.set(key, e);
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || b.chains.length - a.chains.length || a.p.name.length - b.p.name.length)
      .slice(0, limit)
      .map((e) => {
        const lo = Math.min(...e.prices), hi = Math.max(...e.prices);
        const like = core.similarItem(householdId, e.p.name);
        return {
          name: e.p.name, note: [e.p.manufacturer, e.p.weighted ? '' : packText(e.p.pack)].filter(Boolean).join(' · '),
          categoryId: like?.categoryId ?? null, price: lo, priceMax: hi > lo ? hi : null, currency: 'ILS', perKg: !!e.p.weighted,
          chains: e.chains.map((c) => ({ nameEn: c.nameEn, nameHe: c.nameHe })),
          ref: { chain: e.chains[0].id, code: e.p.code },
        };
      });
  }

  // The user added the product to a list: it becomes the confirmed match for that item at that chain (never over a choice they made themselves).
  function afterAdd({ householdId, listId, itemId, ref }) {
    if (!ref || typeof ref.chain !== 'string' || typeof ref.code !== 'string') return;
    const ids = branchesWithData(listId).get(ref.chain) ?? [];
    const row = ids.map((id) => prices.priceAt(ref.chain, id, ref.code)).find(Boolean);
    if (!row) return;
    const own = db.prepare("SELECT 1 FROM product_map WHERE household_id = ? AND item_id = ? AND chain = ? AND status != 'auto'").get(householdId, itemId, ref.chain);
    if (own) return;
    db.prepare(`INSERT INTO product_map(household_id, item_id, chain, status, code, item_type, name, manufacturer, pack_amount, pack_unit, weighted, amount_kg, source_chain, source_code, confirmed_by, confirmed_at)
      VALUES (?,?,?,'confirmed',?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)
      ON CONFLICT(household_id, item_id, chain) DO UPDATE SET status = 'confirmed', code = excluded.code, item_type = excluded.item_type, name = excluded.name, manufacturer = excluded.manufacturer,
        pack_amount = excluded.pack_amount, pack_unit = excluded.pack_unit, weighted = excluded.weighted, amount_kg = excluded.amount_kg, source_chain = NULL, source_code = NULL, confirmed_at = excluded.confirmed_at`)
      .run(householdId, itemId, ref.chain, row.code, row.item_type, row.name, row.manufacturer || '', row.pack_amount, row.pack_unit, row.weighted, row.weighted ? 1 : null, Date.now());
    auto.forgetDerived(householdId, itemId, ref.chain);
  }

  return { search, afterAdd };
}
