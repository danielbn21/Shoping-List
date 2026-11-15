import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);

async function boot(ocrRun) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const opts = { dataDir, logger: false };
  if (ocrRun) opts.moduleOptions = { 'receipt-ocr': { run: ocrRun } }; else opts.bundledDir = false;
  const app = await buildApp(opts);
  const call = async (method, url, body, cookie, headers) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(headers || {}), ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, text: res.body, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const mkList = async (name) => (await call('POST', '/api/lists', { householdId: hid, name }, admin.cookie)).body.id;
  const past = (lid) => call('GET', `/api/households/${hid}/items?listId=${lid}`, undefined, admin.cookie).then((r) => r.body.items.map((i) => i.name).sort());
  const bank = () => call('GET', `/api/households/${hid}/items`, undefined, admin.cookie).then((r) => r.body.items.map((i) => i.name).sort());
  const onList = (lid) => call('GET', `/api/lists/${lid}`, undefined, admin.cookie).then((r) => (r.body.entries ?? []).map((e) => `${e.name ?? e.itemName}:${e.quantity}`).sort());
  const imp = (lid, csv, extra = {}) => call('POST', `/api/lists/${lid}/items/import`, { csv, ...extra }, admin.cookie);
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  return { app, call, admin, hid, mkList, mkUser, past, bank, onList, imp, dataDir };
}


const stores = async (t, ...names) => { const out = []; for (const n of names) out.push((await t.call('POST', `/api/households/${t.hid}/stores`, { name: n }, t.admin.cookie)).body.id); return out; };
const history = (t, lid, cookie = t.admin.cookie) => t.call('GET', `/api/lists/${lid}/history`, undefined, cookie).then((r) => r.body.trips);
const estimates = (t, lid, storeId) => t.call('GET', `/api/lists/${lid}/estimates${storeId ? `?storeId=${storeId}` : ''}`, undefined, t.admin.cookie).then((r) => r.body.prices);
const csv = (t) => t.call('GET', `/api/households/${t.hid}/purchases.csv`, undefined, t.admin.cookie).then((r) => r.text);
const itemId = async (t, name) => (await t.call('GET', `/api/households/${t.hid}/items`, undefined, t.admin.cookie)).body.items.find((i) => i.name === name)?.id;
const DAY = 864e5;

test('add a trip: store, date, total and lines; new items are created, existing ones reused, and all join the list\'s past items', async () => {
  const t = await boot();
  const a = await t.mkList('Food'), b = await t.mkList('Hardware');
  const [shuf] = await stores(t, 'Shufersal');
  await t.call('POST', `/api/lists/${b}/entries`, { name: 'Milk', quantity: 1 }, t.admin.cookie);      // an item that already exists (only in B)
  const at = Date.now() - 3 * DAY;
  const r = await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at, total: 30, currency: 'ILS', lines: [
    { name: 'Milk', quantity: 2, unitPrice: 7 },
    { name: 'Tahini', quantity: 1, lineTotal: 16 },
    { name: '', quantity: 1 },                                                                          // an empty form row is ignored
  ] }, t.admin.cookie);
  assert.equal(r.status, 200);
  const trips = await history(t, a);
  assert.equal(trips.length, 1);
  assert.deepEqual([trips[0].id, trips[0].total, trips[0].itemCount, trips[0].storeName, trips[0].currency, trips[0].finishedAt], [r.body.tripId, 30, 2, 'Shufersal', 'ILS', at]);
  assert.deepEqual(await t.past(a), ['Milk', 'Tahini']);                  // both are past items of A
  assert.deepEqual(await t.past(b), ['Milk']);                            // B is untouched
  assert.equal((await t.bank()).filter((n) => n === 'Milk').length, 1);   // the existing household item was reused
  const d = (await t.call('GET', `/api/trips/${r.body.tripId}`, undefined, t.admin.cookie)).body;
  const by = Object.fromEntries(d.lines.map((l) => [l.name, l]));
  assert.deepEqual([by.Milk.quantity, by.Milk.unitPrice, by.Milk.lineTotal], [2, 7, 14]);
  assert.deepEqual([by.Tahini.unitPrice, by.Tahini.lineTotal], [16, 16]);
  // it counts in the CSV, and as the item's saved ("last paid") price
  const text = await csv(t);
  assert.ok(text.includes('Tahini') && text.includes('Shufersal'));
  const item = (await t.call('GET', `/api/households/${t.hid}/items?listId=${a}`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Tahini');
  assert.equal(item.price, 16);
  await t.app.close();
});

