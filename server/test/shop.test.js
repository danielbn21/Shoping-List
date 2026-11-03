import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot() {
  const app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie)).body.id;
  const add = async (name, extra = {}) => (await call('POST', `/api/lists/${lid}/entries`, { name, ...extra }, admin.cookie)).body;
  const detail = async (cookie = admin.cookie) => (await call('GET', `/api/lists/${lid}`, undefined, cookie)).body;
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  return { app, call, admin, hid, lid, add, detail, mkUser };
}

test('check, undo, shopping-now, Finish trip records purchases and clears the list', async () => {
  const { app, call, admin, hid, lid, add, detail } = await boot();
  const milk = await add('Milk', { quantity: 2 });
  const eggs = await add('Eggs');
  await add('Bread');
  const chk = (id, checked) => call('POST', `/api/entries/${id}/check`, { checked }, admin.cookie);

  assert.equal((await call('POST', `/api/lists/${lid}/finish`, {}, admin.cookie)).body.error, 'nothing_checked');
  await chk(milk.entryId, true);
  assert.equal((await detail()).shoppingNow.length, 1);
  await chk(milk.entryId, false); // accidental tap, undone
  assert.equal((await detail()).shoppingNow.length, 0);
  assert.equal((await detail()).entries.find((e) => e.id === milk.entryId).state, 'open');

  await chk(milk.entryId, true);
  await chk(eggs.entryId, true);
  const fin = await call('POST', `/api/lists/${lid}/finish`, {}, admin.cookie);
  assert.equal(fin.body.purchased, 2);
  assert.equal(fin.body.left, 1);
  const d = await detail();
  assert.deepEqual(d.entries.map((e) => e.name), ['Bread']); // unchecked item stays
  assert.equal(d.shoppingNow.length, 0);

  const bank = (await call('GET', `/api/households/${hid}/items?sort=recent&listId=${lid}`, undefined, admin.cookie)).body.items;
  const m = bank.find((i) => i.name === 'Milk');
  assert.equal(m.timesPurchased, 1); // history groundwork for smart suggestions
  assert.ok(m.lastPurchasedAt > 0);
  assert.deepEqual(bank.slice(0, 2).map((i) => i.name).sort(), ['Eggs', 'Milk']); // recently bought first

  // re-add from past items with a different quantity
  const again = await call('POST', `/api/lists/${lid}/entries`, { itemId: m.id, quantity: 5, source: 'typeahead' }, admin.cookie);
  assert.equal(again.body.merged, false);
  assert.equal((await detail()).entries.find((e) => e.name === 'Milk').quantity, 5);
  await app.close();
});

test('drag-and-drop reorder persists order and moves items between categories', async () => {
  const { app, call, admin, hid, add, detail, lid } = await boot();
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  const [produce, bakery] = [cats[0], cats[1]];
  const a = await add('Apples', { categoryId: produce.id });
  const b = await add('Bagels', { categoryId: bakery.id });
  const c = await add('Carrots', { categoryId: produce.id });
  const r = await call('POST', `/api/lists/${lid}/reorder`, {
    groups: [{ categoryId: produce.id, entryIds: [c.entryId, b.entryId] }, { categoryId: bakery.id, entryIds: [] }, { categoryId: null, entryIds: [a.entryId] }],
  }, admin.cookie);
  assert.equal(r.status, 200);
  const d = await detail();
  assert.deepEqual(d.entries.map((e) => e.name), ['Carrots', 'Bagels', 'Apples']);
  assert.equal(d.entries.find((e) => e.name === 'Bagels').categoryId, produce.id); // moved into Produce
  assert.equal(d.entries.find((e) => e.name === 'Apples').categoryId, null);
  assert.equal((await call('POST', `/api/lists/${lid}/reorder`, { groups: [{ categoryId: 99999, entryIds: [] }] }, admin.cookie)).status, 400);

  // category order is shared by the household
  const ids = cats.map((x) => x.id).reverse();
  assert.equal((await call('PUT', `/api/households/${hid}/categories/order`, { ids }, admin.cookie)).status, 200);
  assert.equal((await detail()).categories[0].id, ids[0]);
  await app.close();
});

test('store layouts keep their own walking order', async () => {
  const { app, call, admin, hid, detail } = await boot();
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  const s = await call('POST', `/api/households/${hid}/stores`, { name: 'Supermarket X' }, admin.cookie);
  const order = [cats[3].id, cats[0].id, cats[5].id];
  assert.equal((await call('PUT', `/api/stores/${s.body.id}/layout`, { categoryIds: order }, admin.cookie)).status, 200);
  const st = (await detail()).stores[0];
  assert.equal(st.name, 'Supermarket X');
  assert.deepEqual(st.categoryOrder, order);
  await call('DELETE', `/api/stores/${s.body.id}`, undefined, admin.cookie);
  assert.equal((await detail()).stores.length, 0);
  await app.close();
});

test('Shopper role can check items and finish, but cannot edit the list', async () => {
  const { app, call, admin, lid, add, detail, mkUser } = await boot();
  const dana = await mkUser('dana');
  const milk = await add('Milk');
  assert.equal((await call('PUT', `/api/lists/${lid}/members/${dana.id}`, { role: 'viewer' }, admin.cookie)).status, 200);
  assert.equal((await detail(dana.cookie)).list.role, 'viewer');
  assert.equal((await call('POST', `/api/lists/${lid}/entries`, { name: 'Eggs' }, dana.cookie)).status, 403);
  assert.equal((await call('PATCH', `/api/entries/${milk.entryId}`, { quantity: 3 }, dana.cookie)).status, 403);
  assert.equal((await call('POST', `/api/lists/${lid}/reorder`, { groups: [] }, dana.cookie)).status, 403);
  assert.equal((await call('POST', `/api/entries/${milk.entryId}/check`, { checked: true }, dana.cookie)).status, 200);
  assert.equal((await call('POST', `/api/lists/${lid}/finish`, {}, dana.cookie)).body.purchased, 1);
  // members endpoint is for editors only; back to Editor via the owner
  assert.equal((await call('GET', `/api/lists/${lid}/members`, undefined, dana.cookie)).status, 403);
  await call('PUT', `/api/lists/${lid}/members/${dana.id}`, { role: 'contributor' }, admin.cookie);
  const people = (await call('GET', `/api/lists/${lid}/members`, undefined, dana.cookie)).body.members;
  assert.equal(people.find((p) => p.name === 'dana').role, 'contributor');
  assert.equal(people.find((p) => p.name === 'Admin').role, 'owner');
  assert.equal((await call('PUT', `/api/lists/${lid}/members/${dana.id}`, { role: 'none' }, admin.cookie)).status, 400); // household list
  await app.close();
});

test('moving an entry to another category via PATCH re-files the item', async () => {
  const { app, call, admin, hid, add, detail, lid } = await boot();
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  const e = await add('Soap');
  await call('PATCH', `/api/entries/${e.entryId}`, { categoryId: cats[8].id }, admin.cookie);
  assert.equal((await detail()).entries[0].categoryId, cats[8].id);
  assert.equal((await call('PATCH', `/api/entries/${e.entryId}`, { categoryId: 424242 }, admin.cookie)).status, 400);
  assert.ok(lid);
  await app.close();
});
