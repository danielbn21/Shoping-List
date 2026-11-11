import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildApp } from '../../../server/src/app.js';
import { startFakePortals, replaceFull, gzipXml } from './fakePortals.js';
import { decodeXmlBytes } from '../server/portals/decode.js';
import { parsePriceXml, stampToMs } from '../server/prices.js';
import { packOf } from '../server/matching.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portal');
const fixture = (n) => parsePriceXml(decodeXmlBytes(fs.readFileSync(path.join(FIX, n))));
const SHUFERSAL = 'PriceFull7290027600007-001-017-20261107-030000.gz', STOP = 'PriceFull7290639000004-001-002-20261107-010011.gz';
const RAMI = 'PriceFull7290058140886-001-001-20261107-001000.gz', CARREFOUR = 'PriceFull7290055700007-001-981-20261107-051011.gz';
const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const M = '/api/m/price-compare';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A PriceFull file made on the spot: items = [{ code, name, price, weighted?, unit?, qty?, unitQty?, type? }]
const priceXml = (storeId, items) => `<Root><ChainID>7290639000004</ChainID><SubChainID>1</SubChainID><StoreID>${storeId}</StoreID><Items>${items.map((i) =>
  `<Item><PriceUpdateTime>2026-11-07T06:00:00</PriceUpdateTime><ItemCode>${i.code}</ItemCode><ItemType>${i.type ?? 1}</ItemType><ItemName>${i.name}</ItemName><ManufactureName>${i.brand ?? ''}</ManufactureName>` +
  `<UnitQty>${i.unitQty ?? 'גרם'}</UnitQty><Quantity>${i.qty ?? 500}</Quantity><UnitOfMeasure>100 גרם</UnitOfMeasure><bIsWeighted>${i.weighted ? 1 : 0}</bIsWeighted><ItemPrice>${i.price}</ItemPrice><UnitOfMeasurePrice>${(i.price / 5).toFixed(2)}</UnitOfMeasurePrice></Item>`).join('')}</Items></Root>`;

let svc;
async function boot() {
  const fake = await startFakePortals();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, moduleOptions: { 'price-compare': { baseUrls: { shufersal: fake.urls.shufersal, shared: fake.urls.shared, carrefour: fake.urls.carrefour }, citiesUrl: fake.urls.cities, delayMs: 0, expose: (x) => { svc = x; } } } });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const lid = (await call('POST', '/api/lists', { householdId: hid, name: 'Groceries' }, admin.cookie)).body.id;
  const mkUser = async (username, role) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    if (role) await call('PUT', `/api/lists/${lid}/members/${r.body.id}`, { role }, admin.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  const waitJob = async () => { for (let i = 0; i < 400 && (svc.prices.status()?.running || svc.dir.status()?.running); i++) await sleep(25); };
  await call('GET', `${M}/portals/cities`, undefined, admin.cookie); await waitJob(); // the branch directory
  const select = async (...branches) => { const r = await call('PUT', `${M}/lists/${lid}/stores`, { selection: branches.map(([chain, branchId]) => ({ chain, branchId })) }, admin.cookie); assert.equal(r.status, 200, JSON.stringify(r.body)); await waitJob(); return r; };
  const want = async (name, quantity = 1) => { await call('POST', `/api/lists/${lid}/entries`, { name, quantity }, admin.cookie); return app.db.prepare('SELECT id FROM items WHERE name = ?').get(name).id; };
  const compare = (cookie = admin.cookie) => call('GET', `${M}/lists/${lid}/compare`, undefined, cookie).then((r) => r.body);
  const mdb = () => app.modules.loaded.get('price-compare').db;
  const close = async () => { await waitJob(); await app.close(); await fake.close(); };
  return { app, fake, call, admin, hid, lid, mkUser, waitJob, select, want, compare, mdb, close };
}

/* ---------- reading price files ---------- */

