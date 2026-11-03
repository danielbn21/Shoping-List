import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { parseReceiptText } from '../src/ocr.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);

async function boot(ocrRun) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, ocrRun });
  const call = async (method, url, body, cookie, headers) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(headers || {}), ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, text: res.body, headers: res.headers, cookie: c ? `sl_session=${c.value}` : null };
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
  // buy things and finish a trip
  const trip = async (items, extra = {}, cookie = admin.cookie, list = lid) => {
    for (const [name, quantity] of items) {
      const e = await call('POST', `/api/lists/${list}/entries`, { name, quantity }, admin.cookie);
      await call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, cookie);
    }
    return (await call('POST', `/api/lists/${list}/finish`, extra, cookie)).body;
  };
  return { app, call, admin, hid, lid, mkUser, trip, dataDir };
}

test('finish records total and currency; history shows trips and details', async () => {
  const { app, call, admin, lid, trip } = await boot();
  const f = await trip([['Milk', 2], ['Bread', 1]], { total: 31.4, currency: 'ILS' });
  assert.ok(f.tripId);
  const h = (await call('GET', `/api/lists/${lid}/history`, undefined, admin.cookie)).body;
  assert.equal(h.trips.length, 1);
  assert.deepEqual([h.trips[0].total, h.trips[0].currency, h.trips[0].itemCount], [31.4, 'ILS', 2]);
  const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, admin.cookie)).body;
  assert.deepEqual(d.lines.map((l) => l.name), ['Milk', 'Bread']);
  assert.equal((await call('POST', `/api/lists/${lid}/finish`, { total: -3 }, admin.cookie)).status, 400);
  await app.close();
});

test('any user on the list (even a Shopper) can edit prices, totals and restore; outsiders cannot', async () => {
  const { app, call, admin, hid, lid, mkUser, trip } = await boot();
  const dana = await mkUser('dana');
  await call('PUT', `/api/lists/${lid}/members/${dana.id}`, { role: 'viewer' }, admin.cookie); // Shopper
  const f = await trip([['Milk', 2], ['Eggs', 1]], { total: 20 });
  const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, dana.cookie)).body;
  const milk = d.lines.find((l) => l.name === 'Milk');
  assert.equal((await call('PATCH', `/api/purchases/${milk.id}`, { unitPrice: 7.9 }, dana.cookie)).status, 200);
  let again = (await call('GET', `/api/trips/${f.tripId}`, undefined, dana.cookie)).body.lines.find((l) => l.name === 'Milk');
  assert.deepEqual([again.unitPrice, again.lineTotal], [7.9, 15.8]); // line total follows quantity
  await call('PATCH', `/api/purchases/${milk.id}`, { lineTotal: 18 }, dana.cookie);
  again = (await call('GET', `/api/trips/${f.tripId}`, undefined, dana.cookie)).body.lines.find((l) => l.name === 'Milk');
  assert.deepEqual([again.unitPrice, again.lineTotal], [9, 18]);
  assert.equal((await call('PATCH', `/api/purchases/${milk.id}`, { unitPrice: -1 }, dana.cookie)).body.error, 'invalid_price');
  assert.equal((await call('PATCH', `/api/trips/${f.tripId}`, { total: 25.5 }, dana.cookie)).status, 200);
  assert.equal((await call('GET', `/api/trips/${f.tripId}`, undefined, dana.cookie)).body.trip.total, 25.5);

  // restore selected lines into the list; quantities merge with what is already there
  await call('POST', `/api/lists/${lid}/entries`, { name: 'Milk', quantity: 1 }, admin.cookie);
  const r = await call('POST', `/api/trips/${f.tripId}/restore`, { purchaseIds: [milk.id] }, dana.cookie);
  assert.deepEqual([r.body.added, r.body.merged], [0, 1]);
  const entries = (await call('GET', `/api/lists/${lid}`, undefined, admin.cookie)).body.entries;
  assert.equal(entries.find((e) => e.name === 'Milk').quantity, 3);
  assert.equal((await call('POST', `/api/trips/${f.tripId}/restore`, { purchaseIds: [] }, dana.cookie)).body.error, 'nothing_selected');

  // someone outside the household sees nothing
  const other = await call('POST', '/api/admin/users', { name: 'Out', username: 'out' }, admin.cookie);
  const login = await call('POST', '/api/auth/login', { login: 'out', password: other.body.oneTimePassword });
  await call('POST', '/api/auth/change-password', { currentPassword: other.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
  assert.equal((await call('GET', `/api/trips/${f.tripId}`, undefined, login.cookie)).status, 404);
  assert.equal((await call('POST', `/api/trips/${f.tripId}/restore`, {}, login.cookie)).status, 404);
  assert.equal((await call('GET', `/api/households/${hid}/purchases.csv`, undefined, login.cookie)).status, 403);
  await app.close();
});

