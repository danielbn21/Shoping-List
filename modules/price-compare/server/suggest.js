import { norm, rank, searchStems, brandKey } from './matching.js';
import { productOf } from './prices.js';
import { translateQuery, looksEnglish } from './translate.js';

// What may be done with a product that looks like an item, from sure to unsure:
//   exact   the item's name is the product's name (or its full description): applied by itself, unless two products share the name
//   likely  the item's name is the start of one product's description, or one product clearly beats the rest: offered pre-filled, one tap
//   guess   the best of what fits: offered pre-filled, one tap, with the next best as alternatives
// An item typed in English is looked up through its Hebrew translation, so it is never better than a guess.

const MIN_GUESS = 0.7;           // below this nothing is offered
const LIKELY_SCORE = 1.1, LIKELY_MARGIN = 0.12;
const ALTS = 5;

const unique = (rows) => { const seen = new Set(), out = []; for (const r of rows) if (!seen.has(r.code)) { seen.add(r.code); out.push(r); } return out; };

// products: [{ code, name, description, ... }]. Exact: same words as the name or the description; one product only.
export function exactMatch(itemName, products) {
  const qn = norm(itemName);
  if (!qn) return null;
  const hits = unique(products.filter((p) => norm(p.name) === qn || (p.description && norm(p.description) === qn)));
  return hits.length === 1 ? hits[0] : null;
}

// The item's name is the start of one product's description, or a cut-off product name is the start of the item's name (price files cut
// ItemName at 20 characters). One product only.
export function prefixMatch(itemName, products) {
  const qn = norm(itemName);
  if (qn.length < 8) return null;
  const hits = unique(products.filter((p) => {
    const d = norm(p.description || ''), n = norm(p.name);
    return (d && d.startsWith(`${qn} `)) || (n.length >= 12 && qn.startsWith(n) && qn.length > n.length) || (d && qn.startsWith(d) && d.length >= 12);
  }));
  return hits.length === 1 ? hits[0] : null;
}

const shape = (p, score) => ({
  code: p.code, itemType: p.itemType, name: p.name, description: p.description || '', manufacturer: p.manufacturer || '', price: p.price, unitPrice: p.unitPrice ?? null,
  unit: p.unit || '', unitPer: p.unitPer ?? 0, weighted: !!p.weighted, pack: p.pack ?? null, score: Math.round(score * 1000) / 1000,
});

export function createSuggester({ db, prices }) {
  const loadTranslations = () => new Map(db.prepare('SELECT en, he FROM translations').all().map((r) => [r.en, r.he]));

  // One query string: the best products for it at a chain, as [{...product, score}].
  function search(query, chain, branchIds, { source = null, limit = 10 } = {}) {
    const rows = prices.candidateRows(chain, branchIds, searchStems(query), 3000);
    return rank(query, rows.map(productOf), { limit, source });
  }

  // The best candidates for an item at one chain. source: a product known to be right at another chain ({ text, manufacturer, pack }).
  // -> { kind: 'exact'|'likely'|'guess'|null, best, alts, searched, untranslated }
  function suggest({ name, chain, branchIds, source = null, xlat = null }) {
    const english = looksEnglish(name);
    const queries = [];                                             // { text, shown }
    let untranslated = [];
    if (english) {
      const tr = translateQuery(name, { cache: xlat });
      untranslated = tr.unknown;
      for (const s of tr.segments) for (const v of s.variants) queries.push({ text: v });
    } else queries.push({ text: name });
    if (source?.text) queries.push({ text: source.text, source });

    const best = new Map();
    let exactRows = null;
    for (const q of queries) {
      const rows = prices.candidateRows(chain, branchIds, searchStems(q.text), 3000).map(productOf);
      if (!english && !exactRows) exactRows = rows;
      for (const c of rank(q.text, rows, { limit: 10, source: q.source ?? null })) { const o = best.get(c.code); if (!o || c.score > o.score) best.set(c.code, c); }
    }
    const list = [...best.values()].sort((a, b) => b.score - a.score);
    const searched = english ? queries.map((q) => q.text).filter(Boolean).join(' · ') : null;

    if (!english && exactRows) {
      const ex = exactMatch(name, exactRows);
      if (ex) return { kind: 'exact', best: shape(ex, 1.2), alts: [], searched, untranslated };
      const pre = prefixMatch(name, exactRows);
      if (pre) {
        const alts = list.filter((c) => c.code !== pre.code).slice(0, ALTS).map((c) => shape(c, c.score));
        return { kind: 'likely', best: shape(pre, list.find((c) => c.code === pre.code)?.score ?? 1), alts, searched, untranslated };
      }
    }
    if (!list.length || list[0].score < MIN_GUESS) return { kind: null, best: null, alts: list.slice(0, ALTS).map((c) => shape(c, c.score)), searched, untranslated };
    const top = list[0], margin = top.score - (list[1]?.score ?? 0);
    const sourced = !!source && brandKey(source.manufacturer) && brandKey(source.manufacturer) === brandKey(top.manufacturer) && source.pack && top.pack && !(source.pack.unit !== top.pack.unit);
    const likely = !english && top.score >= LIKELY_SCORE && margin >= LIKELY_MARGIN;
    const kind = likely || (sourced && top.score >= 1.05 && margin >= 0.05) ? 'likely' : 'guess';
    return { kind, best: shape(top, top.score), alts: list.slice(1, 1 + ALTS).map((c) => shape(c, c.score)), searched, untranslated };
  }

  // The ranked candidates for the match panel (what the user typed, or the item's name), English words translated: [{...product, score}], best first.
  function candidates({ name, chain, branchIds, limit = 8, xlat = null }) {
    const queries = [];
    if (looksEnglish(name)) { for (const s of translateQuery(name, { cache: xlat }).segments) for (const v of s.variants) queries.push(v); } else queries.push(name);
    const best = new Map();
    for (const q of queries) for (const c of search(q, chain, branchIds, { limit })) { const o = best.get(c.code); if (!o || c.score > o.score) best.set(c.code, c); }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { suggest, search, candidates, loadTranslations };
}