test('real price files: usable rows, deposits dropped, units and pack sizes understood in all four chains', () => {
  for (const f of [SHUFERSAL, STOP, RAMI, CARREFOUR]) {
    const { items } = fixture(f);
    assert.ok(items.length > 60, f);
    assert.ok(items.every((i) => i.code && i.name && i.price > 0));
    assert.ok(items.some((i) => i.packAmount && i.packUnit));
  }
  const stop = fixture(STOP).items;
  const milk = stop.find((i) => i.code === '7290110563462');
  assert.deepEqual([milk.price, milk.unitPrice, milk.unit, milk.unitPer, milk.packAmount, milk.packUnit, milk.itemType, milk.weighted], [10.3, 10.3, 'l', 1, 1000, 'ml', 1, 0]);
  assert.ok(stop.some((i) => i.weighted === 1));
  assert.ok(fixture(CARREFOUR).items.some((i) => i.itemType === 0));      // the chain's own short codes
  const xml = priceXml(1, [{ code: '1', name: 'חלב', price: 6 }, { code: '2', name: 'פיקדון בקבוק חוזר', price: 0.3 }, { code: '3', name: 'חינם', price: 0 }, { code: '', name: 'ללא קוד', price: 5 }, { code: '4', name: 'נקי', price: 'abc' }]);
  assert.deepEqual(parsePriceXml(xml).items.map((i) => i.code), ['1']);
  assert.equal(stampToMs('20261107030000'), Date.UTC(2026, 10, 7, 3, 0, 0));
  assert.equal(stampToMs('nope'), null);
  assert.deepEqual(packOf(1, 'ליטר'), { amount: 1000, unit: 'ml' });
});

/* ---------- fetching and merging ---------- */

test('choosing branches reads their files in the background; prices are merged and a repeat does not download again', async () => {
  const t = await boot();
  const r = await t.select(['stop_market', '2'], ['shufersal', '17']);
  assert.deepEqual(r.body.selection.map((s) => `${s.chain}:${s.branchId}`), ['stop_market:', 'stop_market:2', 'shufersal:', 'shufersal:17']);
  const n = (chain, store) => t.mdb().prepare('SELECT COUNT(*) c FROM branch_prices WHERE chain = ? AND store_id = ?').get(chain, store).c;
  assert.equal(n('stop_market', '2'), fixture(STOP).items.length);
  assert.equal(n('shufersal', '17'), fixture(SHUFERSAL).items.length);
  const st = svc.prices.stateOf('stop_market', '2');
  assert.deepEqual([st.file, st.file_stamp, st.items, st.error], [STOP, '20261107010011', fixture(STOP).items.length, null]);
  assert.ok(st.checked_at && st.updated_at);

  const downloads = () => t.fake.state.log.filter((l) => l.includes('PriceFull')).length;
  const before = downloads();
  assert.equal((await t.call('POST', `${M}/lists/${t.lid}/prices/refresh`, {}, t.admin.cookie)).body.reason, 'recent'); // just read: left alone
  t.mdb().prepare('UPDATE branch_price_state SET checked_at = checked_at - 3600000').run();
  assert.equal((await t.call('POST', `${M}/lists/${t.lid}/prices/refresh`, {}, t.admin.cookie)).body.started, true);
  await t.waitJob();
  assert.ok(svc.prices.status().results.every((x) => x.ok && x.skipped === 'same_file')); // the newest file is the one already held
  assert.equal(t.fake.state.log.filter((l) => /\/file\/d\/PriceFull|files\/PriceFull/.test(l)).length, 2); // downloaded once per branch, not again
  assert.ok(downloads() >= before);

  const c = await t.compare();
  assert.deepEqual([c.prices.running, c.prices.refreshHours, c.prices.oldAfterDays], [false, 24, 60]);
  assert.equal(c.results.length, 2);                                      // one row per chosen branch
  assert.ok(c.results.every((x) => x.hasData && x.asOf && x.of === 0));
  await t.close();
});

