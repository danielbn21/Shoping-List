import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { parseCsv, toCsv } from '../src/csv.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
async function boot() {
  const app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* csv */ }
    return { status: res.statusCode, body: json, text: res.body, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const list = async (name, h = hid) => (await call('POST', '/api/lists', { householdId: h, name }, admin.cookie)).body.id;
  return { app, call, admin, hid, list };
}

test('csv reader and writer: quotes, delimiters, BOM, Hebrew, formula guard', () => {
  assert.deepEqual(parseCsv('\uFEFFname;price\r\n"Milk, 3%";7,9\r\nחלב;5\r\n'), [['name', 'price'], ['Milk, 3%', '7,9'], ['חלב', '5']]);
  assert.deepEqual(parseCsv('a\tb\n1\t"x ""y"" z"\n'), [['a', 'b'], ['1', 'x "y" z']]);
  const out = toCsv([['name'], ['=HYPERLINK("http://evil")'], ['-5'], ['a,b'], ['חלב']]);
  assert.ok(out.startsWith('\uFEFF'));
  assert.ok(out.includes("'=HYPERLINK")); // would otherwise run as a formula in Excel
  assert.ok(out.includes('\r\n-5\r\n'));  // plain negative numbers are left alone
  assert.deepEqual(parseCsv(out).map((r) => r[0]), ['name', "'=HYPERLINK(\"http://evil\")", '-5', 'a,b', 'חלב']);
});

test('item bank export, then import into another list: preview, apply, quantities carried over', async () => {
  const { app, call, admin, hid, list } = await boot();
  const a = await list('A'), b = await list('B');
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  const dairy = cats.find((c) => c.nameEn === 'Dairy & eggs');
  const m = await call('POST', `/api/lists/${a}/entries`, { name: 'Milk', quantity: 3, categoryId: dairy.id, note: 'lactose free' }, admin.cookie);
  await call('PATCH', `/api/items/${m.body.itemId}`, { price: 7.9, defaultNote: 'lactose free' }, admin.cookie); // the item's default note, not the entry's note
  await call('POST', `/api/lists/${a}/entries`, { name: '=SUM(1+1)', quantity: 1 }, admin.cookie);
  await call('POST', `/api/lists/${a}/entries`, { name: 'חלב עיזים', quantity: 2 }, admin.cookie);

  const exp = await call('GET', `/api/lists/${a}/items.csv`, undefined, admin.cookie);
  assert.ok(exp.text.startsWith('\uFEFFname,category,default_note,price,quantity,times_purchased,last_purchased'));
  assert.ok(exp.text.includes('Milk,Dairy & eggs,lactose free,7.9,3,0,'));
  assert.ok(exp.text.includes("'=SUM(1+1)"));

  // a second household has none of these items: import there
  const h2 = (await call('POST', '/api/households', { name: 'Cabin' }, admin.cookie)).body.id;
  const c = await list('C', h2);
  const prev = await call('POST', `/api/lists/${c}/items/import`, { csv: exp.text }, admin.cookie);
  assert.equal(prev.body.applied, false);
  assert.deepEqual([prev.body.summary.create, prev.body.summary.update, prev.body.summary.addToList], [3, 0, 3]);
  assert.equal((await call('GET', `/api/households/${h2}/items`, undefined, admin.cookie)).body.items.length, 0); // preview changes nothing

  const done = await call('POST', `/api/lists/${c}/items/import`, { csv: exp.text, apply: true }, admin.cookie);
  assert.equal(done.body.applied, true);
  const view = (await call('GET', `/api/lists/${c}`, undefined, admin.cookie)).body;
  assert.equal(view.entries.find((e) => e.name === 'Milk').quantity, 3);
  assert.equal(view.entries.find((e) => e.name === '=SUM(1+1)').quantity, 1); // apostrophe guard removed on the way back in
  assert.equal(view.entries.find((e) => e.name === 'חלב עיזים').quantity, 2);
  const milk = (await call('GET', `/api/households/${h2}/items`, undefined, admin.cookie)).body.items.find((i) => i.name === 'Milk');
  assert.deepEqual([milk.price, milk.defaultNote], [7.9, 'lactose free']);
  assert.ok(view.categories.some((x) => x.nameEn === 'Dairy & eggs')); // the new household has the default categories, so it matched
  assert.equal(view.entries.find((e) => e.name === 'Milk').categoryId !== null, true);

  // importing the same file again restores into the same household list: no duplicates, quantities add up
  await call('POST', `/api/lists/${c}/items/import`, { csv: exp.text, apply: true }, admin.cookie);
  assert.equal((await call('GET', `/api/households/${h2}/items`, undefined, admin.cookie)).body.items.length, 3);
  assert.equal((await call('GET', `/api/lists/${c}`, undefined, admin.cookie)).body.entries.find((e) => e.name === 'Milk').quantity, 6);
  assert.ok(b);
  await app.close();
});

