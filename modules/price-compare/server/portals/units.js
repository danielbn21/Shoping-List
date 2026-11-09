// UnitOfMeasure spellings seen in real files (Shufersal, Carrefour, Rami Levy, Stop Market, Nov 2026) -> a canonical unit.
// Anything not in the table is reported as unknown; we never guess.
const T = {
  kg: { unit: 'kg', per: 1 }, g100: { unit: 'g', per: 100 }, l: { unit: 'l', per: 1 }, ml100: { unit: 'ml', per: 100 },
  ml: { unit: 'ml', per: 1 }, item: { unit: 'item', per: 1 }, m: { unit: 'm', per: 1 }, m100: { unit: 'm', per: 100 },
  g: { unit: 'g', per: 1 }, kg100: { unit: 'kg', per: 100 }, item2: { unit: 'item', per: 2 }, cm100: { unit: 'cm', per: 100 },
  none: { unit: 'unspecified', per: 0 }, // the file says no unit is given
};
const SPELLINGS = {
  'קילוגרם': T.kg, '1קילוגרם': T.kg, '1 קילוגרם': T.kg,
  '100 גרם': T.g100, '100גרם': T.g100,
  'ליטר': T.l, '1ליטר': T.l, '1 ליטר': T.l,
  '100 מיליליטר': T.ml100, '100 מ"ל': T.ml100, '100מ"ל': T.ml100,
  'מיליליטר': T.ml, 'מיליליטרים': T.ml,
  'יחידות': T.item, 'יחידה': T.item,
  'מטר': T.m, 'מטרים': T.m, '100 מטרים': T.m100,
  'גרם': T.g, '100 קילוגרם': T.kg100, '2 יחידות': T.item2, '100 ס"מ': T.cm100,
  'Unknown': T.none, 'לא ידוע': T.none, 'לא מנהל יחידת מידה': T.none,
};

const tidy = (s) => String(s ?? '').replace(/[\u05f4\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

export function normalizeUnit(text) {
  return SPELLINGS[tidy(text)] ?? null;
}
export const tidyUnit = tidy;
