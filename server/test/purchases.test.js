import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, bundledDir: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie)).body.id;
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  // buy items at a store, with unit prices, and finish the trip
  const buy = async (storeId, items) => {
    for (const [name, quantity] of items) {
      const e = await call('POST', `/api/lists/${lid}/entries`, { name, quantity }, admin.cookie);
      await call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, admin.cookie);
    }
    const f = (await call('POST', `/api/lists/${lid}/finish`, { storeId, currency: 'ILS' }, admin.cookie)).body;
    const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, admin.cookie)).body;
    for (const l of d.lines) {
      const price = items.find(([n]) => n === l.name)[2];
      if (price !== undefined) await call('PATCH', `/api/purchases/${l.id}`, { unitPrice: price }, admin.cookie);
    }
    return f.tripId;
  };
  const want = (items) => Promise.all(items.map(([name, quantity]) => call('POST', `/api/lists/${lid}/entries`, { name, quantity }, admin.cookie)));
  return { app, call, admin, hid, lid, mkUser, buy, want };
}

test('a purchased line can be deleted, and restore keeps the purchased quantities', async () => {
  const { app, call, admin, lid, buy } = await boot();
  const tripId = await buy(null, [['Milk', 3, 6], ['Eggs', 2, 12], ['Rice', 1, 15]]);
  const d = (await call('GET', `/api/trips/${tripId}`, undefined, admin.cookie)).body;
  const rice = d.lines.find((l) => l.name === 'Rice');
  assert.equal((await call('DELETE', `/api/purchases/${rice.id}`, undefined, admin.cookie)).status, 200);
  assert.equal((await call('DELETE', `/api/purchases/${rice.id}`, undefined, admin.cookie)).status, 404); // already gone
  const after = (await call('GET', `/api/trips/${tripId}`, undefined, admin.cookie)).body;
  assert.deepEqual(after.lines.map((l) => l.name).sort(), ['Eggs', 'Milk']);
  const r = await call('POST', `/api/trips/${tripId}/restore`, { purchaseIds: after.lines.map((l) => l.id) }, admin.cookie);
  assert.deepEqual([r.body.added, r.body.merged], [2, 0]);
  const list = (await call('GET', `/api/lists/${lid}`, undefined, admin.cookie)).body;
  assert.deepEqual(list.entries.filter((e) => e.state === 'open').map((e) => [e.name, e.quantity]).sort(), [['Eggs', 2], ['Milk', 3]]);
  await app.close();
});

test('a user outside the household cannot delete someone else\'s purchased line', async () => {
  const { app, call, admin, buy } = await boot();
  const tripId = await buy(null, [['Milk', 1, 6]]);
  const line = (await call('GET', `/api/trips/${tripId}`, undefined, admin.cookie)).body.lines[0];
  const stranger = await call('POST', '/api/admin/users', { name: 'eve', username: 'eve' }, admin.cookie); // no household membership
  const login = await call('POST', '/api/auth/login', { login: 'eve', password: stranger.body.oneTimePassword });
  await call('POST', '/api/auth/change-password', { currentPassword: stranger.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
  assert.equal((await call('DELETE', `/api/purchases/${line.id}`, undefined, login.cookie)).status, 404);
  assert.equal((await call('GET', `/api/trips/${tripId}`, undefined, admin.cookie)).body.lines.length, 1);
  await app.close();
});
