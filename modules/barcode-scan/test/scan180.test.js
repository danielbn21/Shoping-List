import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../server/src/app.js';
import { canon } from '../server/index.js';
import { suggestCategory } from '../server/categories.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const MILK = '7290000000012', TAHINI = '7290000000029', CHEESE = '2000000000015', NOPE = '7290000000999', SOAP = '7290000000036';

async function boot() {
  const app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, text: res.body, cookie: c ? `sl_session=${c.value}` : null };
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
  price('shufersal', '1', SOAP, 'Zorbix 750ml', 12.5, { maker: 'Tnuva' });
  price('shufersal', '1', CHEESE, 'Cheese by weight', 59.9, { weighted: 1 });
  const scan = (body, cookie = admin.cookie, list = lid) => call('POST', `/api/m/barcode-scan/lists/${list}/scan`, body, cookie);
  const entries = async (list = lid) => (await call('GET', `/api/lists/${list}`, undefined, admin.cookie)).body.entries.map((e) => ({ name: e.name ?? e.itemName, state: e.state, quantity: e.quantity }));
  const items = async (list = lid) => (await call('GET', `/api/households/${hid}/items?listId=${list}`, undefined, admin.cookie)).body.items;
  const want = (name, quantity = 1) => call('POST', `/api/lists/${lid}/entries`, { name, quantity }, admin.cookie);
  return { app, call, admin, hid, lid, mkList, mkUser, scan, entries, items, want, db };
}


const mm = (t, path, body, cookie = t.admin.cookie, list = t.lid) => t.call('POST', `/api/m/barcode-scan/lists/${list}/${path}`, body, cookie);
const itemRow = async (t, name) => (await t.items()).find((i) => i.name === name);
const cats = async (t) => (await t.call('GET', `/api/m/barcode-scan/lists/${t.lid}/scan/categories`, undefined, t.admin.cookie)).body.categories;
const catId = async (t, en) => (await cats(t)).find((c) => c.nameEn === en).id;

test('1.2.0 categories: the order is similar item, manufacturer, shared words, keyword table, none; only the household\'s own categories are used', () => {
  const categories = [{ id: 1, nameEn: 'Produce', nameHe: 'פירות וירקות' }, { id: 3, nameEn: 'Dairy & eggs', nameHe: 'מוצרי חלב וביצים' }, { id: 6, nameEn: 'Pantry', nameHe: 'מזווה' }];
  const items = [{ id: 10, name: 'Tahini', categoryId: 6, createdAt: 1 }, { id: 11, name: 'Oat milk', categoryId: 6, createdAt: 2 }];
  const run = (name, extra = {}) => suggestCategory({ name, categories, items, ...extra });
  assert.deepEqual(run('Milk 3% 1L'), { categoryId: 6, how: 'words' });                                  // a word an existing item shares beats the table
  assert.deepEqual(run('Whatever', { similar: { categoryId: 1 } }), { categoryId: 1, how: 'similar' });
  assert.deepEqual(run('Whatever', { byManufacturer: [{ itemId: 11 }] }), { categoryId: 6, how: 'manufacturer' });
  assert.deepEqual(run('Banana 1kg'), { categoryId: 1, how: 'keyword' });
  assert.deepEqual(run('חלב תנובה 3%'), { categoryId: 3, how: 'keyword' });                              // Hebrew, with the table
  assert.deepEqual(run('Shampoo gentle'), null);                                                          // the household has no such category: none is made
  assert.equal(run('Zzz'), null);
  assert.equal(suggestCategory({ name: 'Banana', categories: [], items: [] }), null);
  assert.equal(run('Whatever', { similar: { categoryId: 999 } }), null);                                  // a category that is not the household's is ignored
});

test('1.2.0 a scanned new item gets a category automatically and the panel is told how; a maker already seen decides the next one; an item that has a category keeps it', async () => {
  const t = await boot();
  const dairy = await catId(t, 'Dairy & eggs'), pantry = await catId(t, 'Pantry');
  const a = await mm(t, 'scan', { code: MILK, tick: false });                    // Milk 3% 1L -> table
  assert.deepEqual([a.body.status, a.body.created, a.body.categoryId, a.body.categoryHow], ['done', true, dairy, 'keyword']);
  assert.equal((await itemRow(t, 'Milk 3% 1L')).categoryId ?? (await itemRow(t, 'Milk 3% 1L')).category_id, dairy);
  await mm(t, 'scan/edit', { itemId: a.body.item.id, categoryId: pantry });      // the person says Pantry, and the maker Tnuva is now a Pantry maker
  const b = await mm(t, 'scan', { code: SOAP, tick: false });                    // "Zorbix": no word, no keyword; same maker
  assert.deepEqual([b.body.categoryId, b.body.categoryHow], [pantry, 'manufacturer']);
  const again = await mm(t, 'scan', { code: MILK, tick: false });                 // already has one: left alone
  assert.equal(again.body.categoryId, pantry);
  await t.app.close();
});

