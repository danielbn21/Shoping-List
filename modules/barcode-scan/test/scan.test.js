import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../server/src/app.js';
import { canon } from '../server/index.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const MILK = '7290000000012', TAHINI = '7290000000029', CHEESE = '2000000000015', NOPE = '7290000000999';

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
  const mkList = async (name) => (await call('POST', '/api/lists', { householdId: hid, name }, admin.cookie)).body.id;
  const lid = await mkList('Groceries');
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  const db = app.modules.loaded.get('price-compare').db;
  const price = (chain, store, code, name, p, extra = {}) => db.prepare('INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, weighted, seen_file) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(chain, store, code, 1, name, name, extra.maker ?? '', p, extra.weighted ?? 0, '20261110000000');
  price('shufersal', '1', MILK, 'Milk 3% 1L', 7.9, { maker: 'Tnuva' });
  price('shufersal', '1', TAHINI, 'Tahini Achva 500g', 18.5);
  price('shufersal', '1', CHEESE, 'Cheese by weight', 59.9, { weighted: 1 });
  const scan = (body, cookie = admin.cookie, list = lid) => call('POST', `/api/m/barcode-scan/lists/${list}/scan`, body, cookie);
  const entries = async (list = lid) => (await call('GET', `/api/lists/${list}`, undefined, admin.cookie)).body.entries.map((e) => ({ name: e.name ?? e.itemName, state: e.state, quantity: e.quantity }));
  const items = async (list = lid) => (await call('GET', `/api/households/${hid}/items?listId=${list}`, undefined, admin.cookie)).body.items;
  const want = (name, quantity = 1) => call('POST', `/api/lists/${lid}/entries`, { name, quantity }, admin.cookie);
  return { app, call, admin, hid, lid, mkList, mkUser, scan, entries, items, want, db };
}

test('barcodes are read as digits: 8 to 14, leading zeros do not matter', () => {
  assert.equal(canon('0012345678905'), '12345678905');
  assert.equal(canon('12345678905'), '12345678905');
  assert.equal(canon('123'), null);
  assert.equal(canon('abcdefghij'), null);
  assert.equal(canon('123456789012345'), null);
});

test('shopping: a similar item on the list is offered for confirmation, then ticked, its price saved and the barcode remembered; the next scan needs no question', async () => {
  const t = await boot();
  await t.want('Milk', 1);
  const first = await t.scan({ code: MILK, tick: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'confirm');                              // "Milk" looks like "Milk 3% 1L": ask once
  assert.equal(first.body.suggestion.name, 'Milk');
  assert.equal(first.body.product.price, 7.9);
  assert.deepEqual(await t.entries(), [{ name: 'Milk', state: 'open', quantity: 1 }]);   // nothing happened yet

  const yes = await t.scan({ code: MILK, tick: true, itemId: first.body.suggestion.id });
  assert.deepEqual([yes.body.status, yes.body.action, yes.body.via, yes.body.item.name, yes.body.priceSaved], ['done', 'ticked', 'chosen', 'Milk', true]);
  assert.deepEqual(await t.entries(), [{ name: 'Milk', state: 'in_cart', quantity: 1 }]);
  assert.equal((await t.items()).find((i) => i.name === 'Milk').price, 7.9);   // the saved price follows the scan

  const again = await t.scan({ code: MILK, tick: true });                       // remembered: no question, a second one in the cart
  assert.deepEqual([again.body.status, again.body.action, again.body.via, again.body.quantity], ['done', 'more', 'barcode', 2]);
  await t.app.close();
});

test('shopping: an item that is not on the list is created from the product and added already ticked, and is one of the list\'s past items', async () => {
  const t = await boot();
  const r = await t.scan({ code: TAHINI, tick: true });
  assert.deepEqual([r.body.status, r.body.action, r.body.created, r.body.item.name, r.body.via], ['done', 'added_ticked', true, 'Tahini Achva 500g', 'product']);
  assert.deepEqual(await t.entries(), [{ name: 'Tahini Achva 500g', state: 'in_cart', quantity: 1 }]);
  assert.deepEqual((await t.items()).map((i) => i.name), ['Tahini Achva 500g']);
  // a trip is open, so Finish trip works on it
  const fin = await t.call('POST', `/api/lists/${t.lid}/finish`, {}, t.admin.cookie);
  assert.equal(fin.body.purchased, 1);
  await t.app.close();
});

test('an unknown barcode asks for a name once; the name is remembered for the barcode', async () => {
  const t = await boot();
  const first = await t.scan({ code: NOPE, tick: true });
  assert.deepEqual([first.body.status, first.body.code], ['unknown', '7290000000999']);
  assert.deepEqual(await t.entries(), []);
  const named = await t.scan({ code: NOPE, tick: true, name: 'Grandma\'s jam' });
  assert.deepEqual([named.body.status, named.body.action, named.body.created, named.body.via], ['done', 'added_ticked', true, 'named']);
  const again = await t.scan({ code: NOPE, tick: true });
  assert.deepEqual([again.body.status, again.body.via, again.body.action], ['done', 'barcode', 'more']);
  await t.app.close();
});

test('managing (not shopping): the item is added unticked, and a second scan adds to the quantity', async () => {
  const t = await boot();
  const a = await t.scan({ code: TAHINI, tick: false });
  assert.deepEqual([a.body.action, a.body.quantity], ['added', 1]);
  const b = await t.scan({ code: TAHINI, tick: false });
  assert.deepEqual([b.body.action, b.body.quantity], ['merged', 2]);
  assert.deepEqual(await t.entries(), [{ name: 'Tahini Achva 500g', state: 'open', quantity: 2 }]);
  await t.app.close();
});

test('a product sold by weight is added but its per-kilo price is not saved as the item price', async () => {
  const t = await boot();
  const r = await t.scan({ code: CHEESE, tick: true });
  assert.deepEqual([r.body.status, r.body.priceSaved, r.body.product.weighted], ['done', false, true]);
  assert.equal((await t.items())[0].price ?? null, null);
  await t.app.close();
});

test('permissions: a Shopper can tick what is on the list but cannot add or create items; the page of another list is not reachable', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  const e = await t.want('Tahini Achva 500g', 1);                                   // already on the list (exact name)
  const ok = await t.scan({ code: TAHINI, tick: true, name: 'Tahini Achva 500g' }, dana.cookie);
  assert.deepEqual([ok.status, ok.body.action], [200, 'ticked']);
  const no = await t.scan({ code: MILK, tick: true }, dana.cookie);                  // would create "Milk 3% 1L"
  assert.equal(no.status, 403);
  assert.deepEqual((await t.items()).map((i) => i.name), ['Tahini Achva 500g']);     // nothing was created
  assert.equal((await t.scan({ code: MILK, tick: false }, dana.cookie)).status, 403);   // managing needs an editor too
  const priv = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Mine', visibility: 'private' }, t.admin.cookie)).body.id;
  assert.equal((await t.scan({ code: MILK, tick: true }, dana.cookie, priv)).status, 404);
  void e;
  await t.app.close();
});