test('receipt photo: validated, stored, read by OCR, reviewed and applied', async () => {
  const ocrRun = { tesseract: async () => fs.readFileSync(new URL('./fixtures/receipt_en.txt', import.meta.url), 'utf8'), cloud: async () => { throw new Error('should not run'); } };
  const { app, call, admin, hid, lid, trip, dataDir } = await boot(ocrRun);
  const f = await trip([['Milk', 1], ['Bread', 1]]);
  const up = (buf, type = 'image/jpeg') => call('POST', `/api/trips/${f.tripId}/receipts`, buf, admin.cookie, { 'content-type': type });

  assert.equal((await up(Buffer.from('not an image at all, just text'))).body.error, 'invalid_image'); // sniffed by bytes, not by header
  const r = await up(JPEG);
  assert.equal(r.status, 200);
  assert.equal(r.body.ocrStatus, 'pending');
  await app.ocr.idle();
  assert.equal((await call('GET', `/api/receipts/${r.body.id}/image`, undefined, admin.cookie)).headers['content-type'], 'image/jpeg');

  const rv = (await call('GET', `/api/receipts/${r.body.id}`, undefined, admin.cookie)).body;
  assert.equal(rv.ocrStatus, 'done');
  assert.equal(rv.result.total, 54.1);
  const byName = Object.fromEntries(rv.result.lines.map((l) => [l.name, l]));
  assert.ok(byName['Milk 3% 1L'].match.purchaseId);       // matched to what was bought on this trip
  assert.equal(byName['Milk 3% 1L'].match.name, 'Milk');
  assert.ok(byName['Bread'].match.purchaseId);
  assert.equal(byName['Tomatoes'].match, null);           // not on the list: will be added

  const lines = rv.result.lines.map((l) => ({ ...l, ...(l.match ?? {}), include: l.name !== 'Rice 9' })); // skip one line
  const ap = await call('POST', `/api/receipts/${r.body.id}/apply`, { lines, total: rv.result.total }, admin.cookie);
  assert.equal(ap.body.applied, 4);
  const d = (await call('GET', `/api/trips/${f.tripId}`, undefined, admin.cookie)).body;
  assert.equal(d.trip.total, 54.1);
  assert.deepEqual(d.lines.map((l) => l.name).sort(), ['Bread', 'Cucumbers', 'Milk', 'Tomatoes']);
  assert.equal(d.lines.find((l) => l.name === 'Milk').lineTotal, 7.9);
  assert.equal(d.lines.find((l) => l.name === 'Cucumbers').quantity, 2);
  const bank = (await call('GET', `/api/households/${hid}/items`, undefined, admin.cookie)).body.items;
  assert.equal(bank.find((i) => i.name === 'Tomatoes').price, 9.8); // "last paid" learned from the receipt

  // deleting removes the file; OCR failures are reported, not thrown
  const file = fs.readdirSync(path.join(dataDir, 'receipts', String(hid)))[0];
  assert.ok(file);
  await call('DELETE', `/api/receipts/${r.body.id}`, undefined, admin.cookie);
  assert.equal(fs.readdirSync(path.join(dataDir, 'receipts', String(hid))).length, 0);
  await app.close();
});

test('OCR can be switched off by the admin; failures surface as a status', async () => {
  const ocrRun = { tesseract: async () => { throw new Error('tesseract_not_installed'); }, cloud: async () => ({}) };
  const { app, call, admin, trip } = await boot(ocrRun);
  const f = await trip([['Milk', 1]]);
  const r = await call('POST', `/api/trips/${f.tripId}/receipts`, JPEG, admin.cookie, { 'content-type': 'image/jpeg' });
  await app.ocr.idle();
  const v = (await call('GET', `/api/receipts/${r.body.id}`, undefined, admin.cookie)).body;
  assert.deepEqual([v.ocrStatus, v.ocrError], ['failed', 'tesseract_not_installed']);
  await call('PUT', '/api/admin/settings', { ocr_enabled: false }, admin.cookie);
  assert.equal((await call('POST', `/api/receipts/${r.body.id}/scan`, {}, admin.cookie)).body.error, 'ocr_disabled');
  const r2 = await call('POST', `/api/trips/${f.tripId}/receipts`, JPEG, admin.cookie, { 'content-type': 'image/jpeg' });
  assert.equal(r2.body.ocrStatus, 'none'); // photo still saved
  await app.close();
});