test('an added trip counts in price estimates, per store, and a trip for an older date does not overwrite a newer saved price', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  const [shuf, rami] = await stores(t, 'Shufersal', 'Rami Levy');
  await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at: Date.now() - 2 * DAY, lines: [{ name: 'Eggs', quantity: 1, unitPrice: 14 }] }, t.admin.cookie);
  await t.call('POST', `/api/lists/${a}/trips`, { storeId: rami, at: Date.now() - 1 * DAY, lines: [{ name: 'Eggs', quantity: 1, unitPrice: 12 }] }, t.admin.cookie);
  await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at: Date.now() - 30 * DAY, lines: [{ name: 'Eggs', quantity: 1, unitPrice: 5 }] }, t.admin.cookie); // older than both
  await t.call('POST', `/api/lists/${a}/entries`, { name: 'Eggs', quantity: 1 }, t.admin.cookie);
  const eggs = await itemId(t, 'Eggs');
  assert.equal((await estimates(t, a, shuf))[eggs].unitPrice, 14);        // the newest at Shufersal, not the 30-day-old 5
  assert.equal((await estimates(t, a, rami))[eggs].unitPrice, 12);
  assert.equal((await estimates(t, a))[eggs].unitPrice, 12);               // anywhere: the newest overall
  const item = (await t.call('GET', `/api/households/${t.hid}/items?listId=${a}`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Eggs');
  assert.equal(item.price, 12);                                            // saved price follows the newest purchase, not the last entered
  await t.app.close();
});