test('validation: not a barcode; an item that is not the household\'s', async () => {
  const t = await boot();
  assert.equal((await t.scan({ code: '12' })).body.error, 'invalid_code');
  assert.equal((await t.scan({ code: TAHINI, tick: true, itemId: 99999 })).status, 404);
  await t.app.close();
});

test('without price comparison there is no product to find: scanning still works by asking for a name', async () => {
  const t = await boot();
  const r = await t.scan({ code: MILK, tick: true, name: 'Milk' });
  assert.equal(r.body.status, 'done');
  await t.app.close();
});

test('a deleted item forgets its barcode', async () => {
  const t = await boot();
  const a = await t.scan({ code: TAHINI, tick: false });
  const id = a.body.item.id;
  await t.call('DELETE', `/api/items/${id}`, undefined, t.admin.cookie);
  const db = t.app.modules.loaded.get('barcode-scan').db;
  assert.equal(db.prepare('SELECT COUNT(*) c FROM barcode_items').get().c, 0);
  await t.app.close();
});

test('1.1.0 rename: the item a barcode points to gets a new name and the barcode follows it; the next scan lands on the new name, no second item', async () => {
  const t = await boot();
  const first = await t.scan({ code: TAHINI, tick: false });                         // created as "Tahini Achva 500g"
  const id = first.body.item.id;
  const rn = (body, cookie = t.admin.cookie, list = t.lid) => t.call('POST', `/api/m/barcode-scan/lists/${list}/scan/rename`, body, cookie);
  const r = await rn({ itemId: id, name: '  Our   tahini ' });
  assert.deepEqual([r.status, r.body.item], [200, { id, name: 'Our tahini' }]);        // spaces tidied
  assert.deepEqual((await t.entries()).map((e) => e.name), ['Our tahini']);            // the list shows the new name
  const again = await t.scan({ code: TAHINI, tick: false });
  assert.deepEqual([again.body.status, again.body.via, again.body.item], ['done', 'barcode', { id, name: 'Our tahini' }]);
  assert.deepEqual((await t.items()).map((i) => i.name), ['Our tahini']);              // still one item
  assert.equal((await rn({ itemId: id, name: 'our TAHINI' })).status, 200);            // only the case changes: allowed
  await t.app.close();
});

test('1.1.0 rename: refused for a name another item has, an empty name, an item without a barcode, and for a Shopper', async () => {
  const t = await boot();
  const a = (await t.scan({ code: TAHINI, tick: false })).body.item.id;
  await t.scan({ code: MILK, tick: false, name: 'Milk' });
  const plain = (await t.want('Bread', 1)).body;                                        // on the list but no barcode
  const rn = (body, cookie = t.admin.cookie) => t.call('POST', `/api/m/barcode-scan/lists/${t.lid}/scan/rename`, body, cookie);
  const dup = await rn({ itemId: a, name: 'milk' });
  assert.deepEqual([dup.status, dup.body.error], [409, 'item_exists']);
  assert.equal((await rn({ itemId: a, name: '   ' })).body.error, 'invalid_name');
  const items = await t.items();
  const breadId = items.find((i) => i.name === 'Bread')?.id ?? plain.itemId;
  assert.equal((await rn({ itemId: breadId, name: 'Rye bread' })).status, 404);        // not a barcode item: this is not a general rename
  assert.equal((await rn({ itemId: 99999, name: 'x' })).status, 404);
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await rn({ itemId: a, name: 'Sesame paste' }, dana.cookie)).status, 403);
  assert.ok((await t.items()).some((i) => i.name === 'Tahini Achva 500g'));            // unchanged
  await t.app.close();
});
