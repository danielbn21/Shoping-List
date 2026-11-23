import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

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
  const mkUser = async (username, householdId) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  return { app, call, admin, mkUser, dataDir, db: app.db, adminHid: admin.body.user.households[0].id };
}
const list = async (t) => (await t.call('GET', '/api/admin/households', undefined, t.admin.cookie)).body.households;

test('1.8.1 admin lists every household with members, roles and counts, and each user with their households', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana', t.adminHid);
  const hs = await list(t);
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0].members.map((m) => [m.username, m.role]).sort(), [['admin', 'owner'], ['dana', 'member']]);
  assert.deepEqual(Object.keys(hs[0].counts), ['lists', 'items', 'trips', 'receipts']);
  const users = (await t.call('GET', '/api/admin/users', undefined, t.admin.cookie)).body.users;
  assert.deepEqual(users.find((u) => u.username === 'dana').householdList, [{ id: t.adminHid, name: hs[0].name, role: 'member' }]);
  assert.equal((await t.call('GET', '/api/admin/households', undefined, dana.cookie)).status, 403);
  await t.app.close();
});

test('1.8.1 admin creates a household for a chosen owner; a bad owner and a non-admin are refused', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana', t.adminHid);
  const r = await t.call('POST', '/api/admin/households', { name: 'Cohen family', ownerId: dana.id }, t.admin.cookie);
  assert.equal(r.status, 200);
  const h = (await list(t)).find((x) => x.id === r.body.id);
  assert.deepEqual(h.members.map((m) => [m.username, m.role]), [['dana', 'owner']]);
  assert.ok(t.db.prepare('SELECT COUNT(*) c FROM categories WHERE household_id = ?').get(h.id).c > 0);   // it starts with the default categories
  assert.equal((await t.call('POST', '/api/admin/households', { name: 'X', ownerId: 99999 }, t.admin.cookie)).status, 404);
  assert.equal((await t.call('POST', '/api/admin/households', { name: '  ' }, t.admin.cookie)).body.error, 'invalid_name');
  assert.equal((await t.call('POST', '/api/admin/households', { name: 'Mine' }, dana.cookie)).status, 403);
  await t.app.close();
});

test('1.8.1 admin adds a user with a role, changes the role, removes them, and cannot strip the last owner', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana', t.adminHid);
  const avi = await t.mkUser('avi', t.adminHid);
  const hid = (await t.call('POST', '/api/admin/households', { name: 'Office', ownerId: dana.id }, t.admin.cookie)).body.id;
  assert.equal((await t.call('POST', `/api/households/${hid}/members`, { username: 'avi', role: 'owner' }, t.admin.cookie)).status, 200);
  assert.equal((await list(t)).find((h) => h.id === hid).members.find((m) => m.username === 'avi').role, 'owner');
  assert.equal((await t.call('POST', `/api/households/${hid}/members`, { username: 'avi' }, t.admin.cookie)).body.error, 'already_member');
  assert.equal((await t.call('PATCH', `/api/households/${hid}/members/${avi.id}`, { role: 'member' }, t.admin.cookie)).status, 200);
  assert.equal((await t.call('PATCH', `/api/households/${hid}/members/${dana.id}`, { role: 'member' }, t.admin.cookie)).body.error, 'last_owner');
  assert.equal((await t.call('DELETE', `/api/households/${hid}/members/${dana.id}`, undefined, t.admin.cookie)).body.error, 'last_owner');
  assert.equal((await t.call('DELETE', `/api/households/${hid}/members/${avi.id}`, undefined, t.admin.cookie)).status, 200);
  assert.deepEqual((await list(t)).find((h) => h.id === hid).members.map((m) => m.username), ['dana']);
  assert.equal((await t.call('PATCH', `/api/households/${hid}`, { name: 'Office kitchen' }, t.admin.cookie)).status, 200);
  assert.equal((await list(t)).find((h) => h.id === hid).name, 'Office kitchen');
  assert.equal((await t.call('POST', `/api/households/${hid}/members`, { username: 'avi' }, avi.cookie)).status, 403);   // a non-owner still cannot
  await t.app.close();
});