test('a newer file updates prices; an item missing from it keeps its price; a truncated file is refused; old prices are flagged', async () => {
  const t = await boot();
  const base = Array.from({ length: 260 }, (_, i) => ({ code: String(7290000000000 + i), name: `מוצר ${i}`, price: 10 + (i % 7) }));
  let restore = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261107-010011.gz', gzipXml(priceXml(2, base)));
  try {
    await t.select(['stop_market', '2']);
    const row = (code) => t.mdb().prepare('SELECT price, seen_file FROM branch_prices WHERE chain = ? AND store_id = ? AND code = ?').get('stop_market', '2', code);
    const age = () => t.mdb().prepare('UPDATE branch_price_state SET checked_at = checked_at - 3600000').run();
    assert.equal(svc.prices.stateOf('stop_market', '2').items, 260);

    // a newer file: one price changed, one item gone, one new item
    restore(); restore = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261108-010011.gz', gzipXml(priceXml(2, [...base.slice(1).map((i, k) => (k === 0 ? { ...i, price: 99 } : i)), { code: '7299999999999', name: 'חדש', price: 5 }])));
    age(); await t.call('POST', `${M}/lists/${t.lid}/prices/refresh`, {}, t.admin.cookie); await t.waitJob();
    assert.equal(row('7290000000001').price, 99);                                   // updated
    assert.deepEqual(row('7290000000000'), { price: 10, seen_file: '20261107010011' }); // gone from the new file: keeps its price and its old stamp
    assert.equal(row('7299999999999').seen_file, '20261108010011');
    assert.equal(svc.prices.stateOf('stop_market', '2').file_stamp, '20261108010011');

    // a truncated download does not replace anything and is recorded
    restore(); restore = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261109-010011.gz', gzipXml(priceXml(2, base.slice(0, 20))));
    age(); await t.call('POST', `${M}/lists/${t.lid}/prices/refresh`, {}, t.admin.cookie); await t.waitJob();
    assert.equal(svc.prices.stateOf('stop_market', '2').error, 'incomplete_file');
    assert.equal(svc.prices.stateOf('stop_market', '2').file_stamp, '20261108010011');
    assert.equal(row('7290000000001').price, 99);
    assert.equal((await t.compare()).results[0].error, 'incomplete_file');
    assert.equal(svc.prices.due('stop_market', '2'), false); // a failed branch is not retried within the hour

    // an item whose price no file has mentioned for over 60 days is flagged old, never dropped
    const id = await t.want('מוצר 0');
    await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: '7290000000000' }, t.admin.cookie);
    let line = (await t.compare()).results[0].lines[0];
    assert.deepEqual([line.via, line.lineTotal, line.old], ['confirmed', 10, false]);
    t.mdb().prepare("UPDATE branch_prices SET seen_file = '20200101000000' WHERE code = '7290000000000'").run();
    line = (await t.compare()).results[0].lines[0];
    assert.deepEqual([line.lineTotal, line.old], [10, true]);
    assert.equal((await t.compare()).results[0].oldCount, 1);
  } finally { restore(); await t.close(); }
});

test('a branch with no PriceFull file is reported, not fatal; prices of branches no list uses any more are dropped', async () => {
  const t = await boot();
  await t.select(['stop_market', '2'], ['rami_levy', '2']); // Rami Levy branch 2 has no file in the fake portal
  const c = await t.compare();
  assert.equal(c.results.find((r) => r.chain === 'rami_levy').error, 'no_pricefull');
  assert.ok(c.results.find((r) => r.chain === 'stop_market').hasData);
  assert.ok(t.mdb().prepare("SELECT COUNT(*) c FROM branch_prices WHERE chain = 'stop_market'").get().c > 0);
  await t.select(['shufersal', '17']);   // stop market is no longer compared
  assert.equal(t.mdb().prepare("SELECT COUNT(*) c FROM branch_prices WHERE chain = 'stop_market'").get().c, 0);
  assert.equal(t.mdb().prepare("SELECT COUNT(*) c FROM branch_price_state WHERE chain = 'stop_market'").get().c, 0);
  assert.ok(t.mdb().prepare("SELECT COUNT(*) c FROM branch_prices WHERE chain = 'shufersal'").get().c > 0);
  await t.close();
});

