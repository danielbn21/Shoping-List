import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'))) {
  const app = await buildApp({ dataDir, logger: false, bundledDir: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  let admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  if (admin.status !== 200) admin = await call('POST', '/api/auth/login', { login: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const mkList = async (name, extra = {}) => (await call('POST', '/api/lists', { householdId: hid, name, ...extra }, admin.cookie)).body.id;
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  const add = (lid, name, quantity = 1, extra = {}) => call('POST', `/api/lists/${lid}/entries`, { name, quantity, ...extra }, admin.cookie);
  const past = (lid, query = '', cookie = admin.cookie) => call('GET', `/api/households/${hid}/items?listId=${lid}${query}`, undefined, cookie).then((r) => r.body?.items?.map((i) => i.name));
  // buy items on a list at a store with unit prices, and finish the trip
  const buy = async (lid, storeId, items) => {
    for (const [name, quantity] of items) { const e = await add(lid, name, quantity); await call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, admin.cookie); }
    const f = (await call('POST', `/api/lists/${lid}/finish`, { storeId, currency: 'ILS' }, admin.cookie)).body;
    const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, admin.cookie)).body;
    for (const l of d.lines) { const price = items.find(([n]) => n === l.name)[2]; if (price !== undefined) await call('PATCH', `/api/purchases/${l.id}`, { unitPrice: price }, admin.cookie); }
    return f.tripId;
  };
  const store = async (name) => (await call('POST', `/api/households/${hid}/stores`, { name }, admin.cookie)).body.id;
  return { app, call, admin, hid, mkList, mkUser, add, past, buy, store, dataDir };
}

