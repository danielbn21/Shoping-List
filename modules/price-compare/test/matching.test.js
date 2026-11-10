import { test } from 'node:test';
import assert from 'node:assert/strict';
import { norm, tokens, variants, rank, searchStems, excludedFor, packOf, packsDiffer, isBarcode } from '../server/matching.js';

const P = (name, extra = {}) => ({ name, price: 10, ...extra });

test('normalising: quotes and vowel marks vanish, final letters fold, digits and units are not part of the name', () => {
  assert.equal(norm('מ"ל'), norm('מל'));
  assert.equal(norm('ג\'ינג\'ר'), 'גינגר');
  assert.equal(norm('חָלָב'), norm('חלב'));
  assert.equal(norm('לחם־אחיד  (500 גרם)'), 'לחמ אחיד 500 גרמ');
  assert.deepEqual(tokens('חלב תנובה 3% 1 ליטר'), ['חלב', 'תנובה']);
  assert.deepEqual(tokens('Milk 1 L with the cream'), ['milk', 'cream']);
});

test('a word matches its plural, its prefixed form and its start, not an unrelated word', () => {
  const sh = (a, b) => [...variants(norm(a))].some((v) => v.length >= 3 && variants(norm(b)).has(v));
  assert.ok(sh('ביצים', 'ביצה'));      // plural and feminine singular
  assert.ok(sh('העגבניות', 'עגבנייה')); // with the article
  assert.ok(sh('tomatoes', 'tomato'));
  assert.ok(!sh('חלב', 'חלון'));
  assert.ok(!sh('לחם', 'לחי'));
});

test('ranking: whole-word matches beat partial ones, extra words cost a little, plurals and the brand count', () => {
  const c = [P('עגבניות שרי 250 גרם'), P('עגבנייה'), P('רסק עגבניות'), P('שוקולד מריר'), P('חלב טרי תנובה 3%', { manufacturer: 'תנובה' }), P('גבינה לבנה תנובה', { manufacturer: 'תנובה' })];
  const r = rank('עגבניות', c).map((x) => x.name);
  assert.deepEqual(r.slice(0, 3).sort(), ['עגבניות שרי 250 גרם', 'עגבנייה', 'רסק עגבניות'].sort());
  assert.ok(!r.includes('שוקולד מריר'));
  assert.equal(rank('חלב', c)[0].name, 'חלב טרי תנובה 3%');
  assert.equal(rank('גבינה תנובה', c)[0].name, 'גבינה לבנה תנובה');                         // words in the name and in the brand
  assert.equal(rank('tomatoes', [P('Tomato paste 500g'), P('Cucumber')])[0].name, 'Tomato paste 500g');
  assert.deepEqual(rank('', c), []);
  assert.equal(rank('חלב', c, { limit: 1 }).length, 1);
  assert.ok(rank('עגבניות', [P('עגבניות שרי'), P('עגבניות שרי')]).every((x) => x.score > 0.9));
});

test('things nobody means unless they ask: frozen, pickled, pet food, deposits', () => {
  const c = [P('אפונה ירוקה'), P('אפונה קפואה'), P('מלפפון כבוש'), P('מלפפון'), P('מזון לכלבים עוף'), P('פיקדון בקבוק חוזר'), P('עוף שלם')];
  assert.deepEqual(rank('אפונה', c).map((x) => x.name), ['אפונה ירוקה']);
  assert.ok(rank('אפונה קפואה', c).map((x) => x.name).includes('אפונה קפואה'));
  assert.deepEqual(rank('מלפפון', c).map((x) => x.name), ['מלפפון']);
  assert.ok(rank('מלפפון כבוש', c).map((x) => x.name).includes('מלפפון כבוש'));
  assert.ok(!rank('עוף', c).some((x) => x.name.includes('כלבים')));
  assert.ok(excludedFor('חלב', 'גלידה קפואה') && !excludedFor('גלידה קפואה', 'גלידה קפואה'));
  assert.ok(excludedFor('בקבוק', 'פיקדון בקבוק חוזר'));
});

test('database pre-filter stems are the shortest sensible spellings', () => {
  assert.deepEqual(searchStems('עגבניות שרי'), ['עגבנ', 'שרי']);
  assert.deepEqual(searchStems('ביצים'), ['ביצ']);
  assert.deepEqual(searchStems('Tomatoes'), ['tomato']);
  assert.deepEqual(searchStems('3 ליטר'), []);
});

test('pack sizes: grams, millilitres, units; unknown or zero is no pack; sizes more than 3% apart differ', () => {
  assert.deepEqual(packOf('500.00', 'גרם'), { amount: 500, unit: 'g' });
  assert.deepEqual(packOf(2, 'קילוגרם'), { amount: 2000, unit: 'g' });
  assert.deepEqual(packOf(1, 'ליטר'), { amount: 1000, unit: 'ml' });
  assert.deepEqual(packOf(750, 'מיליליטרים'), { amount: 750, unit: 'ml' });
  assert.deepEqual(packOf(6, 'יחידות'), { amount: 6, unit: 'item' });
  assert.equal(packOf(0, 'גרם'), null);
  assert.equal(packOf(5, 'לא ידוע'), null);
  assert.ok(packsDiffer({ amount: 500, unit: 'g' }, { amount: 750, unit: 'g' }));
  assert.ok(!packsDiffer({ amount: 500, unit: 'g' }, { amount: 505, unit: 'g' }));
  assert.ok(packsDiffer({ amount: 500, unit: 'g' }, { amount: 500, unit: 'ml' }));
  assert.ok(!packsDiffer(null, { amount: 1, unit: 'g' }));
  assert.ok(isBarcode('7290010002122', 1) && !isBarcode('1994', 1) && !isBarcode('7290010002122', 0));
});