test('import: fill-only vs overwrite, similar names, new categories, repeated names, bad rows', async () => {
  const { app, call, admin, hid, list } = await boot();
  const l = await list('L');
  const first = await call('POST', `/api/lists/${l}/entries`, { name: 'Rice' }, admin.cookie);
  await call('PATCH', `/api/items/${first.body.itemId}`, { price: 10, defaultNote: 'basmati' }, admin.cookie);
  const csv = [
    'name;category;default_note;price;quantity',
    'rice;Pantry;jasmine;12,5;1',     // same item (case): existing note and price are kept unless overwrite
    'Rise;;;;0',                      // typo of Rice: flagged, created new unless "merge similar"
    'Tahini;Spreads;;9;2',            // category that does not exist yet
    'tahini;;;;5',                    // repeated in the file: ignored
    ';;;;',                           // no name
    'Salt;;;abc;x',                   // bad numbers: warned, row still imported
  ].join('\r\n');
  const p = (extra = {}) => call('POST', `/api/lists/${l}/items/import`, { csv, ...extra }, admin.cookie);

  const prev = (await p()).body;
  assert.deepEqual([prev.summary.create, prev.summary.update, prev.summary.skip, prev.summary.duplicateInFile, prev.summary.similar, prev.summary.newCategories], [3, 1, 1, 1, 1, 1]);
  const rise = prev.rows.find((r) => r.name === 'Rise');
  assert.equal(rise.similarTo, 'Rice');
  assert.deepEqual(prev.rows.find((r) => r.name === 'Salt').warnings, ['bad_price', 'bad_quantity']);

  await p({ apply: true });
  let rice = (await call('GET', `/api/households/${hid}/items?q=rice`, undefined, admin.cookie)).body.items.find((i) => i.name === 'Rice');
  assert.deepEqual([rice.price, rice.defaultNote], [10, 'basmati']); // kept
  const cats = (await call('GET', `/api/households/${hid}/categories`, undefined, admin.cookie)).body.categories;
  assert.ok(cats.some((c) => c.nameEn === 'Spreads')); // created from the file
  await p({ apply: true, overwrite: true });
  rice = (await call('GET', `/api/households/${hid}/items?q=rice`, undefined, admin.cookie)).body.items.find((i) => i.name === 'Rice');
  assert.deepEqual([rice.price, rice.defaultNote], [12.5, 'jasmine']); // replaced

  assert.equal((await call('POST', `/api/lists/${l}/items/import`, { csv: 'foo,bar\n1,2' }, admin.cookie)).body.error, 'csv_no_name_column');
  assert.equal((await call('POST', `/api/lists/${l}/items/import`, { csv: 'name' }, admin.cookie)).body.error, 'csv_empty');
  await app.close();
});

test('only editors may export or import; Shoppers may not', async () => {
  const { app, call, admin, hid, list } = await boot();
  const l = await list('L');
  const r = await call('POST', '/api/admin/users', { name: 'Dana', username: 'dana', householdId: hid }, admin.cookie);
  const login = await call('POST', '/api/auth/login', { login: 'dana', password: r.body.oneTimePassword });
  await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
  await call('PUT', `/api/lists/${l}/members/${r.body.id}`, { role: 'viewer' }, admin.cookie);
  assert.equal((await call('GET', `/api/lists/${l}/items.csv`, undefined, login.cookie)).status, 403);
  assert.equal((await call('POST', `/api/lists/${l}/items/import`, { csv: 'name\nX', apply: true }, login.cookie)).status, 403);
  await app.close();
});