test('lazy refresh: the first look after the interval starts a read; the admin sets the interval', async () => {
  const t = await boot();
  await t.select(['stop_market', '2']);
  assert.equal((await t.compare()).prices.startedNow, false); // fresh: nothing to do
  t.mdb().prepare('UPDATE branch_price_state SET checked_at = checked_at - 90000000').run(); // 25 hours ago
  const c = await t.compare();
  assert.equal(c.prices.startedNow, true);
  await t.waitJob();
  assert.ok(svc.prices.stateOf('stop_market', '2').checked_at > Date.now() - 60000);

  assert.equal((await t.call('PUT', `${M}/admin/settings`, { priceRefreshHours: 48 }, t.admin.cookie)).body.priceRefreshHours, 48);
  assert.equal((await t.compare()).prices.refreshHours, 48);
  t.mdb().prepare('UPDATE branch_price_state SET checked_at = checked_at - 90000000').run(); // 25 hours: not due with a 48 hour interval
  assert.equal((await t.compare()).prices.startedNow, false);
  for (const bad of [0, 169, 'x', 1.5]) assert.equal((await t.call('PUT', `${M}/admin/settings`, { priceRefreshHours: bad }, t.admin.cookie)).status, 400);
  const user = await t.mkUser('dana');
  assert.equal((await t.call('PUT', `${M}/admin/settings`, { priceRefreshHours: 12 }, user.cookie)).status, 403);
  await t.close();
});

/* ---------- matching and comparing ---------- */

test('matching: candidates are ranked, a confirmation prices the item and is remembered, none and delete work, permissions hold', async () => {
  const t = await boot();
  await t.select(['stop_market', '2'], ['shufersal', '17']);
  const milk = fixture(STOP).items.find((i) => i.code === '7290110563462');
  const id = await t.want('חלב נטול לקטוז', 2);
  const shopper = await t.mkUser('dana', 'viewer');

  let m = (await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market`, undefined, t.admin.cookie)).body;
  assert.equal(m.candidates[0].code, milk.code);
  assert.deepEqual([m.noData, m.current, m.viaBarcode, m.candidates[0].price, m.candidates[0].pack], [false, null, null, 10.3, { amount: 1000, unit: 'ml' }]);
  assert.ok(m.candidates.length <= 8);
  const own = (await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market&q=${encodeURIComponent('דנונה')}`, undefined, t.admin.cookie)).body;
  assert.equal(own.query, 'דנונה'); assert.ok(own.candidates.every((c) => /דנונה/.test(c.name)));

  let c = await t.compare();
  const stop = () => c.results.find((r) => r.chain === 'stop_market' && r.branchId === '2');
  assert.deepEqual([stop().priced, stop().needsMatch.map((x) => x.name)], [0, ['חלב נטול לקטוז']]); // not matched yet

  assert.equal((await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: milk.code }, shopper.cookie)).status, 403); // Shoppers only look
  assert.equal((await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market`, undefined, shopper.cookie)).status, 200);
  const put = await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: milk.code }, t.admin.cookie);
  assert.deepEqual([put.status, put.body.mapping.status, put.body.mapping.code], [200, 'confirmed', milk.code]);
  c = await t.compare(shopper.cookie);
  assert.deepEqual([stop().priced, stop().total, stop().lines[0].via, stop().lines[0].product.name, stop().needsMatch.length], [1, 20.6, 'confirmed', milk.name, 0]); // 2 x 10.30
  m = (await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market`, undefined, t.admin.cookie)).body;
  assert.equal(m.current.code, milk.code);

  for (const [body, status, error] of [[{ chain: 'stop_market', code: 'no-such-product' }, 400, 'unknown_product'], [{ chain: 'nope', code: milk.code }, 404], [{ chain: 'stop_market' }, 400, 'invalid_value'], [{ code: milk.code }, 404]]) {
    const r = await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, body, t.admin.cookie);
    assert.equal(r.status, status, JSON.stringify(body)); if (error) assert.equal(r.body.error, error);
  }
  assert.equal((await t.call('PUT', `${M}/lists/${t.lid}/items/99999/match`, { chain: 'stop_market', code: milk.code }, t.admin.cookie)).status, 404);

  // "not sold here" is remembered too, and is not the same as "not matched yet"
  await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'shufersal', none: true }, t.admin.cookie);
  c = await t.compare();
  const sh = c.results.find((r) => r.chain === 'shufersal' && r.branchId === '17');
  assert.deepEqual([sh.needsMatch.length, sh.notSold.map((x) => [x.name, x.reason])], [0, [['חלב נטול לקטוז', 'marked']]]);

  assert.equal((await t.call('DELETE', `${M}/lists/${t.lid}/items/${id}/match?chain=shufersal`, undefined, shopper.cookie)).status, 403);
  assert.equal((await t.call('DELETE', `${M}/lists/${t.lid}/items/${id}/match?chain=shufersal`, undefined, t.admin.cookie)).status, 200);
  c = await t.compare();
  assert.deepEqual(c.results.find((r) => r.chain === 'shufersal').needsMatch.map((x) => x.name), ['חלב נטול לקטוז']);
  await t.close();
});

