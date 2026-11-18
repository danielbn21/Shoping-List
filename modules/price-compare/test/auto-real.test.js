import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, loadFixture, M, CH } from './auto-helpers.js';

// Regression test on real data: four chains' price files (trimmed: the right products, the best candidates for every item and a large sample
// of the rest) and one household's item list in Hebrew and the same list typed in English. The Hebrew rows carry the price the household paid at
// Stop Market, which tells what the right product is for 164 of the items; the English row with the same number is the same item.
// The thresholds are what the measured accuracy was; a change that lowers matching quality below them fails here.

test('real price files: exact names are matched by themselves, suggestions are right, accepting them prices the list across chains', async () => {
  const t = await boot();
  const { items, prices } = loadFixture();
  for (const [chain, rows] of Object.entries(prices)) t.seed(chain, rows);
  const heList = await t.mkList('Hebrew'), enList = await t.mkList('English');
  assert.equal((await t.importCsv(heList, items.he)).status, 200);
  assert.equal((await t.importCsv(enList, items.en)).status, 200);
  const all = Object.keys(CH);
  assert.equal(await t.select(heList, all), 200);
  assert.equal(await t.select(enList, all), 200);

  const he = await t.settle(heList);
  const idByName = new Map(t.app.db.prepare('SELECT id, name FROM items WHERE household_id = ?').all(t.hid).map((r) => [r.name, r.id]));
  const truth = Object.entries(items.truthStop).map(([i, code]) => ({ i: Number(i), code }));
  assert.ok(truth.length >= 150, 'the fixture keeps the verifiable items');
  const stopMap = new Map(t.db.prepare("SELECT item_id, code, status, auto_via FROM product_map WHERE chain = 'stop_market'").all().map((r) => [r.item_id, r]));
  const guessOf = (id, chain) => t.db.prepare('SELECT * FROM match_guess WHERE item_id = ? AND chain = ?').get(id, chain);

  // 1. a name that is exactly a product's name is matched without asking, and never wrongly
  let auto = 0, autoOk = 0, top = 0, inAlts = 0;
  for (const { i, code } of truth) {
    const id = idByName.get(items.he[i].name), m = stopMap.get(id);
    if (m) { auto++; if (m.code === code) autoOk++; assert.equal(m.status, 'auto'); assert.equal(m.auto_via, 'name'); top++; continue; }
    const g = guessOf(id, 'stop_market');
    if (g?.code === code) top++; else if (JSON.parse(g?.alts ?? '[]').some((a) => a.code === code)) inAlts++;
  }
  console.log(`Hebrew at Stop Market: ${truth.length} verifiable, auto ${auto} (${autoOk} right), suggestion right ${top - 0}, right one among alternatives ${inAlts}`);
  assert.ok(auto >= 55, `exact names matched by themselves: ${auto}`);
  assert.equal(autoOk, auto, 'every automatic match by name is the right product');
  assert.ok(top / truth.length >= 0.9, `the suggestion (or automatic match) is the right product for at least 90%: ${top}/${truth.length}`);
  assert.ok((top + inAlts) / truth.length >= 0.97, `the right product is the suggestion or one of its alternatives: ${top + inAlts}/${truth.length}`);

  // 2. the same items typed in English: the dictionary finds Hebrew products to suggest (never applied by itself)
  await t.settle(enList);
  let enTop = 0, enAlt = 0, enNone = 0;
  for (const { i, code } of truth) {
    const id = idByName.get(items.en[i].name);
    assert.equal(stopMap.get(id), undefined, 'an English name is never matched by itself');
    const g = guessOf(id, 'stop_market');
    if (!g?.code) { enNone++; continue; }
    assert.equal(g.tier, 'guess');
    if (g.code === code) enTop++; else if (JSON.parse(g.alts ?? '[]').some((a) => a.code === code)) enAlt++;
  }
  console.log(`English at Stop Market: suggestion is the product ${enTop}, among alternatives ${enAlt}, nothing ${enNone} of ${truth.length}`);
  assert.ok((enTop + enAlt) / truth.length >= 0.55, `English: right product offered for at least 55%: ${enTop + enAlt}/${truth.length}`);
  assert.ok(enNone / truth.length <= 0.15, `English: nothing suggested for at most 15%: ${enNone}`);

  // 3. one tap accepts the suggestions at Stop Market; their barcodes then price the list at the other chains by themselves
  const accepted = (await t.call('POST', `${M}/lists/${heList}/matches/accept`, { chain: 'stop_market' }, t.ck)).body.accepted;
  assert.ok(accepted >= 150, `accepted ${accepted}`);
  const after = await t.settle(heList);
  const priced = Object.fromEntries(after.results.map((r) => [r.chain, r.priced]));
  console.log('# after accepting at Stop Market, priced of', after.results[0].of, JSON.stringify(priced));
  assert.ok(priced.stop_market >= 250 && priced.rami_levy >= 120 && priced.carrefour >= 75 && priced.shufersal >= 60, JSON.stringify(priced));
  const via = {};
  for (const r of after.results.filter((r) => r.chain !== 'stop_market')) for (const l of r.lines) via[l.via] = (via[l.via] ?? 0) + 1;
  assert.ok(via.barcode >= 250, `most other-chain prices come from the barcode: ${JSON.stringify(via)}`);
  await t.close();
});
