import { productOf } from './prices.js';

// The spellings a barcode can have in a price file: with or without leading zeros, as UPC-A (12), EAN-13 or a 14-digit GTIN.
export function codeVariants(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 14) return [];
  const s = d.replace(/^0+/, '') || '0';
  const out = new Set([d, s]);
  for (const n of [8, 12, 13, 14]) if (s.length <= n) out.add(s.padStart(n, '0'));
  return [...out];
}

// 'barcode-lookup' capability: which product is this barcode, and what does it cost where the household shops?
// Only the branches whose price files this module already reads are searched. A chain's own short codes (item_type 0) are never barcodes.
// The price comes from the first of these that has the product, and is the lowest there:
//   'store': the chain of the household store chosen in Shop (its chosen branches first, else any branch of the chain)
//   'list':  the branches chosen for the list in Compare prices
//   'any':   any branch that has been read (the name is right, the price may be far from where you stand)
export function createBarcodeLookup({ db, chains }) {
  const chainOf = db.prepare('SELECT chain FROM store_chain WHERE store_id = ?');
  const chosenOf = db.prepare('SELECT chain, branch_id, branch_name FROM list_compare_stores WHERE list_id = ?');
  const branchName = db.prepare('SELECT name FROM portal_branches WHERE chain = ? AND store_id = ?');
  const cheapest = (rows) => rows.slice().sort((a, b) => a.price - b.price || (b.seen_file > a.seen_file ? 1 : -1))[0];

  function find({ listId, storeId, code }) {
    const variants = codeVariants(code);
    if (!variants.length) return null;
    const rows = db.prepare(`SELECT * FROM branch_prices WHERE code IN (${variants.map(() => '?').join(',')}) AND item_type != 0`).all(...variants);
    if (!rows.length) return null;
    const chosen = listId ? chosenOf.all(Number(listId)) : [];
    const inChosen = (r) => chosen.some((c) => c.chain === r.chain && (c.branch_id === '' || String(c.branch_id) === String(r.store_id)));
    const storeChain = storeId ? chainOf.get(Number(storeId))?.chain ?? null : null;

    let pick = null, via = 'any';
    if (storeChain) {
      const ofChain = rows.filter((r) => r.chain === storeChain);
      const mine = ofChain.filter(inChosen);
      pick = cheapest(mine.length ? mine : ofChain); via = 'store';
    }
    if (!pick) { const mine = rows.filter(inChosen); if (mine.length) { pick = cheapest(mine); via = 'list'; } }
    if (!pick) { pick = cheapest(rows); via = 'any'; }

    // The same barcode is the same product everywhere, so the name comes from the chosen row (the one that matches where the user is).
    const c = chains.get(pick.chain);
    const sel = chosen.find((x) => x.chain === pick.chain && String(x.branch_id) === String(pick.store_id));
    return {
      ...productOf(pick), chain: pick.chain, chainNameEn: c?.nameEn ?? pick.chain, chainNameHe: c?.nameHe ?? pick.chain,
      branchId: pick.store_id, branchName: sel?.branch_name ?? branchName.get(pick.chain, pick.store_id)?.name ?? null, via,
    };
  }
  return { find };
}