test('add a trip: validation and permissions', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  const post = (body, cookie = t.admin.cookie, list = a) => t.call('POST', `/api/lists/${list}/trips`, body, cookie);
  assert.equal((await post({})).body.error, 'empty_trip');                                                 // nothing to record
  assert.equal((await post({ total: 5 })).status, 200);                                                    // a total alone is fine
  assert.equal((await post({ total: 5, at: 'not a date' })).body.error, 'invalid_date');
  assert.equal((await post({ total: 5, at: Date.now() + 10 * DAY })).body.error, 'invalid_date');          // not in the future
  assert.equal((await post({ total: -1 })).body.error, 'invalid_total');
  assert.equal((await post({ lines: [{ name: 'Milk', quantity: 0 }] })).body.error, 'invalid_quantity');
  assert.equal((await post({ lines: [{ name: 'Milk', unitPrice: 'x' }] })).body.error, 'invalid_price');
  assert.equal((await post({ total: 5, storeId: 99999 })).body.error, 'store_not_found');
  assert.equal((await t.past(a)).length, 0);                                                               // nothing was created by the failed attempts
  const dana = await t.mkUser('dana');
  await t.call('PUT', `/api/lists/${a}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  assert.equal((await post({ total: 5 }, dana.cookie)).status, 403);                                       // a Shopper may not add trips
  const eve = await t.mkUser('eve');
  await t.call('PUT', `/api/lists/${a}/members/${eve.id}`, { role: 'contributor' }, t.admin.cookie);
  assert.equal((await post({ total: 5 }, eve.cookie)).status, 200);                                        // an Editor may
  const priv = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Mine', visibility: 'private' }, eve.cookie)).body.id;
  assert.equal((await post({ total: 5 }, t.admin.cookie, priv)).status, 404);                              // not a member of a private list
  await t.app.close();
});

test('edit a trip: the date and the store move the purchase lines too, so estimates and the CSV follow', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  const [shuf, rami] = await stores(t, 'Shufersal', 'Rami Levy');
  const r = await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at: Date.now() - 5 * DAY, lines: [{ name: 'Eggs', quantity: 1, unitPrice: 14 }] }, t.admin.cookie);
  await t.call('POST', `/api/lists/${a}/entries`, { name: 'Eggs', quantity: 1 }, t.admin.cookie);
  const eggs = await itemId(t, 'Eggs');
  assert.equal((await estimates(t, a, shuf))[eggs].source, 'store');       // a purchase at Shufersal
  assert.equal((await estimates(t, a, rami))[eggs].source, 'item');        // nothing at Rami Levy: only the saved price
  const when = Date.now() - 9 * DAY;
  assert.equal((await t.call('PATCH', `/api/trips/${r.body.tripId}`, { storeId: rami, finishedAt: when, total: 20 }, t.admin.cookie)).status, 200);
  assert.equal((await estimates(t, a, shuf))[eggs].source, 'item');        // moved away from Shufersal
  assert.equal((await estimates(t, a, rami))[eggs].source, 'store');       // and to Rami Levy
  assert.equal((await estimates(t, a, rami))[eggs].at, when);              // at the new time
  const [trip] = await history(t, a);
  assert.deepEqual([trip.total, trip.storeName, trip.finishedAt], [20, 'Rami Levy', when]);
  assert.ok((await csv(t)).includes('Rami Levy'));
  assert.equal((await t.call('PATCH', `/api/trips/${r.body.tripId}`, { finishedAt: 'garbage' }, t.admin.cookie)).body.error, 'invalid_date');
  await t.app.close();
});

test('delete a trip: lines, receipt photos and files go, nothing is restored to the list, and nothing keeps counting', async () => {
  const ocrRun = { tesseract: async () => fs.readFileSync(new URL('./fixtures/receipt_en.txt', import.meta.url), 'utf8'), cloud: async () => { throw new Error('no cloud'); } };
  const t = await boot(ocrRun);
  const a = await t.mkList('Food');
  const [shuf] = await stores(t, 'Shufersal');
  const keep = await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at: Date.now() - 4 * DAY, lines: [{ name: 'Rice', quantity: 1, unitPrice: 9 }] }, t.admin.cookie);
  const gone = await t.call('POST', `/api/lists/${a}/trips`, { storeId: shuf, at: Date.now() - 1 * DAY, total: 40, lines: [{ name: 'Eggs', quantity: 1, unitPrice: 14 }, { name: 'Bread', quantity: 2, unitPrice: 6 }] }, t.admin.cookie);
  for (let i = 0; i < 2; i++) await t.call('POST', `/api/trips/${gone.body.tripId}/receipts`, JPEG, t.admin.cookie, { 'content-type': 'image/jpeg' });
  await t.app.receipts.idle();
  const dir = path.join(t.dataDir, 'receipts', String(t.hid));
  assert.equal(fs.readdirSync(dir).length, 2);
  await t.call('POST', `/api/lists/${a}/entries`, { name: 'Eggs', quantity: 1 }, t.admin.cookie);        // eggs are on the list again
  const eggs = await itemId(t, 'Eggs');
  assert.equal((await estimates(t, a))[eggs].unitPrice, 14);

  const del = await t.call('DELETE', `/api/trips/${gone.body.tripId}`, undefined, t.admin.cookie);
  assert.deepEqual([del.status, del.body.lines, del.body.receipts], [200, 2, 2]);
  assert.deepEqual((await history(t, a)).map((x) => x.id), [keep.body.tripId]);                        // gone from history
  assert.equal((await t.call('GET', `/api/trips/${gone.body.tripId}`, undefined, t.admin.cookie)).status, 404);
  const text = await csv(t);
  assert.ok(!text.includes('Eggs') && !text.includes('Bread') && text.includes('Rice'));                // gone from the CSV, the other trip stays
  assert.equal((await estimates(t, a))[eggs].source, 'item');                                           // no estimate from a purchase any more; the saved price is left as it was (owner's decision)
  assert.equal((await estimates(t, a))[eggs].unitPrice, 14);
  assert.equal(fs.readdirSync(dir).length, 0);                                                          // receipt files removed
  assert.equal(t.app.db.prepare('SELECT COUNT(*) c FROM purchase_events WHERE trip_id IS NULL').get().c, 0);   // no orphaned lines
  assert.equal(t.app.db.prepare('SELECT COUNT(*) c FROM receipts').get().c, 0);
  assert.deepEqual(await t.past(a), ['Bread', 'Eggs', 'Rice']);                                         // items stay past items
  const open = JSON.stringify((await t.call('GET', `/api/lists/${a}`, undefined, t.admin.cookie)).body);
  assert.ok(!open.includes('Bread'));                                                                   // Bread was NOT restored to the list
  assert.equal(t.app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'trip.deleted'").get().c, 1);
  await t.app.close();
});

test('delete a trip: permissions, and a trip that is not found', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  const mk = () => t.call('POST', `/api/lists/${a}/trips`, { total: 10 }, t.admin.cookie).then((r) => r.body.tripId);
  const id = await mk();
  const dana = await t.mkUser('dana'), eve = await t.mkUser('eve');
  await t.call('PUT', `/api/lists/${a}/members/${dana.id}`, { role: 'viewer' }, t.admin.cookie);
  await t.call('PUT', `/api/lists/${a}/members/${eve.id}`, { role: 'contributor' }, t.admin.cookie);
  assert.equal((await t.call('DELETE', `/api/trips/${id}`, undefined, dana.cookie)).status, 403);        // Shopper
  assert.equal((await history(t, a)).length, 1);
  assert.equal((await t.call('DELETE', `/api/trips/${id}`, undefined, eve.cookie)).status, 200);          // Editor
  assert.equal((await t.call('DELETE', `/api/trips/${id}`, undefined, t.admin.cookie)).status, 404);      // already gone
  const priv = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Mine', visibility: 'private' }, eve.cookie)).body.id;
  const pid = (await t.call('POST', `/api/lists/${priv}/trips`, { total: 3 }, eve.cookie)).body.tripId;
  assert.equal((await t.call('DELETE', `/api/trips/${pid}`, undefined, t.admin.cookie)).status, 404);    // private list: invisible to others
  await t.app.close();
});
