// Item-name normalisation and fuzzy matching for English and Hebrew.
// Goal: "Tomatoes", "tomato", "TOMATO " and "tomatos" should all land on the same bank item.

const MARKS = /[\u0591-\u05C7\u0300-\u036f]/g; // Hebrew niqqud/cantillation + Latin combining accents
const PUNCT = /["'`\u2019\u05F3\u05F4.,;:!?()\[\]{}\/\\\-_+*]+/g;
const FINAL = { '\u05DA': '\u05DB', '\u05DD': '\u05DE', '\u05DF': '\u05E0', '\u05E3': '\u05E4', '\u05E5': '\u05E6' }; // ך ם ן ף ץ -> regular forms
const HEB = /[\u0590-\u05FF]/;

export const isHebrew = (s) => HEB.test(s);

function stemWord(w) {
  if (HEB.test(w)) {
    if (w.length > 4 && /(\u05D9\u05DD|\u05D5\u05EA)$/.test(w)) w = w.slice(0, -2); // plural ים / ות
    if (w.length > 3 && w.startsWith('\u05D4')) w = w.slice(1); // definite article ה
    if (w.length > 3 && w.endsWith('\u05D4')) w = w.slice(0, -1); // feminine singular ה (בננה / בננות)
    return w.replace(/[\u05DA\u05DD\u05DF\u05E3\u05E5]/g, (c) => FINAL[c]);
  }
  if (w.length > 3) {
    if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (/(ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
    if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  }
  return w;
}

export function normalize(raw) {
  const s = String(raw || '').normalize('NFKD').replace(MARKS, '').toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean).map(stemWord).join(' ');
}

// Optimal string alignment distance (Levenshtein + adjacent transposition).
export function distance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

const TOLERANCE = { loose: 1, normal: 0, strict: -1 };
export function maxTypos(len, strictness = 'normal') {
  const base = len >= 9 ? 2 : len >= 4 ? 1 : 0;
  return Math.max(0, base + (TOLERANCE[strictness] ?? 0));
}

/**
 * Rank bank items against a query.
 * kind: 'exact' | 'prefix' | 'partial' | 'fuzzy'
 * typeahead=true also returns prefix/partial hits (for the suggestion list while typing).
 * typeahead=false returns only exact and fuzzy hits (used to catch accidental duplicates on submit).
 */
export function findMatches(query, items, { strictness = 'normal', typeahead = false, limit = 8 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const out = [];
  for (const it of items) {
    const n = it.name_norm;
    let score = 0, kind = '';
    if (n === q) { score = 1; kind = 'exact'; }
    else if (typeahead && (n.startsWith(q) || n.split(' ').some((w) => w.startsWith(q)))) { score = 0.85; kind = 'prefix'; }
    else if (typeahead && q.length >= 3 && n.includes(q)) { score = 0.7; kind = 'partial'; }
    else {
      const dist = distance(q, n);
      if (dist > 0 && dist <= maxTypos(Math.min(q.length, n.length), strictness)) { score = 0.6 - dist * 0.05; kind = 'fuzzy'; }
      else if (typeahead && n.length >= 3 && q.length > n.length && q.startsWith(n)) { score = 0.55; kind = 'partial'; }
    }
    if (score) out.push({ item: it, score, kind });
  }
  out.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
  return out.slice(0, limit);
}

/**
 * Match a receipt line ("Milk 3% 1L") to a bank item ("Milk"): every word of the item must appear in the line
 * (exactly, or within a typo for longer words). Of several candidates, the one explaining most of the line wins.
 */
export function findReceiptMatch(name, items, { strictness = 'normal' } = {}) {
  const qt = normalize(name).split(' ').filter(Boolean);
  if (!qt.length) return null;
  let best = null;
  for (const it of items) {
    const nt = it.name_norm.split(' ').filter(Boolean);
    if (!nt.length) continue;
    const hit = nt.every((w) => qt.some((x) => x === w || (w.length >= 4 && distance(x, w) <= maxTypos(w.length, strictness))));
    if (!hit) continue;
    const score = nt.length / qt.length + it.name_norm.length / 1000;
    if (!best || score > best.score) best = { item: it, score };
  }
  return best ? best.item : null;
}
