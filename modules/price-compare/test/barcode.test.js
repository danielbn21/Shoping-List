import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../server/src/app.js';
import { codeVariants } from '../server/barcode.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot() {
  const app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie)).body.id;
  const db = app.modules.loaded.get('price-compare').db;
  const put = (chain, store, code, name, price, extra = {}) => db.prepare(`INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, weighted, seen_file) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(chain, store, code, extra.type ?? 1, name, name, extra.maker ?? '', price, extra.weighted ?? 0, extra.seen ?? '20261110000000');
  const lookup = () => app.modules.providerFor('barcode-lookup', admin.body.user.id);
  return { app, call, admin, hid, lid, db, put, lookup };
}

test('barcode spellings: with and without leading zeros, UPC-A and EAN-13; junk gives none', () => {
  assert.ok(codeVariants('7290000000012').includes('7290000000012'));
  assert.ok(codeVariants('012345678905').includes('0012345678905'));        // UPC-A also as EAN-13
  assert.ok(codeVariants('0012345678905').includes('012345678905'));        // and back
  assert.ok(codeVariants('00001234').includes('1234'.padStart(8, '0')));
  assert.deepEqual(codeVariants('123'), []);
  assert.deepEqual(codeVariants('abc'), []);
  assert.deepEqual(codeVariants('12345678901234567'), []);
});

test('the barcode-lookup capability is provided, and a barcode nobody has read gives null', async () => {
  const t = await boot();
  assert.ok(t.lookup());
  assert.equal(t.lookup().find({ listId: t.lid, code: '7290000000012' }), null);
  assert.equal(t.lookup().find({ listId: t.lid, code: 'not a code' }), null);
  await t.app.close();
});

test('lookup prefers the household store\'s chain, then the list\'s chosen branches, then any branch; the price is the lowest within that group', async () => {
  const t = await boot();
  const CODE = '7290000000012';
  t.put('shufersal', '1', CODE, 'Milk 3% 1L', 7.9, { maker: 'Tnuva' });
  t.put('shufersal', '2', CODE, 'Milk 3% 1L', 7.2, { maker: 'Tnuva' });
  t.put('rami_levy', '5', CODE, 'Milk 3% 1L (Rami)', 6.5);
  t.put('victory', '9', CODE, 'Milk 3% 1L (Victory)', 5.0);
  // any: nothing chosen, no store -> the cheapest anywhere
  let r = t.lookup().find({ listId: t.lid, code: CODE });
  assert.deepEqual([r.via, r.price, r.chain], ['any', 5.0, 'victory']);
  // list: the list compares Shufersal and Rami Levy -> the cheapest of those
  await t.call('PUT', `/api/m/price-compare/lists/${t.lid}/stores`, { selection: [{ chain: 'shufersal' }, { chain: 'rami_levy' }] }, t.admin.cookie);
  r = t.lookup().find({ listId: t.lid, code: CODE });
  assert.deepEqual([r.via, r.price, r.chain], ['list', 6.5, 'rami_levy']);
  // store: the household store is a Shufersal -> Shufersal's cheapest branch, even though Rami is cheaper
  const sid = (await t.call('POST', `/api/households/${t.hid}/stores`, { name: 'My Shufersal' }, t.admin.cookie)).body.id;
  await t.call('PUT', `/api/m/price-compare/stores/${sid}/chain`, { chain: 'shufersal' }, t.admin.cookie);
  r = t.lookup().find({ listId: t.lid, storeId: sid, code: CODE });
  assert.deepEqual([r.via, r.price, r.chain, r.branchId, r.manufacturer], ['store', 7.2, 'shufersal', '2', 'Tnuva']);
  assert.equal(r.weighted, false);
  await t.app.close();
});

test('a barcode is found under another spelling, and a chain\'s own short code is never a barcode', async () => {
  const t = await boot();
  t.put('shufersal', '1', '0012345678905', 'Olive oil', 24.9);                   // stored as 13 digits with a leading zero
  t.put('shufersal', '1', '12345678', 'Own code product', 3.0, { type: 0 });     // chain's own code
  assert.equal(t.lookup().find({ listId: t.lid, code: '012345678905' }).name, 'Olive oil');   // scanned as UPC-A
  assert.equal(t.lookup().find({ listId: t.lid, code: '12345678' }), null);
  await t.app.close();
});

test('a weighted product is reported as weighted, so its per-kilo price is not mistaken for an item price', async () => {
  const t = await boot();
  t.put('shufersal', '1', '2000000000015', 'Cheese by weight', 59.9, { weighted: 1 });
  assert.equal(t.lookup().find({ listId: t.lid, code: '2000000000015' }).weighted, true);
  await t.app.close();
});