test('past items belong to a list: a new list starts empty, the item itself is shared, and each list counts its own purchases', async () => {
  const t = await boot();
  const a = await t.mkList('Shufersal'), b = await t.mkList('Rami Levy');
  assert.deepEqual(await t.past(b), []);                                   // a new list does not inherit the household's history
  const milkA = (await t.add(a, 'Milk', 2)).body.itemId;
  await t.buy(a, null, [['Eggs', 1, 12]]);
  assert.deepEqual((await t.past(a)).sort(), ['Eggs', 'Milk']);
  assert.deepEqual(await t.past(b), []);                                   // still empty for the other list

  // adding the same name in the other list reuses the household's item (so its category, note and matches are shared), and it joins that list's past items
  const milkB = (await t.add(b, 'Milk')).body.itemId;
  assert.equal(milkB, milkA);
  assert.deepEqual(await t.past(b), ['Milk']);
  const cat = (await t.call('POST', `/api/households/${t.hid}/categories`, { nameEn: 'Dairy' }, t.admin.cookie)).body.id;
  await t.call('PATCH', `/api/items/${milkA}`, { categoryId: cat, defaultNote: '1 l' }, t.admin.cookie);
  const inB = (await t.call('GET', `/api/households/${t.hid}/items?listId=${b}`, undefined, t.admin.cookie)).body.items[0];
  assert.deepEqual([inB.categoryId, inB.defaultNote], [cat, '1 l']);       // one record: the change shows in both lists

  // purchases are counted per list
  await t.buy(b, null, [['Milk', 1, 7]]);
  const statsA = (await t.call('GET', `/api/households/${t.hid}/items?listId=${a}`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Eggs');
  const statsB = (await t.call('GET', `/api/households/${t.hid}/items?listId=${b}`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Milk');
  assert.deepEqual([statsA.timesPurchased, statsB.timesPurchased], [1, 1]);
  assert.equal((await t.call('GET', `/api/households/${t.hid}/items?listId=${a}`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Milk').timesPurchased, 0);

  // the suggestions while typing, and the search, are this list's too
  assert.deepEqual(await t.past(b, '&q=egg&mode=typeahead'), []);
  assert.deepEqual(await t.past(a, '&q=egg&mode=typeahead'), ['Eggs']);
  // without a list the household still sees every item, and a list of another household is refused
  assert.deepEqual((await t.call('GET', `/api/households/${t.hid}/items`, undefined, t.admin.cookie)).body.items.map((i) => i.name).sort(), ['Eggs', 'Milk']);
  assert.equal((await t.call('GET', `/api/households/${t.hid}/items?listId=99999`, undefined, t.admin.cookie)).status, 404);
  await t.app.close();
});

test('removing past items: many at once, only from this list, never what is on the list now', async () => {
  const t = await boot();
  const a = await t.mkList('A'), b = await t.mkList('B');
  const ids = {};
  for (const n of ['Milk', 'Eggs', 'Rice', 'Salt']) { ids[n] = (await t.add(a, n)).body.itemId; await t.add(b, n); }
  const entries = (await t.call('GET', `/api/lists/${a}`, undefined, t.admin.cookie)).body.entries;
  for (const e of entries.filter((x) => ['Milk', 'Eggs', 'Rice'].includes(x.name))) await t.call('DELETE', `/api/entries/${e.id}`, undefined, t.admin.cookie); // off the list: they are past now
  assert.deepEqual((await t.past(a)).sort(), ['Eggs', 'Milk', 'Rice', 'Salt']);

  const rm = (lid, body, cookie = t.admin.cookie) => t.call('POST', `/api/lists/${lid}/past-items/remove`, body, cookie);
  const r = await rm(a, { itemIds: [ids.Milk, ids.Eggs, ids.Salt, ids.Milk] });
  assert.deepEqual([r.status, r.body.removed, r.body.skipped], [200, 2, [ids.Salt]]);   // Salt is on the list now, so it stays
  assert.deepEqual((await t.past(a)).sort(), ['Rice', 'Salt']);
  assert.deepEqual((await t.past(b)).sort(), ['Eggs', 'Milk', 'Rice', 'Salt']);          // the other list is untouched
  assert.equal((await t.call('GET', `/api/households/${t.hid}/items`, undefined, t.admin.cookie)).body.items.length, 4); // the household keeps the items
  assert.equal((await rm(a, { itemIds: [ids.Milk] })).body.removed, 0);                  // already gone
  assert.equal(t.app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'list.past_items_removed'").get().c, 1);

  await t.add(a, 'Milk');                                                                // putting it on the list again brings it back
  assert.ok((await t.past(a)).includes('Milk'));

  for (const bad of [{}, { itemIds: [] }, { itemIds: 'x' }, { itemIds: [1.5] }, { itemIds: Array.from({ length: 501 }, (_, i) => i + 1) }]) assert.equal((await rm(a, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  const viewer = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${a}/members/${viewer.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await rm(a, { itemIds: [ids.Rice] }, viewer.cookie)).status, 403);
  assert.equal((await rm(99999, { itemIds: [1] })).status, 404);
  assert.equal((await rm(a, { itemIds: [1] }, null)).status, 401);
  await t.app.close();
});

test('existing lists keep their history when the database is upgraded (every item a list ever had)', async () => {
  const t = await boot();
  const a = await t.mkList('A'), b = await t.mkList('B');
  await t.add(a, 'Milk'); await t.buy(a, null, [['Eggs', 1, 9]]); await t.add(b, 'Rice');
  const dir = t.dataDir;
  await t.app.close();
  const Database = createRequire(new URL('../package.json', import.meta.url))('better-sqlite3');
  const d = new Database(path.join(dir, 'shoplist.db'));
  d.exec('DROP TABLE list_items;'); d.pragma('user_version = 8'); d.close();          // what a 1.4.2 database looked like
  const t2 = await boot(dir);
  assert.equal(t2.app.db.pragma('user_version', { simple: true }), 9);
  const idOf = (name) => t2.app.db.prepare('SELECT id FROM lists WHERE name = ?').get(name).id;
  assert.deepEqual((await t2.past(idOf('A'))).sort(), ['Eggs', 'Milk']);
  assert.deepEqual(await t2.past(idOf('B')), ['Rice']);
  await t2.app.close();
});

test('estimates: the last price paid at the chosen store, or anywhere; the item price as a fallback; currency and privacy respected', async () => {
  const t = await boot();
  const shop = await t.mkList('Weekly'), other = await t.mkList('Other');
  const sh = await t.store('Shufersal'), rami = await t.store('Rami Levy');
  await t.buy(shop, sh, [['Milk', 1, 7], ['Eggs', 1, 14]]);
  await new Promise((r) => setTimeout(r, 5));
  await t.buy(shop, rami, [['Milk', 1, 6]]);
  const milk = t.app.db.prepare("SELECT id FROM items WHERE name = 'Milk'").get().id, eggs = t.app.db.prepare("SELECT id FROM items WHERE name = 'Eggs'").get().id;
  await t.add(shop, 'Milk', 2); await t.add(shop, 'Eggs'); const salt = (await t.add(shop, 'Salt')).body.itemId; await t.add(shop, 'Rice');
  await t.call('PATCH', `/api/items/${salt}`, { price: 3.5 }, t.admin.cookie);
  const est = (q = '') => t.call('GET', `/api/lists/${shop}/estimates${q}`, undefined, t.admin.cookie).then((r) => r.body);

  let r = await est();                                                      // no store: the latest price paid anywhere
  assert.deepEqual([r.currency, r.prices[milk].unitPrice, r.prices[milk].source, r.prices[eggs].unitPrice], ['ILS', 6, 'last', 14]);
  assert.deepEqual(r.prices[salt], { unitPrice: 3.5, source: 'item', at: null }); // the price saved on the item
  assert.equal(Object.keys(r.prices).length, 3);                              // Rice has no price at all
  r = await est(`?storeId=${sh}`);                                            // Shufersal: its own prices; Milk there was 7, Eggs 14
  assert.deepEqual([r.prices[milk].unitPrice, r.prices[milk].source, r.prices[eggs].unitPrice], [7, 'store', 14]);
  r = await est(`?storeId=${rami}`);                                          // Rami Levy: milk only, eggs were never bought there
  assert.deepEqual([r.prices[milk].unitPrice, r.prices[eggs]], [6, undefined]);
  assert.deepEqual((await est('?currency=USD')).prices[milk], undefined);     // another currency: shekel trips do not count
  assert.equal((await t.call('GET', `/api/lists/${shop}/estimates?storeId=99999`, undefined, t.admin.cookie)).status, 404);
  assert.equal((await t.call('GET', `/api/lists/${shop}/estimates`, undefined, null)).status, 401);

  // purchases on a private list of someone else are not used
  const dana = await t.mkUser('dana');
  const priv = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Mine', visibility: 'private' }, dana.cookie)).body.id;
  const e = await t.call('POST', `/api/lists/${priv}/entries`, { name: 'Eggs' }, dana.cookie);
  await t.call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, dana.cookie);
  const f = (await t.call('POST', `/api/lists/${priv}/finish`, { storeId: sh, currency: 'ILS' }, dana.cookie)).body;
  const line = (await t.call('GET', `/api/trips/${f.tripId}`, undefined, dana.cookie)).body.lines[0];
  await t.call('PATCH', `/api/purchases/${line.id}`, { unitPrice: 99 }, dana.cookie);
  assert.equal((await est()).prices[eggs].unitPrice, 14);                      // the admin does not see dana's private price
  const asDana = (await t.call('GET', `/api/lists/${shop}/estimates`, undefined, dana.cookie)).body;
  assert.equal(asDana.prices[eggs].unitPrice, 99);                             // dana does (it is hers and the newest)
  await t.app.close();
});

test('the estimates setting: the admin sets the default, each user can choose for themselves or go back to the default', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana');
  const me = async (u = t.admin) => (await t.call('GET', '/api/me', undefined, u.cookie)).body.user;
  assert.deepEqual([(await me()).estimatesEnabled, (await me()).estimatesDefault], [true, true]);   // on by default
  assert.equal((await t.call('PUT', '/api/admin/settings', { estimates_default: false }, t.admin.cookie)).status, 200);
  assert.deepEqual([(await me()).estimatesEnabled, (await me(dana)).estimatesEnabled, (await me(dana)).estimatesDefault], [false, false, false]);
  let r = await t.call('PUT', '/api/me/prefs', { showEstimates: true }, dana.cookie);        // dana turns it on for herself
  assert.deepEqual([r.body.user.estimatesEnabled, r.body.user.prefs.showEstimates, (await me()).estimatesEnabled], [true, true, false]);
  await t.call('PUT', '/api/admin/settings', { estimates_default: true }, t.admin.cookie);
  r = await t.call('PUT', '/api/me/prefs', { showEstimates: false }, t.admin.cookie);        // the admin turns it off for herself
  assert.deepEqual([r.body.user.estimatesEnabled, (await me(dana)).estimatesEnabled], [false, true]);
  r = await t.call('PUT', '/api/me/prefs', { showEstimates: null }, t.admin.cookie);          // back to the default
  assert.deepEqual([r.body.user.estimatesEnabled, r.body.user.prefs.showEstimates], [true, undefined]);
  assert.equal((await t.call('PUT', '/api/me/prefs', { showEstimates: 'yes' }, t.admin.cookie)).status, 400);
  assert.equal((await t.call('PUT', '/api/admin/settings', { estimates_default: false }, dana.cookie)).status, 403);
  await t.app.close();
});
