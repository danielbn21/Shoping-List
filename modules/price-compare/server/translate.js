import { ENTRIES, STOP, MAX_PHRASE_WORDS } from './lexicon.js';

// Turning what the household typed into something that can be looked up among Hebrew product names.
//   "Cottage cheese"                     -> [ { variants: ['גבינת קוטג', 'קוטג'] } ]
//   "Potato starch or rice flour"        -> two alternatives (one segment per "or")
// Words the dictionary does not know are reported in `unknown`; the caller may ask an AI about them (see ai.js) and keep the answer.

export const HEBREW = /[\u0590-\u05FF]/;
const WORD_TRIM = /^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu;

// The key under which an English item name is remembered (its translation by an AI): lower case, single spaces.
export const phraseKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function singulars(w) {
  const out = [];
  if (w.endsWith('ies') && w.length > 4) out.push(w.slice(0, -3) + 'y');
  if (/(ches|shes|sses|xes|oes|zes)$/.test(w)) out.push(w.slice(0, -2));
  if (w.endsWith('ves') && w.length > 4) out.push(w.slice(0, -3) + 'f', w.slice(0, -3) + 'fe');
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) out.push(w.slice(0, -1));
  return out;
}

const lookup = (key) => ENTRIES.get(key) ?? ENTRIES.get(key.replace(/-/g, ' ')) ?? ENTRIES.get(key.replace(/ /g, '-')) ?? null;

// The dictionary entry for a run of words, trying the plural of the last word as a singular too.
function entryFor(words) {
  const key = words.join(' ');
  const direct = lookup(key);
  if (direct) return direct;
  const last = words[words.length - 1];
  for (const s of singulars(last)) { const e = lookup([...words.slice(0, -1), s].join(' ')); if (e) return e; }
  return null;
}

export const isEnglishWord = (w) => /^[a-z][a-z'&.-]*$/i.test(w);

function translateWords(words) {
  const pieces = [], unknown = [];
  let i = 0;
  while (i < words.length) {
    let hit = null;
    for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n >= 1 && !hit; n--) {
      const e = entryFor(words.slice(i, i + n));
      if (e) { hit = { he: e, used: n }; }
    }
    if (hit) { pieces.push({ he: hit.he }); i += hit.used; continue; }
    const w = words[i++];
    if (HEBREW.test(w)) pieces.push({ he: [w] });                 // already Hebrew
    else if (/^\d+([.,]\d+)?%?$/.test(w)) continue;                // a number or a percentage says nothing here
    else if (STOP.has(w)) continue;
    else unknown.push(w);
  }
  return { pieces, unknown };
}

// text -> { segments: [{ text, variants: [hebrew strings], unknown: [words], translated: n }], unknown, complete }
// complete = every content word was understood. cache: Map of normalised English text -> hebrew (answers from earlier AI calls).
export function translateQuery(text, { cache } = {}) {
  // an answer kept from an earlier AI request for exactly this item name wins over the dictionary
  const kept = cache?.get(phraseKey(text));
  if (kept) {
    const segments = kept.split('|').map((x) => x.trim()).filter(Boolean).map((x) => ({ text: x, variants: [x], unknown: [], translated: 1, via: 'ai' }));
    if (segments.length) return { segments, unknown: [], complete: true };
  }
  const src = String(text ?? '').toLowerCase().replace(/[—–;]+/g, ',').replace(/[()"“”]/g, ' ');
  const segments = [];
  for (const part of src.split(/,|\/|\s+or\s+/)) {
    const words = part.split(/\s+/).map((w) => w.replace(WORD_TRIM, '')).filter(Boolean);
    if (!words.length) continue;
    const { pieces, unknown } = translateWords(words);
    const cached = !pieces.length ? cache?.get(words.join(' ')) : null;
    if (cached) { segments.push({ text: part.trim(), variants: [cached], unknown: [], translated: words.length, via: 'ai' }); continue; }
    if (!pieces.length) { segments.push({ text: part.trim(), variants: [], unknown, translated: 0 }); continue; }
    const n = Math.min(3, Math.max(...pieces.map((p) => p.he.length)));
    const variants = [];
    for (let k = 0; k < n; k++) {
      const v = pieces.map((p) => p.he[Math.min(k, p.he.length - 1)]).join(' ').replace(/\s+/g, ' ').trim();
      if (v && !variants.includes(v)) variants.push(v);
    }
    segments.push({ text: part.trim(), variants, unknown, translated: pieces.length, via: 'dictionary' });
  }
  const unknown = [...new Set(segments.flatMap((s) => s.unknown))];
  return { segments, unknown, complete: segments.length > 0 && segments.every((s) => s.variants.length > 0) && unknown.length === 0 };
}

// Is the text (mostly) typed in English?
export const looksEnglish = (text) => /[a-z]{2}/i.test(String(text ?? '')) && !HEBREW.test(String(text ?? ''));
