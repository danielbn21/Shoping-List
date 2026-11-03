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
  return { app, call, admin, hid: admin.body.user.households[0].id };
}

test('lists: create, add items, plural/case reuse the same bank item', async () => {
  const { app, call, admin, hid } = await boot();
  const l = await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie);
  assert.equal(l.status, 200);
  const add = (body) => call('POST', `/api/lists/${l.body.id}/entries`, body, admin.cookie);
  const a = await add({ name: 'Tomato' });
  assert.equal(a.status, 200);
  assert.equal(a.body.merged, false);
  const b = await add({ name: 'tomatoes', quantity: 2 });
  assert.equal(b.body.itemId, a.body.itemId); // same bank item
  assert.equal(b.body.merged, true);           // merged into the existing entry
  const view = await call('GET', `/api/lists/${l.body.id}`, undefined, admin.cookie);
  assert.equal(view.body.entries.length, 1);
  assert.equal(view.body.entries[0].quantity, 3);
  assert.ok(view.body.categories.length >= 10); // seeded default categories
  await app.close();
});

test('typo asks for confirmation; force creates a new item; typeahead accepted is logged', async () => {
  const { app, call, admin, hid } = await boot();
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'L' }, admin.cookie)).body.id;
  const add = (body) => call('POST', `/api/lists/${lid}/entries`, body, admin.cookie);
  const rice = await add({ name: 'Rice' });
  const typo = await add({ name: 'Rise' });
  assert.equal(typo.status, 409);
  assert.equal(typo.body.error, 'similar_items');
  assert.equal(typo.body.matches[0].name, 'Rice');
  assert.equal((await add({ name: 'Rise', force: true })).status, 200);
  const again = await add({ itemId: rice.body.itemId, source: 'typeahead' });
  assert.equal(again.body.merged, true);
  const ta = await call('GET', `/api/households/${hid}/items?q=ri&mode=typeahead&listId=${lid}`, undefined, admin.cookie);
  assert.equal(ta.body.items[0].name, 'Rice');
  assert.equal(ta.body.items[0].onListQty, 2);
  await app.close();
});

test('Hebrew items work end to end', async () => {
  const { app, call, admin, hid } = await boot();
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'רשימה' }, admin.cookie)).body.id;
  const a = await call('POST', `/api/lists/${lid}/entries`, { name: 'תפוז' }, admin.cookie);
  const b = await call('POST', `/api/lists/${lid}/entries`, { name: 'תפוזים' }, admin.cookie);
  assert.equal(b.body.itemId, a.body.itemId);
  await app.close();
});

test('private lists are visible only to chosen members; removal is soft', async () => {
  const { app, call, admin, hid } = await boot();
  const mk = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  const dana = await mk('dana'), eli = await mk('eli');
  const priv = await call('POST', '/api/lists', { householdId: hid, name: 'Gift', visibility: 'private', memberIds: [dana.id] }, admin.cookie);
  assert.equal((await call('GET', `/api/lists/${priv.body.id}`, undefined, dana.cookie)).status, 200);
  assert.equal((await call('GET', `/api/lists/${priv.body.id}`, undefined, eli.cookie)).status, 404);
  const names = (await call('GET', '/api/lists', undefined, eli.cookie)).body.lists.map((x) => x.name);
  assert.ok(!names.includes('Gift'));
  const e = await call('POST', `/api/lists/${priv.body.id}/entries`, { name: 'Wrapping paper' }, dana.cookie);
  assert.equal((await call('DELETE', `/api/entries/${e.body.entryId}`, undefined, eli.cookie)).status, 404);
  assert.equal((await call('DELETE', `/api/entries/${e.body.entryId}`, undefined, dana.cookie)).status, 200);
  // bank keeps the item after removal, so it can be re-added with one tap
  const bank = await call('GET', `/api/households/${hid}/items`, undefined, dana.cookie);
  assert.equal(bank.body.items.length, 1);
  // household members can use household lists
  const house = await call('POST', '/api/lists', { householdId: hid, name: 'Home' }, admin.cookie);
  assert.equal((await call('POST', `/api/lists/${house.body.id}/entries`, { name: 'Milk' }, eli.cookie)).status, 200);
  await app.close();
});

test('categories and item recategorising; category order affects nothing else yet', async () => {
  const { app, call, admin, hid } = await boot();
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'L' }, admin.cookie)).body.id;
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  const dairy = cats.find((c) => c.nameEn === 'Dairy & eggs');
  const m = await call('POST', `/api/lists/${lid}/entries`, { name: 'Milk', categoryId: dairy.id }, admin.cookie);
  let view = await call('GET', `/api/lists/${lid}`, undefined, admin.cookie);
  assert.equal(view.body.entries[0].categoryId, dairy.id);
  const nc = await call('POST', `/api/households/${hid}/categories`, { nameEn: 'Bulk', nameHe: 'כמויות' }, admin.cookie);
  await call('PATCH', `/api/items/${m.body.itemId}`, { categoryId: nc.body.id }, admin.cookie);
  await call('DELETE', `/api/categories/${nc.body.id}`, undefined, admin.cookie);
  view = await call('GET', `/api/lists/${lid}`, undefined, admin.cookie);
  assert.equal(view.body.entries[0].categoryId, null); // deleting a category un-categorises its items
  await app.close();
});
