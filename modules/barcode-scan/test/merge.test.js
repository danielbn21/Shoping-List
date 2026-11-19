import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, M } from '../../price-compare/test/auto-helpers.js';

// 1.7.1: the barcode module (scan, rename) together with the matching of price-compare 1.5.0.
const TAHINI = '7290000000029', BREAD = '7290000000036';
const PRODUCTS = [[TAHINI, 1, 'טחינה אחוה 500 גרם', '', 'אחוה', 18.5], [BREAD, 1, 'לחם שיפון 500 גרם', '', 'אנג\'ל', 12]];

const setup = async () => {
  const t = await boot();
  const lid = await t.mkList('Groceries');
  t.seed('shufersal', PRODUCTS);
  await t.select(lid, ['shufersal']);
  const scan = (body) => t.call('POST', `/api/m/barcode-scan/lists/${lid}/scan`, body, t.ck);
  const rename = (itemId, name) => t.call('POST', `/api/m/barcode-scan/lists/${lid}/scan/rename`, { itemId, name }, t.ck);
  const line = async () => { const c = await t.settle(lid); const r = c.results.find((x) => x.chain === 'shufersal'); return { total: r.total, line: r.lines[0] }; };
  return { t, lid, scan, rename, line };
};

test('a scanned product is matched by name by the new matching, and the price the scan saved is on the item', async () => {
  const { t, scan, line } = await setup();
  const r = await scan({ code: TAHINI, tick: false });
  assert.equal(r.body.status, 'done');
  const l = await line();
  assert.deepEqual([l.line.via, l.line.autoVia, l.total], ['auto', 'name', 18.5]);
  await t.close();
});

test('renaming a scanned item: matching follows the NEW name (no stale match to the old product), the barcode still finds the item', async () => {
  const { t, scan, rename, line } = await setup();
  const first = await scan({ code: TAHINI, tick: false });
  assert.equal((await line()).total, 18.5);
  const r = await rename(first.body.item.id, 'לחם שיפון 500 גרם');            // now named exactly like the other product
  assert.equal(r.status, 200);
  const l = await line();
  assert.equal(l.total, 12, JSON.stringify(l));                              // priced as the rye bread, not as the tahini it was matched to under the old name
  const again = await scan({ code: TAHINI, tick: false });                   // the barcode still points at the same item
  assert.deepEqual([again.body.via, again.body.item.id], ['barcode', first.body.item.id]);
  await t.close();
});

test('the same holds when the item is renamed from Manage list (PATCH /api/items/:id), not only from the scanner', async () => {
  const { t, scan, line } = await setup();
  const first = await scan({ code: TAHINI, tick: false });
  assert.equal((await line()).total, 18.5);
  assert.equal((await t.call('PATCH', `/api/items/${first.body.item.id}`, { name: 'לחם שיפון 500 גרם' }, t.ck)).status, 200);
  assert.equal((await line()).total, 12);
  await t.close();
});

test('a rename that only changes the case keeps the match by name', async () => {
  const { t, scan, rename, line } = await setup();
  const first = await scan({ code: TAHINI, tick: false });
  assert.equal((await line()).total, 18.5);
  assert.equal((await rename(first.body.item.id, 'טחינה אחוה 500 גרם ')).status, 200);   // same name, a trailing space
  assert.deepEqual([(await line()).line.autoVia, (await line()).total], ['name', 18.5]);
  await t.close();
});
