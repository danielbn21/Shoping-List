import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../../server/src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false });
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
  const addStore = async (name, chain) => {
    const id = (await call('POST', `/api/households/${hid}/stores`, { name }, admin.cookie)).body.id;
    if (chain) await call('PUT', `/api/m/price-compare/stores/${id}/chain`, { chain }, admin.cookie);
    return id;
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
  return { app, call, admin, hid, lid, mkUser, addStore, buy, want };
}

test('chain selection: editors choose, everyone can look, unknown chains and branches are refused', async () => {
  const { app, call, admin, lid, mkUser } = await boot();
  const shopper = await mkUser('dana');
  await call('PUT', `/api/lists/${lid}/members/${shopper.id}`, { role: 'viewer' }, admin.cookie);

  const put = await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'shufersal' }, { chain: 'rami_levy' }, { chain: 'shufersal' }] }, admin.cookie);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.selection.map((s) => s.chain), ['shufersal', 'rami_levy']); // duplicates collapse

  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'nope' }] }, admin.cookie)).status, 400);
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'shufersal', branchId: '12' }] }, admin.cookie)).body.error, 'unknown_branch'); // the branch directory is empty here
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'victory' }] }, admin.cookie)).status, 400); // not supported yet
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [] }, shopper.cookie)).status, 403); // a Shopper cannot change it

  const seen = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, shopper.cookie)).body; // but can see it
  assert.equal(seen.canEdit, false);
  assert.deepEqual(seen.selection.map((s) => s.chain), ['shufersal', 'rami_levy']);
  assert.ok(seen.chains.length >= 2);
  await app.close();
});

test('comparison prices the open items from your own receipts, with coverage and missing items', async () => {
  const { app, call, admin, lid, addStore, buy, want } = await boot();
  const sh = await addStore('Shufersal Ramat Gan', 'shufersal');
  const rl = await addStore('Rami Levy Bnei Brak', 'rami_levy');
  await buy(sh, [['Milk', 1, 6], ['Eggs', 1, 12]]);
  await buy(rl, [['Milk', 1, 5], ['Eggs', 1, 13], ['Bread', 1, 9]]);
  await want([['Milk', 2], ['Eggs', 1], ['Bread', 1], ['Tahini', 1]]);
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'shufersal' }, { chain: 'rami_levy' }, { chain: 'carrefour' }] }, admin.cookie);

  const r = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body;
  assert.equal(r.openCount, 4);
  assert.deepEqual(r.results.map((x) => x.chain), ['rami_levy', 'shufersal', 'carrefour']); // most items priced first, no data last
  const [ramiLevy, shufersal, carrefour] = r.results;
  assert.deepEqual([ramiLevy.priced, ramiLevy.of, ramiLevy.total], [3, 4, 5 * 2 + 13 + 9]);
  assert.deepEqual(ramiLevy.missing.map((m) => m.name), ['Tahini']);
  assert.deepEqual([shufersal.priced, shufersal.total], [2, 6 * 2 + 12]);
  assert.deepEqual(shufersal.missing.map((m) => m.name), ['Bread', 'Tahini']);
  assert.deepEqual([carrefour.priced, carrefour.total, carrefour.missing.length], [0, null, 4]);
  await app.close();
});

test('only open items count, the newest price wins, other currencies and unlinked stores are ignored', async () => {
  const { app, call, admin, lid, addStore, buy, want } = await boot();
  const sh = await addStore('Shufersal', 'shufersal');
  const plain = await addStore('Corner shop'); // not linked to a chain
  await buy(sh, [['Milk', 1, 6]]);
  await buy(sh, [['Milk', 1, 7]]); // newer
  await buy(plain, [['Eggs', 1, 1]]);
  await want([['Milk', 1], ['Eggs', 1]]);
  const e = await call('POST', `/api/lists/${lid}/entries`, { name: 'Bread', quantity: 1 }, admin.cookie);
  await call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, admin.cookie); // in the cart: not part of the comparison
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'shufersal' }] }, admin.cookie);

  const r = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body;
  assert.equal(r.openCount, 2);
  assert.deepEqual([r.results[0].priced, r.results[0].total], [1, 7]);
  assert.deepEqual(r.results[0].missing.map((m) => m.name), ['Eggs']);

  // a trip recorded in another currency is not mixed in
  const usd = await addStore('Costco', 'carrefour');
  const e2 = await call('POST', `/api/lists/${lid}/entries`, { name: 'Soda', quantity: 1 }, admin.cookie);
  await call('POST', `/api/entries/${e2.body.entryId}/check`, { checked: true }, admin.cookie);
  const f = (await call('POST', `/api/lists/${lid}/finish`, { storeId: usd, currency: 'USD' }, admin.cookie)).body;
  const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, admin.cookie)).body;
  await call('PATCH', `/api/purchases/${d.lines[0].id}`, { unitPrice: 2 }, admin.cookie);
  await want([['Soda', 1]]);
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'carrefour' }] }, admin.cookie);
  const r2 = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body;
  assert.equal(r2.results[0].priced, 0);
  await app.close();
});

test('disabling the module switches comparison off for everyone; the user\'s own switch hides it for them', async () => {
  const { app, call, admin, lid, mkUser } = await boot();
  const dana = await mkUser('dana');
  assert.ok(admin.body.user.modules.some((m) => m.id === 'price-compare' && m.on));
  assert.ok((await call('GET', '/api/me', undefined, dana.cookie)).body.user.capabilities.includes('price-source'));
  assert.equal((await call('PUT', '/api/modules/price-compare/me', { on: false }, dana.cookie)).body.user.modules[0].on, false);
  assert.equal((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, dana.cookie)).status, 404); // off for her
  assert.equal((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).status, 200); // still on for the admin
  await call('POST', '/api/admin/modules/price-compare/disable', {}, admin.cookie);
  assert.equal((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).status, 404);
  assert.ok(!(await call('GET', '/api/me', undefined, admin.cookie)).body.user.modules.some((m) => m.id === 'price-compare'));
  await app.close();
});

test('stores can be linked to a chain and unlinked again', async () => {
  const { app, call, admin, lid, addStore } = await boot();
  const id = await addStore('Local', 'politzer');
  const stores = () => call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie).then((r) => r.body.stores);
  assert.equal((await stores())[0].chain, 'politzer');
  assert.equal((await call('PUT', `/api/m/price-compare/stores/${id}/chain`, { chain: 'bogus' }, admin.cookie)).status, 400);
  assert.equal((await call('PUT', `/api/m/price-compare/stores/${id}/chain`, { chain: 'victory' }, admin.cookie)).status, 400); // listed, but not supported yet
  await call('PUT', `/api/m/price-compare/stores/${id}/chain`, { chain: null }, admin.cookie);
  assert.equal((await stores())[0].chain, null);
  await call('PATCH', `/api/stores/${id}`, { name: 'Renamed' }, admin.cookie); // renaming still works on its own
  assert.deepEqual([(await stores())[0].name, (await stores())[0].chain], ['Renamed', null]);
  await app.close();
});