test('1.2.0 edit: name and category, or just one; a category that is not the household\'s and a Shopper are refused', async () => {
  const t = await boot();
  const id = (await mm(t, 'scan', { code: TAHINI, tick: false })).body.item.id;
  const frozen = await catId(t, 'Frozen');
  const r = await mm(t, 'scan/edit', { itemId: id, name: 'Tahini', categoryId: frozen });
  assert.deepEqual([r.status, r.body.item.name, r.body.categoryId], [200, 'Tahini', frozen]);
  const none = await mm(t, 'scan/edit', { itemId: id, categoryId: null });
  assert.equal(none.body.categoryId, null);
  assert.equal((await mm(t, 'scan/edit', { itemId: id, categoryId: 99999 })).body.error, 'invalid_category');
  assert.equal((await mm(t, 'scan/edit', { itemId: 99999, name: 'x' })).status, 404);
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await mm(t, 'scan/edit', { itemId: id, categoryId: frozen }, dana.cookie)).status, 403);
  await t.app.close();
});

test('1.2.0 wrong item: a barcode confirmed wrongly is moved; the wrong tick is taken back and its price put back; the next scan lands right', async () => {
  const t = await boot();
  await t.want('Tahini', 1);
  const tahini = (await itemRow(t, 'Tahini')).id;
  await t.call('PATCH', `/api/items/${tahini}`, { price: 20 }, t.admin.cookie);
  const wrong = await mm(t, 'scan', { code: MILK, tick: true, itemId: tahini });          // the person said yes to "Tahini" for the milk barcode
  assert.deepEqual([wrong.body.action, wrong.body.priceSaved], ['ticked', true]);
  assert.equal((await itemRow(t, 'Tahini')).price, 7.9);
  const fix = await mm(t, 'scan/repoint', { code: MILK, name: 'Milk', tick: true, undo: wrong.body.scan });
  assert.equal(fix.status, 200);
  assert.deepEqual([fix.body.item.name, fix.body.action, fix.body.created, fix.body.from.name, fix.body.reversed.result], ['Milk', 'added_ticked', true, 'Tahini', 'unticked']);
  assert.deepEqual(await t.entries(), [{ name: 'Tahini', state: 'open', quantity: 1 }, { name: 'Milk', state: 'in_cart', quantity: 1 }]);
  assert.equal((await itemRow(t, 'Tahini')).price, 20);                                    // the old price is back
  const next = await mm(t, 'scan', { code: MILK, tick: true });
  assert.deepEqual([next.body.via, next.body.item.name, next.body.action], ['barcode', 'Milk', 'more']);
  await t.app.close();
});

test('1.2.0 wrong item: an item the wrong scan created is removed again; one more than before is taken off; moving to an existing item works; same item and a Shopper are refused', async () => {
  const t = await boot();
  const first = await mm(t, 'scan', { code: TAHINI, tick: false, name: 'Wrongly named' });  // created and added
  assert.equal(first.body.created, true);
  await t.want('Sesame paste', 1);
  const right = (await itemRow(t, 'Sesame paste')).id;
  const fix = await mm(t, 'scan/repoint', { code: TAHINI, itemId: right, tick: false, undo: first.body.scan });
  assert.deepEqual([fix.body.item.name, fix.body.action, fix.body.reversed.itemRemoved], ['Sesame paste', 'merged', true]);
  assert.equal(await itemRow(t, 'Wrongly named'), undefined);                               // gone from the item bank
  assert.deepEqual(await t.entries(), [{ name: 'Sesame paste', state: 'open', quantity: 2 }]);
  assert.equal((await mm(t, 'scan/repoint', { code: TAHINI, itemId: right, tick: false })).body.error, 'same_item');

  // shopping: the cart had one, the wrong scan made it two; now it is one again
  await t.scan({ code: CHEESE, tick: false, name: 'Cheese' });
  const cheese = (await itemRow(t, 'Cheese')).id;
  const e = (await t.entries()).length; assert.ok(e >= 2);
  await t.call('POST', `/api/m/barcode-scan/lists/${t.lid}/scan`, { code: NOPE, tick: true, name: 'Pita' }, t.admin.cookie);
  const s2 = await mm(t, 'scan', { code: NOPE, tick: true });
  assert.deepEqual([s2.body.action, s2.body.quantity], ['more', 2]);
  const fix2 = await mm(t, 'scan/repoint', { code: NOPE, itemId: cheese, tick: true, undo: s2.body.scan });
  assert.equal(fix2.body.reversed.result, 'less');
  assert.equal((await t.entries()).find((x) => x.name === 'Pita').quantity, 1);
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await mm(t, 'scan/repoint', { code: NOPE, itemId: right, tick: true }, dana.cookie)).status, 403);
  await t.app.close();
});

