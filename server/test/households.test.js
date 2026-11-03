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
  const mkUser = async (username, householdId) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  return { app, call, admin, hid, mkUser };
}

test('server reports its version for the app to compare against', async () => {
  const { app, call } = await boot();
  const h = (await call('GET', '/api/health')).body;
  const pc = (await call('GET', '/api/public-config')).body;
  assert.match(h.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pc.version, h.version);
  await app.close();
});

test('create, rename and delete a household (delete needs the name typed back)', async () => {
  const { app, call, admin } = await boot();
  const c = await call('POST', '/api/households', { name: 'Cabin' }, admin.cookie);
  assert.equal(c.status, 200);
  assert.equal((await call('PATCH', `/api/households/${c.body.id}`, { name: 'Lake Cabin' }, admin.cookie)).status, 200);
  const me = (await call('GET', '/api/me', undefined, admin.cookie)).body.user;
  assert.deepEqual(me.households.map((h) => h.name), ['Admin', 'Lake Cabin']);
  assert.equal((await call('DELETE', `/api/households/${c.body.id}`, { confirmName: 'nope' }, admin.cookie)).body.error, 'name_mismatch');
  assert.equal((await call('DELETE', `/api/households/${c.body.id}`, { confirmName: 'lake cabin' }, admin.cookie)).status, 200);
  assert.equal((await call('GET', '/api/me', undefined, admin.cookie)).body.user.households.length, 1);
  await app.close();
});

test('admin can switch off household creation for ordinary users', async () => {
  const { app, call, admin, hid, mkUser } = await boot();
  const dana = await mkUser('dana', hid);
  assert.equal((await call('GET', '/api/me', undefined, dana.cookie)).body.user.canCreateHousehold, true);
  await call('PUT', '/api/admin/settings', { allow_user_households: false }, admin.cookie);
  assert.equal((await call('GET', '/api/me', undefined, dana.cookie)).body.user.canCreateHousehold, false);
  assert.equal((await call('POST', '/api/households', { name: 'X' }, dana.cookie)).body.error, 'household_creation_disabled');
  assert.equal((await call('POST', '/api/households', { name: 'X' }, admin.cookie)).status, 200); // admin always may
  await app.close();
});

test('members: add by username, roles, removal hands list ownership on, leave rules', async () => {
  const { app, call, admin, hid, mkUser } = await boot();
  const dana = await mkUser('dana', hid);
  const eli = await mkUser('eli', (await call('POST', '/api/households', { name: 'Elsewhere' }, admin.cookie)).body.id);
  // not a member of Admin's household yet: add by exact username
  assert.equal((await call('POST', `/api/households/${hid}/members`, { username: 'nobody' }, admin.cookie)).body.error, 'user_not_found');
  assert.equal((await call('POST', `/api/households/${hid}/members`, { username: 'dana' }, admin.cookie)).body.error, 'already_member');
  assert.equal((await call('POST', `/api/households/${hid}/members`, { username: 'eli' }, admin.cookie)).status, 200);
  // members cannot manage
  assert.equal((await call('POST', `/api/households/${hid}/members`, { username: 'eli' }, dana.cookie)).status, 403);
  assert.equal((await call('PATCH', `/api/households/${hid}`, { name: 'Hacked' }, dana.cookie)).status, 403);
  // roles and the last-owner guard
  assert.equal((await call('PATCH', `/api/households/${hid}/members/${eli.id}`, { role: 'owner' }, admin.cookie)).status, 200);
  const adminId = (await call('GET', '/api/me', undefined, admin.cookie)).body.user.id;
  assert.equal((await call('PATCH', `/api/households/${hid}/members/${eli.id}`, { role: 'member' }, admin.cookie)).status, 200);
  assert.equal((await call('PATCH', `/api/households/${hid}/members/${adminId}`, { role: 'member' }, admin.cookie)).body.error, 'last_owner');
  // a list Dana owns moves to an owner when Dana is removed
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Danas', visibility: 'private' }, dana.cookie)).body.id;
  assert.equal((await call('GET', `/api/lists/${lid}`, undefined, admin.cookie)).status, 404);
  assert.equal((await call('DELETE', `/api/households/${hid}/members/${dana.id}`, undefined, admin.cookie)).status, 200);
  assert.equal((await call('GET', `/api/lists/${lid}`, undefined, admin.cookie)).body.list.role, 'owner');
  assert.equal((await call('GET', `/api/lists/${lid}`, undefined, dana.cookie)).status, 404);
  // leave: Eli may leave; the sole owner may not while others remain
  assert.equal((await call('POST', `/api/households/${hid}/leave`, {}, admin.cookie)).body.error, 'last_owner'); // sole owner must hand over first
  assert.equal((await call('POST', `/api/households/${hid}/leave`, {}, eli.cookie)).status, 200); // a plain member may leave
  assert.equal((await call('GET', '/api/me', undefined, eli.cookie)).body.user.households.some((h) => h.id === hid), false);
  assert.equal((await call('POST', `/api/households/${hid}/leave`, {}, admin.cookie)).body.error, 'last_member'); // alone: delete instead
  await app.close();
});