test('1.8.1 deleting a household leaves nothing of it behind (every table, receipt photos, module data) and touches no other household', async () => {
  const t = await boot();
  const dana = await t.mkUser('dana', t.adminHid);
  const hid = (await t.call('POST', '/api/admin/households', { name: 'Cohen family', ownerId: dana.id }, t.admin.cookie)).body.id;
  const other = t.adminHid;

  // fill both households: a list with entries, a trip with a receipt photo, a store, an invite, saved prices, a module's barcode link
  const fill = async (household, cookie) => {
    const lid = (await t.call('POST', '/api/lists', { householdId: household, name: 'Groceries' }, cookie)).body.id;
    await t.call('POST', `/api/lists/${lid}/entries`, { name: 'Milk', quantity: 2 }, cookie);
    await t.call('POST', `/api/lists/${lid}/entries`, { name: 'Bread', quantity: 1 }, cookie);
    const trip = await t.call('POST', `/api/lists/${lid}/trips`, { lines: [{ name: 'Milk', quantity: 1, unitPrice: 7.9 }, { name: 'Eggs', quantity: 1, unitPrice: 12 }], total: 19.9 }, cookie);
    assert.equal(trip.status, 200);
    t.db.prepare('INSERT INTO stores(household_id, name) VALUES (?,?)').run(household, 'Shop');
    const dir = path.join(t.dataDir, 'receipts', String(household));
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'r1.jpg'), 'x');
    t.db.prepare('INSERT INTO receipts(trip_id, household_id, file, mime, uploaded_at) SELECT id, household_id, ?, ?, ? FROM trips WHERE household_id = ? LIMIT 1').run('r1.jpg', 'image/jpeg', Date.now(), household);
    const itemId = t.db.prepare('SELECT id FROM items WHERE household_id = ? LIMIT 1').get(household).id;
    t.app.modules.loaded.get('barcode-scan')?.db.prepare('INSERT INTO barcode_items(household_id, code, item_id, product_name, created_by, created_at) VALUES (?,?,?,?,?,?)').run(household, `729${household}`, itemId, 'Milk', 1, Date.now());
    return lid;
  };
  const lidDeleted = await fill(hid, dana.cookie);
  await fill(other, t.admin.cookie);

  const counts = (household) => Object.fromEntries(t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .filter(({ name }) => t.db.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === 'household_id'))
    .map(({ name }) => [name, t.db.prepare(`SELECT COUNT(*) c FROM ${name} WHERE household_id = ?`).get(household).c]));
  const before = counts(hid), otherBefore = counts(other);
  assert.ok(before.items > 0 && before.trips > 0 && before.receipts > 0 && before.stores > 0 && before.categories > 0);   // there is something to remove

  assert.equal((await t.call('DELETE', `/api/households/${hid}`, { confirmName: 'wrong' }, t.admin.cookie)).body.error, 'name_mismatch');
  assert.equal((await t.call('DELETE', `/api/households/${hid}`, { confirmName: 'Cohen family' }, t.admin.cookie)).status, 200);

  assert.deepEqual(Object.entries(counts(hid)).filter(([, n]) => n), []);                                  // nothing left in any table with a household_id
  for (const { name } of t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {      // nor anything under the deleted list
    if (t.db.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === 'list_id')) assert.equal(t.db.prepare(`SELECT COUNT(*) c FROM ${name} WHERE list_id = ?`).get(lidDeleted).c, 0, name);
  }
  assert.equal(fs.existsSync(path.join(t.dataDir, 'receipts', String(hid))), false);                       // the receipt photos are gone
  assert.equal(t.app.modules.loaded.get('barcode-scan').db.prepare('SELECT COUNT(*) c FROM barcode_items WHERE household_id = ?').get(hid).c, 0);   // so is the module's data
  assert.deepEqual(counts(other), otherBefore);                                                            // the other household is as it was
  assert.equal(fs.existsSync(path.join(t.dataDir, 'receipts', String(other), 'r1.jpg')), true);
  assert.equal(t.app.modules.loaded.get('barcode-scan').db.prepare('SELECT COUNT(*) c FROM barcode_items WHERE household_id = ?').get(other).c, 1);
  assert.ok(t.db.prepare('SELECT 1 FROM users WHERE id = ?').get(dana.id));                                // the member keeps the account
  assert.equal(t.db.prepare('SELECT COUNT(*) c FROM household_members WHERE household_id = ?').get(hid).c, 0);
  await t.app.close();
});