test('1.2.0 wrong item: if the entry was changed since the scan nothing is undone, but the barcode still moves', async () => {
  const t = await boot();
  await t.want('Tahini', 1);
  const wrong = await mm(t, 'scan', { code: MILK, tick: true, name: 'Tahini' });
  const e = (await t.call('GET', `/api/lists/${t.lid}`, undefined, t.admin.cookie)).body.entries[0];
  await t.call('POST', `/api/entries/${e.id}/check`, { checked: false }, t.admin.cookie);   // someone un-ticked it already
  const fix = await mm(t, 'scan/repoint', { code: MILK, name: 'Milk', tick: true, undo: wrong.body.scan });
  assert.deepEqual([fix.status, fix.body.reversed.reversed, fix.body.item.name], [200, false, 'Milk']);
  assert.equal((await mm(t, 'scan', { code: MILK, tick: true })).body.item.name, 'Milk');
  await t.app.close();
});

test('1.2.0 lookup (Add a trip): says what a barcode is and costs and changes no list; a chosen item is remembered', async () => {
  const t = await boot();
  const l1 = await mm(t, 'scan/lookup', { code: MILK });
  assert.deepEqual([l1.body.status, l1.body.name, l1.body.price, l1.body.item], ['found', 'Milk 3% 1L', 7.9, null]);
  assert.ok(l1.body.categoryId);
  assert.deepEqual(await t.entries(), []);
  assert.equal((await t.items()).length, 0);                                                // not even an item was made
  assert.equal((await mm(t, 'scan/lookup', { code: NOPE })).body.status, 'unknown');
  assert.equal((await mm(t, 'scan/lookup', { code: NOPE, name: 'Pita' })).body.name, 'Pita');
  await t.want('Milk', 1);
  const c = await mm(t, 'scan/lookup', { code: MILK });
  assert.equal(c.body.status, 'confirm');
  const yes = await mm(t, 'scan/lookup', { code: MILK, itemId: c.body.suggestion.id });
  assert.deepEqual([yes.body.status, yes.body.item.name], ['found', 'Milk']);
  assert.equal((await mm(t, 'scan/lookup', { code: MILK })).body.item.name, 'Milk');       // remembered
  assert.deepEqual(await t.entries(), [{ name: 'Milk', state: 'open', quantity: 1 }]);
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await mm(t, 'scan/lookup', { code: MILK }, dana.cookie)).status, 403);
  await t.app.close();
});

test('1.2.0 items CSV: export carries the barcodes; import brings them back, and a barcode in the file always wins over an existing link', async () => {
  const t = await boot();
  await mm(t, 'scan', { code: MILK, tick: false });
  await mm(t, 'scan', { code: TAHINI, tick: false });
  const csv = (await t.call('GET', `/api/lists/${t.lid}/items.csv?lang=en`, undefined, t.admin.cookie)).text;
  const head = csv.replace(/^\uFEFF/, '').split(/\r\n/)[0].split(',');
  assert.equal(head[head.length - 1], 'barcode');
  assert.match(csv, /Milk 3% 1L,[^\r\n]*,7290000000012\r?\n/);

  // a file where the tahini barcode now belongs to Milk, and a brand new item carries a new one
  const file = 'name,category,barcode\nMilk 3% 1L,,7290000000012 7290000000029\nHalva,,7290000000999\n';
  const imp = (apply) => t.call('POST', `/api/lists/${t.lid}/items/import`, { csv: file, apply }, t.admin.cookie);
  const prev = await imp(false);
  assert.equal(prev.body.summary.extraRelinks, 1);
  assert.deepEqual(prev.body.rows[0].relinks, [{ code: '7290000000029', fromName: 'Tahini Achva 500g' }]);
  assert.equal((await mm(t, 'scan/lookup', { code: TAHINI })).body.item.name, 'Tahini Achva 500g');   // preview wrote nothing
  assert.equal((await imp(true)).status, 200);
  assert.equal((await mm(t, 'scan/lookup', { code: TAHINI })).body.item.name, 'Milk 3% 1L');           // the file wins
  assert.equal((await mm(t, 'scan/lookup', { code: NOPE })).body.item.name, 'Halva');                   // a new item, linked
  // a file without the column behaves as before
  const plain = await t.call('POST', `/api/lists/${t.lid}/items/import`, { csv: 'name\nButter\n', apply: true }, t.admin.cookie);
  assert.equal(plain.status, 200);
  await t.app.close();
});

test('1.2.0 manufacturer is stored for later scans (migration 2), and an item removed takes its barcodes with it', async () => {
  const t = await boot();
  await mm(t, 'scan', { code: MILK, tick: false });
  const mdb = t.app.modules.loaded.get('barcode-scan').db;
  assert.equal(mdb.prepare('SELECT manufacturer FROM barcode_items WHERE code = ?').get(MILK.replace(/^0+/, '')).manufacturer, 'Tnuva');
  const id = (await itemRow(t, 'Milk 3% 1L')).id;
  await t.call('DELETE', `/api/items/${id}`, undefined, t.admin.cookie);
  assert.equal(mdb.prepare('SELECT COUNT(*) c FROM barcode_items').get().c, 0);
  await t.app.close();
});