test('personal ordering of households and lists', async () => {
  const { app, call, admin, hid } = await boot();
  const h2 = (await call('POST', '/api/households', { name: 'Second' }, admin.cookie)).body.id;
  assert.equal((await call('PUT', '/api/households/order', { ids: [h2, hid] }, admin.cookie)).status, 200);
  assert.deepEqual((await call('GET', '/api/me', undefined, admin.cookie)).body.user.households.map((h) => h.id), [h2, hid]);
  const a = (await call('POST', '/api/lists', { householdId: hid, name: 'A' }, admin.cookie)).body.id;
  const b = (await call('POST', '/api/lists', { householdId: hid, name: 'B' }, admin.cookie)).body.id;
  await call('PUT', `/api/households/${hid}/lists/order`, { ids: [b, a] }, admin.cookie);
  assert.deepEqual((await call('GET', '/api/lists', undefined, admin.cookie)).body.lists.map((l) => l.name), ['B', 'A']);
  assert.equal((await call('PUT', `/api/households/${hid}/lists/order`, { ids: [999] }, admin.cookie)).status, 400);
  await app.close();
});

test('item default note and price: prefill on add, copied onto purchases', async () => {
  const { app, call, admin, hid } = await boot();
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'L' }, admin.cookie)).body.id;
  const first = (await call('POST', `/api/lists/${lid}/entries`, { name: 'Milk' }, admin.cookie)).body;
  const p = await call('PATCH', `/api/items/${first.itemId}`, { defaultNote: 'lactose free', price: 7.9 }, admin.cookie);
  assert.equal(p.status, 200);
  assert.equal((await call('PATCH', `/api/items/${first.itemId}`, { price: -1 }, admin.cookie)).body.error, 'invalid_price');
  await call('DELETE', `/api/entries/${first.entryId}`, undefined, admin.cookie);
  const again = (await call('POST', `/api/lists/${lid}/entries`, { itemId: first.itemId, quantity: 3 }, admin.cookie)).body;
  const d = (await call('GET', `/api/lists/${lid}`, undefined, admin.cookie)).body;
  assert.equal(d.entries[0].note, 'lactose free'); // default note prefilled
  await call('POST', `/api/entries/${again.entryId}/check`, { checked: true }, admin.cookie);
  await call('POST', `/api/lists/${lid}/finish`, {}, admin.cookie);
  const bank = (await call('GET', `/api/households/${hid}/items`, undefined, admin.cookie)).body.items[0];
  assert.equal(bank.price, 7.9);
  assert.equal(bank.defaultNote, 'lactose free');
  const row = app.db.prepare('SELECT unit_price, line_total FROM purchase_events').get();
  assert.equal(row.unit_price, 7.9);
  assert.equal(row.line_total, 23.7); // price recorded per purchase, so later price changes do not rewrite history
  await app.close();
});