test('cloud OCR is used only with the user\'s own key, which is stored encrypted and never returned', async () => {
  const seen = [];
  const ocrRun = {
    tesseract: async () => 'Milk 7.90\nTOTAL 7.90',
    cloud: async (a) => { seen.push(a); return { store: 'S', date: null, currency: 'ILS', total: 7.9, lines: [{ name: 'Milk', quantity: 1, unitPrice: 7.9, lineTotal: 7.9 }] }; },
  };
  const { app, call, admin, trip } = await boot(ocrRun);
  const f = await trip([['Milk', 1]]);
  const up = () => call('POST', `/api/trips/${f.tripId}/receipts`, JPEG, admin.cookie, { 'content-type': 'image/jpeg' });

  await up(); await app.ocr.idle();
  assert.equal(seen.length, 0); // no key: local engine

  const put = await call('PUT', '/api/me/ocr', { engine: 'auto', provider: 'openai', model: 'gpt-x', apiKey: 'sk-SECRET-123' }, admin.cookie);
  assert.equal(put.body.user.ocr.hasKey, true);
  assert.ok(!put.text.includes('SECRET'));
  const stored = app.db.prepare('SELECT api_key_enc FROM user_ocr').get().api_key_enc;
  assert.ok(stored && !stored.includes('SECRET')); // ciphertext at rest
  assert.equal(app.secrets.decrypt(stored), 'sk-SECRET-123');

  const r = await up(); await app.ocr.idle();
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].provider, seen[0].apiKey, seen[0].model], ['openai', 'sk-SECRET-123', 'gpt-x']);
  assert.equal((await call('GET', `/api/receipts/${r.body.id}`, undefined, admin.cookie)).body.result.engine, 'cloud');

  await call('PUT', '/api/me/ocr', { engine: 'local' }, admin.cookie); // explicit local wins over a saved key
  await up(); await app.ocr.idle();
  assert.equal(seen.length, 1);
  await call('PUT', '/api/me/ocr', { apiKey: '' }, admin.cookie);   // removing the key
  assert.equal((await call('GET', '/api/me', undefined, admin.cookie)).body.user.ocr.hasKey, false);
  assert.equal((await call('PUT', '/api/me/ocr', { provider: 'nope' }, admin.cookie)).status, 400);
  await app.close();
});

test('currency is a personal setting', async () => {
  const { app, call, admin } = await boot();
  assert.equal((await call('GET', '/api/me', undefined, admin.cookie)).body.user.currency, null);
  assert.equal((await call('PATCH', '/api/me', { currency: 'ILS' }, admin.cookie)).body.user.currency, 'ILS');
  assert.equal((await call('PATCH', '/api/me', { currency: 'shekel' }, admin.cookie)).status, 400);
  assert.equal((await call('PATCH', '/api/me', { currency: null }, admin.cookie)).body.user.currency, null);
  await app.close();
});

test('purchase CSV: columns, date filter, one receipt total per trip, private lists stay private', async () => {
  const { app, call, admin, hid, lid, mkUser, trip } = await boot();
  const dana = await mkUser('dana');
  await trip([['Milk', 2], ['Bread', 1]], { total: 30, currency: 'ILS' });
  const priv = (await call('POST', '/api/lists', { householdId: hid, name: 'Gift', visibility: 'private' }, admin.cookie)).body.id;
  await trip([['Wrapping paper', 1]], { total: 12 }, admin.cookie, priv);

  const csv = await call('GET', `/api/households/${hid}/purchases.csv`, undefined, admin.cookie);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.ok(csv.text.startsWith('\uFEFFpurchased_at,household,list,store,item,category,quantity,unit_price,line_total,currency,buyer,trip_id,receipt_total'));
  const rows = csv.text.trim().split(/\r\n/).slice(1);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.endsWith(',30')).length, 1); // total printed once for the two-line trip, not twice
  assert.ok(csv.text.includes('Wrapping paper'));

  const danas = await call('GET', `/api/households/${hid}/purchases.csv`, undefined, dana.cookie);
  assert.ok(!danas.text.includes('Wrapping paper')); // private list purchases are not exported to non-members
  assert.ok(danas.text.includes('Milk'));
  const future = await call('GET', `/api/households/${hid}/purchases.csv?from=2999-01-01`, undefined, admin.cookie);
  assert.equal(future.text.trim().split(/\r\n/).length, 1); // header only
  const onlyGift = await call('GET', `/api/households/${hid}/purchases.csv?listId=${priv}`, undefined, admin.cookie);
  assert.ok(onlyGift.text.includes('Wrapping paper') && !onlyGift.text.includes('Milk'));
  assert.ok(lid);
  await app.close();
});
