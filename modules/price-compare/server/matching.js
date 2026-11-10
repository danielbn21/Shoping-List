// Deterministic product matching: no AI, no network. Given what the household calls an item ("חלב", "tomatoes") and the products a
// branch sells, rank the likely candidates; the user confirms one, and that choice is remembered per household, item and chain.

const NIQQUD = /[\u0591-\u05C7]/g;
const FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Lower case, no vowel marks, final letters folded, quotes dropped (מ"ל -> מל, ג'ינג'ר -> גינגר), everything else that is not a letter or digit becomes a space.
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\u05BE/g, ' ').replace(NIQQUD, '').replace(/[ךםןףץ]/g, (c) => FINAL[c])
  .replace(/["'’״׳`´]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Words that say nothing about the product (units, sizes, joining words). Written naturally and folded like everything else.
const NOISE = new Set(['גרם', 'גר', 'ק"ג', 'קילוגרם', 'מ"ל', 'מיליליטר', 'ליטר', 'יח', 'יחידות', 'יחידה', 'מטר', 'של', 'עם', 'ללא', 'בטעם', 'ml', 'gr', 'kg', 'g', 'l', 'pcs', 'with', 'of', 'the', 'and'].map((w) => norm(w)));
export const tokens = (s) => norm(s).split(' ').filter((t) => t && !/^\d+$/.test(t) && !NOISE.has(t));

const PROCLITIC = 'הובכלמש';
// written in folded form too (norm turns the final ם of ים into מ)
const SUFFIXES = ['ימ', 'ים', 'ות', 'ה', 'ת', 'י'];

// All the spellings a word may legitimately take: with or without one Hebrew prefix letter, with or without a plural or feminine ending,
// English plural "s" removed. Two words match when their sets share an entry of at least 3 letters.
export function variants(tok) {
  const out = new Set([tok]);
  if (/^[a-z]/.test(tok)) { if (tok.length > 3 && tok.endsWith('s')) out.add(tok.slice(0, -1)); if (tok.length > 4 && tok.endsWith('es')) out.add(tok.slice(0, -2)); return out; }
  const bases = [tok];
  if (tok.length > 3 && PROCLITIC.includes(tok[0])) { bases.push(tok.slice(1)); out.add(tok.slice(1)); }
  // up to two endings (עגבנייה -> עגבניי -> עגבני) so that singular, plural and feminine forms meet
  const strip = (w, depth) => { for (const suf of SUFFIXES) if (w.length - suf.length >= 3 && w.endsWith(suf)) { const r = w.slice(0, -suf.length); out.add(r); if (depth > 1) strip(r, depth - 1); } };
  for (const b of bases) strip(b, 2);
  return out;
}
const sharesVariant = (a, b) => { for (const v of a) if (v.length >= 3 && b.has(v)) return true; return false; };

// 1 for the same word (allowing prefix letters and plurals), 0.7 when one is the start of the other (עגבני / עגבניות), else 0.
function tokenScore(q, c) {
  if (q === c) return 1;
  const qv = variants(q), cv = variants(c);
  if (sharesVariant(qv, cv)) return 1;
  for (const a of qv) for (const b of cv) if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)) && Math.min(a.length, b.length) >= 3) return 0.7;
  return 0;
}

// Things nobody means unless they say so: the query must contain one of the group's words for such products to be offered.
const EXCLUDE = [
  ['קפוא', 'קפואה', 'קפואים', 'קפואות', 'מוקפא', 'מוקפאים', 'frozen'],
  ['כבוש', 'כבושים', 'כבושה', 'חמוצים', 'pickled', 'pickles', 'pickle'],
  ['לכלב', 'לכלבים', 'לחתול', 'לחתולים', 'לחיות', 'pet'],
  ['פיקדון', 'בקבוק חוזר', 'deposit'],
].map((g) => g.map(norm));
const hasWord = (normalized, w) => ` ${normalized} `.includes(` ${w} `);

export function excludedFor(queryName, candidateName) {
  const q = norm(queryName), c = norm(candidateName);
  return EXCLUDE.some((g) => g.some((w) => hasWord(c, w)) && !g.some((w) => hasWord(q, w)));
}

// candidates: [{ name, manufacturer?, price?, ... }] -> the same objects with `score` (0..1.2), best first, at most `limit`.
export function rank(queryName, candidates, { limit = 8 } = {}) {
  const qt = tokens(queryName);
  if (!qt.length) return [];
  const qn = norm(queryName);
  const scored = [];
  for (const cand of candidates) {
    if (excludedFor(queryName, cand.name)) continue;
    const ct = tokens(cand.name), mt = tokens(cand.manufacturer || '');
    let sum = 0, matchedNameTokens = new Set();
    for (const q of qt) {
      let best = 0, bestIdx = -1;
      ct.forEach((c, i) => { const s = tokenScore(q, c); if (s > best) { best = s; bestIdx = i; } });
      const brand = mt.reduce((m, c) => Math.max(m, tokenScore(q, c) * 0.8), 0);
      if (brand > best) best = brand; else if (bestIdx >= 0 && best > 0) matchedNameTokens.add(bestIdx);
      sum += best;
    }
    const coverage = sum / qt.length;
    if (coverage < (qt.length === 1 ? 0.7 : 0.5)) continue;
    const matched = matchedNameTokens.size, extra = Math.max(0, ct.length - matched);
    const precision = ct.length ? matched / (matched + extra * 0.5) : 0;
    let score = coverage * 0.75 + precision * 0.25;
    if (ct[0] && tokenScore(qt[0], ct[0]) >= 1) score += 0.05;
    if (norm(cand.name) === qn) score += 0.1;
    scored.push({ ...cand, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score || tokens(a.name).length - tokens(b.name).length || (a.price ?? 0) - (b.price ?? 0) || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, limit);
}

// The shortest useful spellings of a query's words, for a database pre-filter (LIKE '%…%' on the normalised name).
export function searchStems(queryName) {
  const stems = new Set();
  for (const t of tokens(queryName)) {
    const vs = [...variants(t)].filter((v) => v.length >= 3).sort((a, b) => a.length - b.length);
    if (vs.length) stems.add(vs[0]); else if (t.length >= 2) stems.add(t);
  }
  return [...stems];
}

/* ---------- pack sizes ---------- */

// The pack size in a price file: Quantity + UnitQty ("500", "גרם"). Returns { amount, unit } with unit g, ml, item or m, or null.
const PACK_UNITS = [
  [['גרם', 'גר', 'g', 'gr', 'gram'], 'g', 1], [['קילוגרם', 'ק"ג', 'kg'], 'g', 1000], [['מיליליטר', 'מיליליטרים', 'מ"ל', 'ml'], 'ml', 1], [['ליטר', 'ליטרים', 'ל', 'l', 'liter', 'litre'], 'ml', 1000],
  [['יחידה', 'יחידות', 'יח', 'unit', 'units', 'pcs'], 'item', 1], [['מטר', 'מטרים', 'm'], 'm', 1],
].map(([words, unit, f]) => [new Set(words.map((w) => norm(w))), unit, f]);
export function packOf(quantity, unitQty) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  const u = norm(unitQty);
  for (const [words, unit, f] of PACK_UNITS) if (words.has(u)) return { amount: q * f, unit };
  return null;
}
// Do two packs of the same product differ in size enough that comparing shelf prices is misleading?
export const packsDiffer = (a, b) => !!a && !!b && (a.unit !== b.unit || Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) > 0.03);

// A real barcode (EAN/UPC), as opposed to a chain's own short product code.
export const isBarcode = (code, itemType) => itemType !== 0 && /^\d{8,14}$/.test(String(code));
