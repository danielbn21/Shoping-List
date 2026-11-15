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
  return { app, call, admin, hid, mkList, past, bank, onList, imp, dataDir };
}

const PAST_CSV = 'name,category,quantity\nMilk,Dairy,0\nHammer,Tools,0\nNails,Tools,0\nBread,Bakery,2\n';

test('importing a past-items style CSV links every row to the list it was imported into, whatever its quantity', async () => {
  const t = await boot();
  const a = await t.mkList('Food'), b = await t.mkList('Hardware');
  const r = await t.imp(a, PAST_CSV, { apply: true });
  assert.equal(r.status, 200);
  assert.deepEqual(await t.past(a), ['Bread', 'Hammer', 'Milk', 'Nails']);   // all four, quantity 0 included
  assert.deepEqual(await t.past(b), []);                                       // the other list is untouched
  assert.deepEqual(await t.bank(), ['Bread', 'Hammer', 'Milk', 'Nails']);      // the household bank has them all
  const entries = (await t.call('GET', `/api/lists/${a}`, undefined, t.admin.cookie)).body;
  const open = JSON.stringify(entries);
  assert.ok(open.includes('Bread'));                                           // quantity 2 is also on the list
  assert.ok(!open.includes('Hammer'));                                         // quantity 0 is not
  await t.app.close();
});

test('importing the same names again keeps one link each and no duplicates', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  await t.imp(a, PAST_CSV, { apply: true });
  const again = await t.imp(a, PAST_CSV, { apply: true });
  assert.equal(again.status, 200);
  assert.deepEqual(await t.past(a), ['Bread', 'Hammer', 'Milk', 'Nails']);
  assert.deepEqual(await t.bank(), ['Bread', 'Hammer', 'Milk', 'Nails']);
  const n = (await t.call('GET', `/api/households/${t.hid}/items`, undefined, t.admin.cookie)).body.items.length;
  assert.equal(n, 4);
  await t.app.close();
});

test('an item that already exists through another list joins this list on import and stays in the other', async () => {
  const t = await boot();
  const a = await t.mkList('Food'), b = await t.mkList('Hardware');
  await t.call('POST', `/api/lists/${b}/entries`, { name: 'Milk', quantity: 1 }, t.admin.cookie);
  assert.deepEqual(await t.past(a), []);
  await t.imp(a, 'name,quantity\nMilk,0\n', { apply: true });
  assert.deepEqual(await t.past(a), ['Milk']);
  assert.deepEqual(await t.past(b), ['Milk']);
  assert.deepEqual(await t.bank(), ['Milk']);                                  // still one household item
  await t.app.close();
});

test('the preview (apply: false) changes nothing', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  const r = await t.imp(a, PAST_CSV);
  assert.equal(r.body.applied, false);
  assert.equal(r.body.summary.create, 4);
  assert.deepEqual(await t.past(a), []);
  assert.deepEqual(await t.bank(), []);
  await t.app.close();
});

test('rows skipped as duplicates inside the file are not linked on their own', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  await t.imp(a, 'name,quantity\nMilk,0\nmilk,0\n,0\n', { apply: true });
  assert.deepEqual(await t.past(a), ['Milk']);
  await t.app.close();
});

test('removing past items still works, and an import afterwards links them again', async () => {
  const t = await boot();
  const a = await t.mkList('Food');
  await t.imp(a, PAST_CSV, { apply: true });
  const items = (await t.call('GET', `/api/households/${t.hid}/items?listId=${a}`, undefined, t.admin.cookie)).body.items;
  const ids = items.filter((i) => ['Hammer', 'Nails'].includes(i.name)).map((i) => i.id);
  const rm = await t.call('POST', `/api/lists/${a}/past-items/remove`, { itemIds: ids }, t.admin.cookie);
  assert.equal(rm.status, 200);
  assert.deepEqual(await t.past(a), ['Bread', 'Milk']);
  await t.imp(a, PAST_CSV, { apply: true });
  assert.deepEqual(await t.past(a), ['Bread', 'Hammer', 'Milk', 'Nails']);
  await t.app.close();
});

test('receipt review: a new item and an existing item bought on a trip of list A join A\'s past items, not B\'s', async () => {
  const ocrRun = { tesseract: async () => fs.readFileSync(new URL('./fixtures/receipt_en.txt', import.meta.url), 'utf8'), cloud: async () => { throw new Error('should not run'); } };
  const t = await boot(ocrRun);
  const a = await t.mkList('Food'), b = await t.mkList('Hardware');
  await t.call('POST', `/api/lists/${b}/entries`, { name: 'Tomatoes', quantity: 1 }, t.admin.cookie);   // existing household item, only in B
  for (const name of ['Milk', 'Bread']) {
    const e = await t.call('POST', `/api/lists/${a}/entries`, { name, quantity: 1 }, t.admin.cookie);
    await t.call('POST', `/api/entries/${e.body.entryId}/check`, { checked: true }, t.admin.cookie);
  }
  const f = (await t.call('POST', `/api/lists/${a}/finish`, {}, t.admin.cookie)).body;
  const r = await t.call('POST', `/api/trips/${f.tripId}/receipts`, JPEG, t.admin.cookie, { 'content-type': 'image/jpeg' });
  await t.app.receipts.idle();
  const rv = (await t.call('GET', `/api/receipts/${r.body.id}`, undefined, t.admin.cookie)).body;
  const lines = rv.result.lines.map((l) => ({ ...l, ...(l.match ?? {}), include: true }));
  const tom = lines.find((l) => l.name === 'Tomatoes');
  tom.itemId = (await t.call('GET', `/api/households/${t.hid}/items`, undefined, t.admin.cookie)).body.items.find((i) => i.name === 'Tomatoes').id; // reuse the existing item
  const ap = await t.call('POST', `/api/receipts/${r.body.id}/apply`, { lines, total: rv.result.total }, t.admin.cookie);
  assert.equal(ap.status, 200);
  const pa = await t.past(a), pb = await t.past(b);
  assert.ok(pa.includes('Tomatoes'));                                          // existing item reused, now also A's
  assert.ok(pa.includes('Cucumbers'));                                         // brand-new item created from the receipt
  assert.deepEqual(pb, ['Tomatoes']);                                          // B gained nothing new
  await t.app.close();
});

test('the import preview counts how many items will become new past items of this list', async () => {
  const t = await boot();
  const a = await t.mkList('Food'), b = await t.mkList('Hardware');
  await t.call('POST', `/api/lists/${b}/entries`, { name: 'Milk', quantity: 1 }, t.admin.cookie);   // known to the household, past item of B only
  await t.imp(a, 'name,quantity\nRice,0\n', { apply: true });                                       // already a past item of A
  const r = await t.imp(a, 'name,quantity\nRice,0\nMilk,0\nTahini,0\nTahini,0\n');
  assert.equal(r.body.applied, false);
  assert.equal(r.body.summary.pastItems, 2);                                                         // Milk (new to A) and Tahini; Rice already is, the repeated Tahini is one
  assert.deepEqual(await t.past(a), ['Rice']);                                                       // the preview changed nothing
  await t.app.close();
});
