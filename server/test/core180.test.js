import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const RECEIPT = 'SUPER SHOP\nMilk 2 x 3.45 6.90\nBread 12.50\nTOTAL 19.40\n';

async function boot(tesseract = async () => RECEIPT) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, moduleOptions: { 'receipt-ocr': { run: { tesseract } } } });
  const call = async (method, url, body, cookie, headers) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(headers || {}), ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie)).body.id;
  return { app, call, admin, hid, lid, dataDir };
}
const read = (t, buf = JPEG, cookie = t.admin.cookie, lid = t.lid) => t.call('POST', `/api/lists/${lid}/receipt-read`, buf, cookie, { 'content-type': 'image/jpeg' });

test('1.8.0 receipt-read: a photo becomes rows and a total, and nothing is saved (no trip, no receipt, no item, no file left)', async () => {
  const t = await boot();
  const r = await read(t);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 19.4);
  assert.deepEqual(r.body.rows.map((x) => [x.name, x.quantity, x.price]), [['Milk', 2, 3.45], ['Bread', 1, 12.5]]);
  assert.equal(t.app.db.prepare('SELECT COUNT(*) c FROM trips').get().c, 0);
  assert.equal(t.app.db.prepare('SELECT COUNT(*) c FROM receipts').get().c, 0);
  assert.equal(t.app.db.prepare('SELECT COUNT(*) c FROM items').get().c, 0);
  assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'tmp')), []);
  await t.app.close();
});

test('1.8.0 receipt-read: a name the household has is used as it is spelled there; bad images, no reader, failures and a Shopper are refused', async () => {
  const t = await boot();
  await t.call('POST', `/api/lists/${t.lid}/entries`, { name: 'Whole milk', quantity: 1 }, t.admin.cookie);
  await t.call('POST', `/api/lists/${t.lid}/entries`, { name: 'bread', quantity: 1 }, t.admin.cookie);
  const rows = (await read(t)).body.rows;
  assert.equal(rows[0].name, 'Milk');                                           // "Milk" is not "Whole milk": no guessing
  assert.equal(rows[1].name, 'bread');                                          // "Bread" is the household's "bread": it is spelled the household's way
  assert.equal((await read(t, Buffer.from('not an image at all'))).body.error, 'invalid_image');
  const dana = (await t.call('POST', '/api/admin/users', { name: 'dana', username: 'dana', householdId: t.hid }, t.admin.cookie)).body;
  const login = await t.call('POST', '/api/auth/login', { login: 'dana', password: dana.oneTimePassword });
  await t.call('POST', '/api/auth/change-password', { currentPassword: dana.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
  await t.call('PUT', `/api/lists/${t.lid}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await read(t, JPEG, login.cookie)).status, 403);
  assert.equal((await t.call('POST', '/api/admin/modules/receipt-ocr/disable', {}, t.admin.cookie)).status, 200);
  assert.equal((await read(t)).body.error, 'no_reader');
  await t.app.close();

  const bad = await boot(async () => { throw new Error('tesseract_not_installed'); });
  const r = await read(bad);
  assert.deepEqual([r.status, r.body.error], [502, 'ocr_failed']);
  assert.deepEqual(fs.readdirSync(path.join(bad.dataDir, 'tmp')), []);          // the temporary file is removed on failure too
  await bad.app.close();
});

test('1.8.0 add a trip: a line can carry a category for the item it creates; an unknown category is refused; an existing item keeps its own', async () => {
  const t = await boot();
  const cats = t.app.db.prepare('SELECT id, name_en FROM categories WHERE household_id = ?').all(t.hid);
  const dairy = cats.find((c) => c.name_en === 'Dairy & eggs').id, pantry = cats.find((c) => c.name_en === 'Pantry').id;
  const add = (lines) => t.call('POST', `/api/lists/${t.lid}/trips`, { lines }, t.admin.cookie);
  assert.equal((await add([{ name: 'Milk', quantity: 1, unitPrice: 7.9, categoryId: dairy }])).status, 200);
  assert.equal(t.app.db.prepare("SELECT category_id FROM items WHERE name = 'Milk'").get().category_id, dairy);
  assert.equal((await add([{ name: 'Milk', quantity: 1, categoryId: pantry }])).status, 200);          // existing item: its category stays
  assert.equal(t.app.db.prepare("SELECT category_id FROM items WHERE name = 'Milk'").get().category_id, dairy);
  assert.equal((await add([{ name: 'Rice', categoryId: 99999 }])).body.error, 'invalid_category');
  await t.app.close();
});