test('a barcode confirmed at one chain prices the item at the others automatically; an explicit choice overrides it', async () => {
  const t = await boot();
  // two real products that two chains share (the same barcode in the Shufersal and Stop Market files)
  const stop = new Map(fixture(STOP).items.map((i) => [i.code, i])), sh = fixture(SHUFERSAL).items.filter((i) => stop.has(i.code) && /^\d{8,14}$/.test(i.code));
  assert.ok(sh.length >= 1);
  const shared = sh[0], atStop = stop.get(shared.code);
  await t.select(['stop_market', '2'], ['shufersal', '17']);
  const id = await t.want(shared.name, 3);

  await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'shufersal', code: shared.code }, t.admin.cookie);
  const c = await t.compare();
  const stopRow = c.results.find((r) => r.chain === 'stop_market' && r.branchId === '2'), shRow = c.results.find((r) => r.chain === 'shufersal' && r.branchId === '17');
  assert.deepEqual([shRow.lines[0].via, shRow.total], ['confirmed', Math.round(shared.price * 3 * 100) / 100]);
  assert.deepEqual([stopRow.lines[0].via, stopRow.lines[0].product.code, stopRow.total], ['barcode', shared.code, Math.round(atStop.price * 3 * 100) / 100]);
  const m = (await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market`, undefined, t.admin.cookie)).body;
  assert.deepEqual([m.viaBarcode.code, m.candidates[0].barcodeMatch, m.candidates[0].code], [shared.code, true, shared.code]);

  // choosing something else at Stop Market wins over the barcode rule
  const other = [...stop.values()].find((i) => i.code !== shared.code);
  await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: other.code }, t.admin.cookie);
  const c2 = await t.compare();
  assert.deepEqual([c2.results.find((r) => r.chain === 'stop_market').lines[0].via, c2.results.find((r) => r.chain === 'stop_market').lines[0].product.code], ['confirmed', other.code]);
  await t.close();
});

test('weighed products: the amount "1" stands for is asked once and used; different pack sizes are marked for a unit price', async () => {
  const t = await boot();
  const stop = fixture(STOP).items, sh = fixture(SHUFERSAL).items;
  const weighed = stop.find((i) => i.weighted === 1);
  await t.select(['stop_market', '2'], ['shufersal', '17']);
  const id = await t.want('גבינה כתומה', 2);
  const put = (body) => t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, body, t.admin.cookie);

  assert.equal((await put({ chain: 'stop_market', code: weighed.code, amountKg: 0 })).status, 400);
  assert.equal((await put({ chain: 'stop_market', code: weighed.code, amountKg: 99 })).status, 400);
  assert.equal((await put({ chain: 'stop_market', code: weighed.code, amountKg: 0.25 })).body.mapping.amountKg, 0.25);
  let r = (await t.compare()).results.find((x) => x.chain === 'stop_market');
  assert.deepEqual([r.lines[0].amountKg, r.total], [0.25, Math.round(weighed.price * 2 * 0.25 * 100) / 100]); // price is per kilo: 2 x 250 g
  await put({ chain: 'stop_market', code: weighed.code });                // no amount: one kilo
  r = (await t.compare()).results.find((x) => x.chain === 'stop_market');
  assert.deepEqual([r.lines[0].amountKg, r.total], [1, Math.round(weighed.price * 2 * 100) / 100]);
  const packaged = stop.find((i) => !i.weighted && i.packAmount);
  assert.equal((await put({ chain: 'stop_market', code: packaged.code, amountKg: 5 })).body.mapping.amountKg, null); // only weighed products have an amount

  // two different pack sizes of "the same" thing
  const a = stop.find((i) => i.packAmount && i.packUnit === 'g'), b = sh.find((i) => i.packAmount && i.packUnit === 'g' && Math.abs(i.packAmount - a.packAmount) / a.packAmount > 0.1);
  assert.ok(a && b);
  await put({ chain: 'stop_market', code: a.code }); await put({ chain: 'shufersal', code: b.code });
  const c = await t.compare();
  assert.ok(c.results.every((x) => x.lines[0].sizeDiffers === true));
  assert.ok(c.results.every((x) => x.lines[0].product.unitPrice > 0 && x.lines[0].product.unit));
  await put({ chain: 'shufersal', code: b.code });
  await t.close();
});

test('cleanup: forgetting an item or a household removes its confirmations', async () => {
  const t = await boot();
  await t.select(['stop_market', '2']);
  const code = fixture(STOP).items[0].code;
  const id = await t.want('משהו');
  await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code }, t.admin.cookie);
  const n = () => t.mdb().prepare('SELECT COUNT(*) c FROM product_map').get().c;
  assert.equal(n(), 1);
  t.app.modules.events.emit('item.deleted', { itemId: id, householdId: t.hid });
  assert.equal(n(), 0);
  await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code }, t.admin.cookie);
  t.app.modules.events.emit('household.deleted', { householdId: t.hid, listIds: [t.lid], storeIds: [] });
  assert.equal(n(), 0);
  await t.close();
});

/* ---------- 1.2.0: matching once for every branch and chain ---------- */

const gz = (storeId, items) => gzipXml(priceXml(storeId, items));
const CHEESE = { code: '7290000001111', name: 'גבינה צהובה עמק 28% 500 גרם', brand: 'תנובה', qty: 500, unitQty: 'גרם', price: 30 };

test('another branch of the same chain: same product by code, or by exact name when its code differs; one list of items to match per chain', async () => {
  const t = await boot();
  const r2 = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261107-010011.gz', gz(2, [CHEESE, { code: '7290000009999', name: 'אורז בסמטי 1 ק"ג', price: 12, qty: 1, unitQty: 'קילוגרם' }]));
  const r3 = replaceFull('stop_market', 3, 'PriceFull7290639000004-001-003-20261107-010011.gz', gz(3, [{ ...CHEESE, code: '7290000002222', price: 28 }]));   // the same name under another code
  try {
    await t.select(['stop_market', '2'], ['stop_market', '3']);
    const cheese = await t.want('גבינה צהובה'), rice = await t.want('אורז');
    let c = await t.compare();
    assert.deepEqual(c.matchGroups.map((g) => [g.chain, g.items.map((i) => i.name).sort()]), [['stop_market', ['אורז', 'גבינה צהובה']]]); // once for the chain, not once per branch

    await t.call('PUT', `${M}/lists/${t.lid}/items/${cheese}/match`, { chain: 'stop_market', code: CHEESE.code }, t.admin.cookie);
    c = await t.compare();
    const b2 = c.results.find((r) => r.branchId === '2'), b3 = c.results.find((r) => r.branchId === '3');
    assert.deepEqual([b2.lines[0].via, b2.total], ['confirmed', 30]);
    assert.deepEqual([b3.lines[0].via, b3.total, b3.lines[0].product.code], ['sameName', 28, '7290000002222']);   // priced at the other branch without asking again
    assert.deepEqual(c.matchGroups[0].items.map((i) => i.name), ['אורז']);        // only the rice still needs the user
    assert.deepEqual([b3.needsMatch.map((x) => x.name), b3.priced, b3.of], [['אורז'], 1, 2]);
  } finally { r2(); r3(); await t.close(); }
});

test('a clear match is carried to the other chains by itself, labelled, and replaced by the user\'s own choice', async () => {
  const t = await boot();
  const base = (extra = {}) => [{ ...CHEESE, ...extra }];
  const rs = replaceFull('shufersal', 17, 'PriceFull7290027600007-001-017-20261107-030000.gz', gz(17, [{ ...CHEESE, code: '1000000000011', name: 'גבינה צהובה עמק 28% 500 גרם תנובה', price: 32 }, { ...CHEESE, code: '1000000000012', name: 'גבינה לבנה 5% 250 גרם', price: 9, qty: 250 }]));
  const rt = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261107-010011.gz', gz(2, base()));
  try {
    await t.select(['stop_market', '2'], ['shufersal', '17']);
    const id = await t.want('גבינה צהובה', 2);
    await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: CHEESE.code }, t.admin.cookie);
    const c = await t.compare();
    const sh = c.results.find((r) => r.chain === 'shufersal'), stop = c.results.find((r) => r.chain === 'stop_market');
    assert.deepEqual([sh.lines[0].via, sh.lines[0].autoFrom, sh.lines[0].product.code, sh.total], ['auto', 'stop_market', '1000000000011', 64]);
    assert.deepEqual([stop.lines[0].via, stop.total], ['confirmed', 60]);
    assert.deepEqual(c.matchGroups, []);                                            // nothing left for the user
    const row = t.mdb().prepare("SELECT status, source_chain, code FROM product_map WHERE chain = 'shufersal'").get();
    assert.deepEqual([row.status, row.source_chain, row.code], ['auto', 'stop_market', '1000000000011']);
    const m = (await t.call('GET', `${M}/lists/${t.lid}/items/${id}/match?chain=shufersal`, undefined, t.admin.cookie)).body;
    assert.deepEqual([m.current.status, m.current.autoFrom], ['auto', 'stop_market']);

    // the user chooses another product at Shufersal: that is the choice from now on
    await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'shufersal', code: '1000000000012' }, t.admin.cookie);
    let line = (await t.compare()).results.find((r) => r.chain === 'shufersal').lines[0];
    assert.deepEqual([line.via, line.product.code], ['confirmed', '1000000000012']);
    // ...and changing the source forgets what was carried over from it, but never the user's own choice
    await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: CHEESE.code }, t.admin.cookie);
    assert.equal(t.mdb().prepare("SELECT status FROM product_map WHERE chain = 'shufersal'").get().status, 'confirmed');
    // forgetting the user's choice at Shufersal lets the clear match come back
    await t.call('DELETE', `${M}/lists/${t.lid}/items/${id}/match?chain=shufersal`, undefined, t.admin.cookie);
    line = (await t.compare()).results.find((r) => r.chain === 'shufersal').lines[0];
    assert.equal(line.via, 'auto');
    // forgetting the source forgets what came from it
    await t.call('DELETE', `${M}/lists/${t.lid}/items/${id}/match?chain=stop_market`, undefined, t.admin.cookie);
    assert.equal(t.mdb().prepare("SELECT COUNT(*) c FROM product_map WHERE status = 'auto'").get().c, 0);
    assert.deepEqual((await t.compare()).matchGroups.map((g) => g.chain).sort(), ['shufersal', 'stop_market']);
  } finally { rs(); rt(); await t.close(); }
});

test('what must not be matched by itself: another size, another brand, extra words, a rival that fits as well, weighed against packed', async () => {
  const cases = [
    ['another pack size', [{ ...CHEESE, code: '2', name: 'גבינה צהובה עמק 28% 250 גרם תנובה', qty: 250, price: 20 }]],
    ['another brand', [{ ...CHEESE, code: '3', name: 'גבינה צהובה עמק 28% 500 גרם', brand: 'טרה' }]],
    ['extra words', [{ ...CHEESE, code: '4', name: 'גבינה צהובה עמק 28% דלת שומן 500 גרם' }]],
    ['two products that fit equally', [{ ...CHEESE, code: '5' }, { ...CHEESE, code: '6', price: 31 }]],
    ['weighed at the other chain', [{ ...CHEESE, code: '7', weighted: true, qty: 0 }]],
  ];
  for (const [why, items] of cases) {
    const t = await boot();
    const rs = replaceFull('shufersal', 17, 'PriceFull7290027600007-001-017-20261107-030000.gz', gz(17, items));
    const rt = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261107-010011.gz', gz(2, [CHEESE]));
    try {
      await t.select(['stop_market', '2'], ['shufersal', '17']);
      const id = await t.want('גבינה צהובה');
      await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: CHEESE.code }, t.admin.cookie);
      const c = await t.compare();
      assert.equal(c.results.find((r) => r.chain === 'shufersal').priced, 0, why);
      assert.deepEqual(c.matchGroups.map((g) => g.chain), ['shufersal'], why);
      assert.equal(t.mdb().prepare("SELECT COUNT(*) c FROM product_map WHERE status = 'auto'").get().c, 0, why);
    } finally { rs(); rt(); await t.close(); }
  }
});

test('the age after which a price counts as old is a setting; the compare screen gets a summary of the last read', async () => {
  const t = await boot();
  const r = replaceFull('stop_market', 2, 'PriceFull7290639000004-001-002-20261107-010011.gz', gz(2, [CHEESE]));
  try {
    await t.select(['stop_market', '2']);
    const id = await t.want('גבינה צהובה');
    await t.call('PUT', `${M}/lists/${t.lid}/items/${id}/match`, { chain: 'stop_market', code: CHEESE.code }, t.admin.cookie);
    let c = await t.compare();
    assert.deepEqual([c.prices.oldAfterDays, c.results[0].lines[0].old], [60, false]);
    assert.deepEqual(c.prices.lastJob && [c.prices.lastJob.updated, c.prices.lastJob.unchanged, c.prices.lastJob.failed], [1, 0, 0]);
    const daysAgo = (d) => { const x = new Date(Date.now() - d * 86400000); return x.toISOString().replace(/[-:T]/g, '').slice(0, 14); };
    t.mdb().prepare('UPDATE branch_prices SET seen_file = ?').run(daysAgo(40));
    assert.equal((await t.compare()).results[0].lines[0].old, false);        // 40 days: not old yet at 60
    assert.equal((await t.call('PUT', `${M}/admin/settings`, { oldAfterDays: 30 }, t.admin.cookie)).body.oldAfterDays, 30);
    c = await t.compare();
    assert.deepEqual([c.prices.oldAfterDays, c.results[0].lines[0].old], [30, true]);
    for (const bad of [6, 366, 'x', 1.5]) assert.equal((await t.call('PUT', `${M}/admin/settings`, { oldAfterDays: bad }, t.admin.cookie)).status, 400);
  } finally { r(); await t.close(); }
});

test('upgrading a 1.1.0 module database keeps the confirmations and adds what auto-matching needs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  let app = await buildApp({ dataDir, logger: false });
  await app.close();
  const Database = createRequire(new URL('../../../server/package.json', import.meta.url))('better-sqlite3');
  const file = path.join(dataDir, 'modules', 'price-compare', 'data.db');
  const d = new Database(file);
  d.exec(`DROP TABLE product_map; CREATE TABLE product_map (household_id INTEGER NOT NULL, item_id INTEGER NOT NULL, chain TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('confirmed','none')),
    code TEXT, item_type INTEGER, name TEXT, amount_kg REAL, confirmed_by INTEGER, confirmed_at INTEGER NOT NULL, PRIMARY KEY (household_id, item_id, chain));
    INSERT INTO product_map VALUES (1, 5, 'shufersal', 'confirmed', '729000', 1, 'חלב', NULL, 1, 1000), (1, 6, 'rami_levy', 'none', NULL, NULL, NULL, NULL, 1, 2000);`);
  d.pragma('user_version = 2'); d.close();
  app = await buildApp({ dataDir, logger: false });
  const m = app.modules.loaded.get('price-compare').db;
  assert.equal(m.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(m.prepare('SELECT item_id, chain, status, code, source_chain FROM product_map ORDER BY item_id').all().map((r) => [r.item_id, r.chain, r.status, r.code, r.source_chain]), [[5, 'shufersal', 'confirmed', '729000', null], [6, 'rami_levy', 'none', null, null]]);
  m.prepare("INSERT INTO product_map(household_id, item_id, chain, status, confirmed_at) VALUES (1, 7, 'carrefour', 'auto', 1)").run(); // the new status is allowed
  await app.close();
});
