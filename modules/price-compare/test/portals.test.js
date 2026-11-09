import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../../server/src/app.js';
import { startFakePortals } from './fakePortals.js';
import { decodeXmlBytes, describeBytes } from '../server/portals/decode.js';
import { parseStoresXml, iterItems, headerOf } from '../server/portals/xml.js';
import { normalizeUnit } from '../server/portals/units.js';
import { createHttp } from '../server/portals/http.js';
import { createPortals, newestFirst, storeOfName } from '../server/portals/clients.js';
import { summarizePriceFile } from '../server/portals/diagnostics.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portal');
const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

let svc; // the module's directory, chains and portal clients, handed out through its test option (set by boot)
async function boot({ delayMs = 0 } = {}) {
  const fake = await startFakePortals();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, moduleOptions: { 'price-compare': { baseUrls: { shufersal: fake.urls.shufersal, shared: fake.urls.shared, carrefour: fake.urls.carrefour }, citiesUrl: fake.urls.cities, delayMs, expose: (x) => { svc = x; } } } });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, raw: res.rawPayload, cookie: c ? `sl_session=${c.value}` : null };
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
  const idle = async () => { for (let i = 0; i < 200 && svc.dir.status()?.running; i++) await new Promise((r) => setTimeout(r, 25)); };
  const close = async () => { await idle(); await app.close(); await fake.close(); };
  return { app, fake, call, admin, hid, lid, mkUser, idle, close };
}

// ---------- parsing real file shapes ----------
test('decoding: gzip UTF-8 with BOM, plain UTF-16 LE with BOM, and unknown shapes', () => {
  const stores = fs.readFileSync(path.join(FIX, 'Stores7290639000004-000-20261105-055500.xml'));
  assert.equal(describeBytes(stores), 'plain + UTF-16 LE (BOM)');
  const p = parseStoresXml(decodeXmlBytes(stores));
  assert.deepEqual([p.chainId, p.chainName, p.stores.length], ['7290639000004', 'סטופמרקט', 11]);
  assert.deepEqual([p.stores[0].storeId, p.stores[0].storeIdRaw, p.stores[0].city, p.stores[0].zip, p.stores[0].subChainId, p.stores[0].subChainName], ['2', '002', '6400', '4655502', '001', '1']);
  assert.equal(p.stores.at(-1).zip, '0000000');

  const price = fs.readFileSync(path.join(FIX, 'PriceFull7290058140886-001-001-20261107-001000.gz'));
  assert.equal(describeBytes(price), 'gzip + UTF-8 (BOM)');
  const xml = decodeXmlBytes(price);
  assert.equal(xml.charCodeAt(0), 60); // '<': the BOM is gone
  assert.deepEqual([headerOf(xml).chainid, headerOf(xml).storeid], ['7290058140886', '001']);
  const items = [...iterItems(xml)];
  assert.equal(items.length, 93);
  assert.deepEqual(Object.keys(items[0]).length, 17);
  assert.ok(items[0].manufacturename !== undefined); // the real tag is ManufactureName, not ManufacturerName

  assert.throws(() => decodeXmlBytes(Buffer.from('PK\u0003\u0004rest')), /zip_archive_not_supported/);
  assert.throws(() => decodeXmlBytes(Buffer.from('ab')), /empty_file/);
  const utf16 = Buffer.from('<Root><ChainID>1</ChainID></Root>', 'utf16le'); // UTF-16 without a BOM
  assert.equal(headerOf(decodeXmlBytes(utf16)).chainid, '1');
  assert.equal(decodeXmlBytes(zlib.gzipSync(Buffer.from('<Root>&amp;</Root>'))), '<Root>&amp;</Root>');
});

test('unit spellings seen in the four chains are known; anything else is flagged, not guessed', () => {
  for (const u of ['100 גרם', '100 מיליליטר', 'יחידות', '1קילוגרם', '1 קילוגרם', 'ליטר', '1ליטר', 'קילוגרם', 'מטרים', '100 מטרים', '100 מ"ל', 'מיליליטר', 'מיליליטרים', 'מטר']) assert.ok(normalizeUnit(u), u);
  assert.deepEqual(normalizeUnit('100 מ״ל'), { unit: 'ml', per: 100 }); // typographic gershayim
  // spellings that appeared in the first live tests: read literally
  assert.deepEqual(normalizeUnit('100 קילוגרם'), { unit: 'kg', per: 100 });
  assert.deepEqual(normalizeUnit('2 יחידות'), { unit: 'item', per: 2 });
  assert.deepEqual(normalizeUnit('גרם'), { unit: 'g', per: 1 });
  assert.deepEqual(normalizeUnit('100 ס"מ'), { unit: 'cm', per: 100 });
  // the file itself says no unit is given: counted separately, not flagged as an unknown spelling
  for (const u of ['Unknown', 'לא ידוע', 'לא מנהל יחידת מידה']) assert.equal(normalizeUnit(u).unit, 'unspecified');
  assert.equal(normalizeUnit('1'), null); // a bare number is ambiguous: flagged, never guessed
});

test('dry-run summary of the real price-file fixtures', () => {
  const sum = (n) => summarizePriceFile(decodeXmlBytes(fs.readFileSync(path.join(FIX, n))));
  const rami = sum('PriceFull7290058140886-001-001-20261107-001000.gz');
  assert.deepEqual([rami.chainId, rami.storeId, rami.items, rami.duplicates, rami.badPrice], ['7290058140886', '001', 93, 0, 0]);
  assert.ok(rami.units.length > 0);
  const stop = sum('PriceFull7290639000004-001-002-20261107-010011.gz');
  assert.equal(stop.chainId, '7290639000004');
  assert.ok(stop.items >= 90);
});

test('the store number is read from the file name segment, not found anywhere in it', () => {
  assert.equal(storeOfName('PriceFull7290058140886-001-036-20261107-180021.gz'), '036');
  assert.equal(storeOfName('Price7290027600007-001-019-20261107-020000.gz'), '019');
  assert.equal(storeOfName('Stores7290639000004-000-20261107-055501.xml'), null);
});

test('newest file wins by date and time stamp, not by time of day alone', () => {
  const l = newestFirst([{ name: 'PriceFull1-001-001-20261106-230000.gz' }, { name: 'PriceFull1-001-001-20261107-010000.gz' }]);
  assert.equal(l[0].name, 'PriceFull1-001-001-20261107-010000.gz');
});

// ---------- the three portal protocols ----------
test('Shufersal client: Stores link, PriceFull per branch, no PriceFull is reported', async () => {
  const fake = await startFakePortals();
  const portals = createPortals({ http: createHttp(), baseUrls: { shufersal: fake.urls.shufersal } });
  const a = portals.open({ id: 'shufersal', platform: 'shufersal' });
  const st = await a.stores();
  assert.equal(st.name, 'Stores7290027600007-000-20261105-070000.gz'); // href with &amp; in its query is unescaped
  assert.equal(parseStoresXml(decodeXmlBytes(st.bytes)).stores.length, 5);
  const pf = await a.priceFull('17');
  assert.equal(pf.name, 'PriceFull7290027600007-001-017-20261107-030000.gz');
  assert.equal([...iterItems(decodeXmlBytes(pf.bytes))].length, 92);
  await assert.rejects(() => a.priceFull('18'), (e) => e.code === 'no_pricefull'); // only a Price (update) file exists: never used
  await fake.close();
});

test('shared portal client: csrf login with an empty password, session cookie on a redirect, search, branch match', async () => {
  const fake = await startFakePortals();
  const portals = createPortals({ http: createHttp(), baseUrls: { shared: fake.urls.shared } });
  const a = portals.open({ id: 'rami_levy', platform: 'shared', user: 'RamiLevi' });
  const st = await a.stores();
  assert.equal(st.name, 'Stores7290058140886-000-20261105-060000.gz');
  const list = await a.priceFullList('1'); // the store segment only: -001- is also every file's sub-chain segment; Price (update) files never match
  assert.deepEqual(list.map((f) => f.name), ['PriceFull7290058140886-001-001-20261107-001000.gz']);
  assert.deepEqual((await a.priceFullList('36')).map((f) => f.name), ['PriceFull7290058140886-001-036-20261107-180021.gz']);
  assert.deepEqual((await a.priceFullList('01')).map((f) => f.name), list.map((f) => f.name)); // leading zeros do not matter
  assert.ok(a.rawKeys.includes('fname'));
  assert.equal((await a.priceFull('1')).name, list[0].name);
  await assert.rejects(() => a.priceFull('9'), (e) => e.code === 'no_pricefull');
  const stop = portals.open({ id: 'stop_market', platform: 'shared', user: 'Stop_Market' });
  assert.equal(describeBytes((await stop.stores()).bytes), 'plain + UTF-16 LE (BOM)');
  await assert.rejects(() => portals.open({ id: 'x', platform: 'shared', user: 'nobody' }).probe(), (e) => e.code === 'login_failed');
  await fake.close();
});

test('Carrefour client: path and file names from the home page', async () => {
  const fake = await startFakePortals();
  const portals = createPortals({ http: createHttp(), baseUrls: { carrefour: fake.urls.carrefour } });
  const a = portals.open({ id: 'carrefour', platform: 'carrefour' });
  assert.equal((await a.stores()).name, 'Stores7290055700007-000-20261105-060000.gz');
  assert.deepEqual((await a.priceFullList('981')).map((f) => f.name), ['PriceFull7290055700007-001-981-20261107-051011.gz']);
  assert.equal([...iterItems(decodeXmlBytes((await a.priceFull('981')).bytes))].length, 92);
  await fake.close();
});

test('a portal that is down gives a clear error, not a hang', async () => {
  const fake = await startFakePortals();
  fake.state.down.add('carrefour');
  const portals = createPortals({ http: createHttp({ timeoutMs: 2000 }), baseUrls: { carrefour: fake.urls.carrefour } });
  await assert.rejects(() => portals.open({ id: 'carrefour', platform: 'carrefour' }).probe(), (e) => e.code === 'http_error' && e.status === 503);
  await fake.close();
});

// ---------- branch directory ----------
test('directory refresh: all chains, filters, banners, city codes and names resolved', async () => {
  const { app, fake, close, idle } = await boot();
  const d = svc.dir;
  assert.equal(d.startRefresh().started, true);
  assert.equal(d.startRefresh().started, false); // one job at a time
  await idle();
  const res = Object.fromEntries(d.status().results.map((r) => [r.chain, r]));
  assert.equal(res.stop_market.branches, 11);
  assert.equal(res.rami_levy.branches, 2);
  assert.equal(res.shufersal.branches, 3); // the BE pharmacy and the online shop are dropped
  assert.equal(res.carrefour.branches, 2);
  assert.equal(res.yochananof.ok, false); // the fake knows no such user: one failing chain does not stop the rest
  assert.match(res.yochananof.error, /login failed/);
  const rows = app.modules.loaded.get('price-compare').db.prepare("SELECT * FROM portal_branches WHERE chain = 'shufersal' ORDER BY store_id").all();
  assert.deepEqual(rows.map((r) => [r.store_id, r.banner, r.city_key]), [['17', 'שלי', '8600'], ['18', 'דיל', '6100'], ['19', 'יש', '4000']]); // names mapped to the government codes
  const car = app.modules.loaded.get('price-compare').db.prepare("SELECT banner, city_key FROM portal_branches WHERE chain = 'carrefour' ORDER BY store_id").all();
  assert.deepEqual(car.map((r) => [r.banner, r.city_key]), [['סיטי', '6600'], ['מרקט', '6400']].reverse());
  const cities = d.listCities();
  const rg = cities.find((c) => c.key === '8600');
  assert.deepEqual([rg.name, rg.branches, rg.chains], ['רמת גן', 2, 2]); // Shufersal (written as a name) and Rami Levy (a code) land on one city; the BE pharmacy is dropped
  assert.equal(app.modules.loaded.get('price-compare').db.prepare("SELECT source FROM city_names WHERE code = '8600'").get().source, 'gov');
  assert.ok(fake.state.hits.gov >= 1);
  const err = app.modules.loaded.get('price-compare').db.prepare("SELECT last_error FROM portal_chain_state WHERE chain = 'yochananof'").get();
  assert.match(err.last_error, /login failed/);
  const stop = d.listBranches({ cities: ['4000'], chainIds: ['stop_market'] });
  assert.equal(stop.length, 3);
  assert.equal(stop[0].cityName, 'חיפה');
  await close();
});

test('directory loads lazily and a down portal is recorded without losing the others', async () => {
  const { app, fake, close, idle } = await boot();
  fake.state.down.add('shufersal');
  svc.dir.ensureFresh();
  await idle();
  const s = svc.dir.chainStats().find((x) => x.chain === 'shufersal');
  assert.match(s.lastError, /503/);
  assert.equal(svc.dir.chainStats().find((x) => x.chain === 'carrefour').branches, 2);
  const before = fake.state.hits.carrefour;
  svc.dir.ensureFresh(); // everything fresh, and the failed chain is not retried within the hour
  await idle();
  assert.equal(fake.state.hits.carrefour, before);
  await close();
});

// ---------- API ----------
test('pickers: the first visit loads the directory in the background; cities and branches come from it', async () => {
  const { call, admin, close, idle } = await boot();
  const first = (await call('GET', '/api/m/price-compare/portals/cities', undefined, admin.cookie)).body;
  assert.equal(first.loading, true);
  assert.ok(first.chains.some((c) => c.id === 'stop_market' && c.enabled));
  await idle();
  const r = (await call('GET', '/api/m/price-compare/portals/cities', undefined, admin.cookie)).body;
  assert.equal(r.loading, false);
  assert.ok(r.cities.some((c) => c.key === '8600' && c.name === 'רמת גן'));
  const b = (await call('GET', '/api/m/price-compare/portals/branches?cities=8600,6100', undefined, admin.cookie)).body.branches;
  assert.ok(b.length >= 4 && b.every((x) => ['8600', '6100'].includes(x.cityKey)));
  assert.ok(b.find((x) => x.chain === 'shufersal' && x.banner === 'שלי'));
  assert.equal((await call('GET', '/api/m/price-compare/portals/cities')).status, 401);
  await close();
});

test('list selection with cities and branches: validated, a branch keeps its chain, Shoppers cannot change it', async () => {
  const { call, admin, lid, mkUser, idle, close } = await boot();
  await call('GET', '/api/m/price-compare/portals/cities', undefined, admin.cookie); await idle();
  const shopper = await mkUser('dana');
  await call('PUT', `/api/lists/${lid}/members/${shopper.id}`, { role: 'viewer' }, admin.cookie);

  const sel = [{ chain: 'stop_market', branchId: '2' }, { chain: 'stop_market', branchId: 3 }, { chain: 'shufersal', branchId: '17' }, { chain: 'rami_levy' }, { chain: 'stop_market', branchId: '2' }];
  const put = await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: sel, cities: ['8600', '6400'] }, admin.cookie);
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.selection.map((s) => `${s.chain}:${s.branchId}`), ['stop_market:', 'stop_market:2', 'stop_market:3', 'shufersal:', 'shufersal:17', 'rami_levy:']);
  assert.deepEqual(put.body.cities.map((c) => c.key), ['8600', '6400']);
  assert.equal(put.body.selection.find((s) => s.branchId === '2').cityName, 'הרצליה');

  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'shufersal', branchId: '999' }] }, admin.cookie)).body.error, 'unknown_branch');
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'victory' }] }, admin.cookie)).status, 400); // not supported yet
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [], cities: ['<script>'] }, admin.cookie)).status, 400);
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [] }, shopper.cookie)).status, 403);

  const seen = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, shopper.cookie)).body;
  assert.equal(seen.canEdit, false);
  assert.equal(seen.selection.length, 6);
  assert.deepEqual(seen.results.map((r) => r.chain).sort(), ['rami_levy', 'shufersal', 'stop_market']); // one row per chain...
  const stop = seen.results.find((r) => r.chain === 'stop_market');
  assert.deepEqual(stop.branches.map((b) => b.storeId), ['2', '3']); // ...with its chosen branches listed
  // omitting `cities` keeps the saved cities
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'rami_levy' }] }, admin.cookie);
  assert.deepEqual((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body.cities.map((c) => c.key), ['8600', '6400']);
  await close();
});

test('a chain the admin switches off disappears from pickers and selections', async () => {
  const { call, admin, lid, idle, close } = await boot();
  await call('GET', '/api/m/price-compare/portals/cities', undefined, admin.cookie); await idle();
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'carrefour' }, { chain: 'rami_levy' }] }, admin.cookie);
  assert.equal((await call('PUT', '/api/m/price-compare/admin/portals/carrefour', { enabled: false }, admin.cookie)).status, 200);
  const r = (await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body;
  assert.deepEqual(r.selection.map((s) => s.chain), ['rami_levy']);
  assert.equal(r.chains.find((c) => c.id === 'carrefour').enabled, false);
  assert.equal((await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'carrefour' }] }, admin.cookie)).status, 400);
  assert.equal((await call('PUT', '/api/m/price-compare/admin/portals/victory', { enabled: true }, admin.cookie)).status, 404);
  const cities = (await call('GET', '/api/m/price-compare/portals/cities', undefined, admin.cookie)).body.cities;
  assert.ok(!cities.some((c) => c.key === '6600')); // Holon only had Carrefour
  await close();
});

test('Portals screen: status, per-chain test report, raw samples (admin only)', async () => {
  const { call, admin, mkUser, idle, close, app } = await boot();
  const user = await mkUser('eve');
  assert.equal((await call('GET', '/api/m/price-compare/admin/portals', undefined, user.cookie)).status, 403);

  assert.equal((await call('POST', '/api/m/price-compare/portals/refresh', { chain: 'stop_market' }, admin.cookie)).body.started, true);
  await idle();
  const ov = (await call('GET', '/api/m/price-compare/admin/portals', undefined, admin.cookie)).body;
  const sm = ov.chains.find((c) => c.id === 'stop_market');
  assert.deepEqual([sm.platform, sm.user, sm.branches, sm.cities, sm.zipFilled, sm.storesFile], ['shared', 'Stop_Market', 11, 8, 10, 'Stores7290639000004-000-20261105-055500.xml']);
  assert.equal(ov.chains.findIndex((c) => c.id === 'stop_market'), 0); // listed first
  assert.ok(ov.chains.some((c) => c.id === 'victory' && !c.supported));

  const t = (await call('POST', '/api/m/price-compare/portals/stop_market/test', { save: true }, admin.cookie)).body;
  assert.deepEqual(t.report.steps.map((s) => [s.name, s.ok]), [['open', true], ['stores', true], ['pricefull_list', true], ['pricefull_parse', true]]);
  const stores = t.report.steps[1].detail, parse = t.report.steps[3].detail;
  assert.deepEqual([stores.branches, stores.cities, stores.cityCodes, stores.zipFilled, stores.format], [11, 8, 'numeric codes', 10, 'plain + UTF-16 LE (BOM)']);
  assert.deepEqual([parse.chainId, parse.storeId, parse.format], ['7290639000004', '002', 'gzip + UTF-8 (BOM)']);
  assert.ok(parse.items >= 90 && parse.units.length > 0);
  assert.deepEqual(t.report.saved.sort(), ['PriceFull7290639000004-001-002-20261107-010011.gz', 'Stores7290639000004-000-20261105-055500.xml']);
  const dl = await call('GET', `/api/m/price-compare/admin/portals/samples/stop_market/${t.report.saved[0]}`, undefined, admin.cookie);
  assert.equal(dl.status, 200); assert.ok(dl.raw.length > 100);
  assert.equal((await call('GET', `/api/m/price-compare/admin/portals/samples/stop_market/${t.report.saved[0]}`, undefined, user.cookie)).status, 403);
  assert.equal((await call('GET', '/api/m/price-compare/admin/portals/samples/stop_market/..%2F..%2Fx', undefined, admin.cookie)).status, 404);

  // a chain with no PriceFull today is reported, not crashed
  const o = (await call('POST', '/api/m/price-compare/portals/osher_ad/test', {}, admin.cookie)).body.report;
  assert.deepEqual(o.steps.map((s) => [s.name, s.ok]), [['open', true], ['stores', true], ['pricefull_list', false]]);
  assert.equal(o.steps[2].code, 'no_pricefull');
  // a chain whose login fails stops after the first step with the reason
  const y = (await call('POST', '/api/m/price-compare/portals/yochananof/test', {}, admin.cookie)).body.report;
  assert.deepEqual(y.steps.map((s) => [s.name, s.ok]), [['open', false]]);
  assert.match(y.steps[0].error, /login failed/);
  assert.equal((await call('POST', '/api/m/price-compare/portals/victory/test', {}, admin.cookie)).status, 404);
  assert.ok(app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'module.price-compare.portals.test'").get());
  await close();
});

test('experimental: an admin can add a chain by its portal username, test it, and remove it', async () => {
  const { call, admin, lid, idle, close } = await boot();
  assert.equal((await call('POST', '/api/m/price-compare/admin/portals/custom', { name: 'Victory', user: 'RamiLevi' }, admin.cookie)).status, 409); // already a built-in username
  assert.equal((await call('POST', '/api/m/price-compare/admin/portals/custom', { name: 'Victory', user: 'bad name!' }, admin.cookie)).status, 400);
  const add = await call('POST', '/api/m/price-compare/admin/portals/custom', { name: 'Victory', user: 'victoryfake' }, admin.cookie);
  assert.equal(add.body.id, 'custom_victoryfake');
  await call('POST', '/api/m/price-compare/portals/refresh', { chain: 'custom_victoryfake' }, admin.cookie); await idle();
  assert.equal(app_branches(await call('GET', '/api/m/price-compare/admin/portals', undefined, admin.cookie), 'custom_victoryfake'), 1);
  await call('PUT', `/api/m/price-compare/lists/${lid}/stores`, { selection: [{ chain: 'custom_victoryfake', branchId: '5' }] }, admin.cookie);
  assert.equal((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body.selection.length, 2);
  assert.equal((await call('DELETE', '/api/m/price-compare/admin/portals/custom/custom_victoryfake', undefined, admin.cookie)).status, 200);
  assert.equal((await call('GET', `/api/m/price-compare/lists/${lid}/compare`, undefined, admin.cookie)).body.selection.length, 0);
  assert.equal((await call('DELETE', '/api/m/price-compare/admin/portals/custom/custom_victoryfake', undefined, admin.cookie)).status, 404);
  await close();
});
const app_branches = (r, id) => r.body.chains.find((c) => c.id === id).branches;

test('any signed-in user can look, reload and test, but is rate limited and cannot keep raw files or change anything', async () => {
  const { call, admin, mkUser, idle, close, fake } = await boot();
  const user = await mkUser('eve');
  assert.equal((await call('GET', '/api/m/price-compare/portals/status')).status, 401);
  const st = (await call('GET', '/api/m/price-compare/portals/status', undefined, user.cookie)).body;
  assert.equal(st.isAdmin, false);
  assert.equal(st.baseUrls, undefined); // internal addresses stay admin-only
  assert.ok(st.chains.find((c) => c.id === 'stop_market'));

  const r1 = await call('POST', '/api/m/price-compare/portals/refresh', { chain: 'stop_market' }, user.cookie);
  assert.equal(r1.body.started, true);
  await idle();
  const r2 = await call('POST', '/api/m/price-compare/portals/refresh', { chain: 'stop_market' }, user.cookie); // again straight away
  assert.equal(r2.status, 429); assert.equal(r2.body.error, 'try_later'); assert.ok(r2.body.retryAfter > 0);
  assert.equal((await call('POST', '/api/m/price-compare/portals/refresh', { chain: 'rami_levy' }, user.cookie)).body.started, true); // another scope is fine
  await idle();

  const t1 = await call('POST', '/api/m/price-compare/portals/stop_market/test', { save: true }, user.cookie);
  assert.equal(t1.status, 200);
  assert.deepEqual(t1.body.report.saved, []); // only admins can keep raw files
  assert.deepEqual(t1.body.samples, []);
  assert.equal((await call('POST', '/api/m/price-compare/portals/stop_market/test', {}, user.cookie)).status, 429);
  assert.equal((await call('POST', '/api/m/price-compare/portals/shufersal/test', {}, user.cookie)).status, 200); // per chain

  // admins are not limited, and may keep files
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/api/m/price-compare/portals/stop_market/test', { save: i === 1 }, admin.cookie)).status, 200);
  assert.equal((await call('POST', '/api/m/price-compare/portals/refresh', {}, admin.cookie)).status, 200); await idle();
  assert.equal((await call('POST', '/api/m/price-compare/portals/refresh', {}, admin.cookie)).status, 200); await idle();

  // everything that changes the setup stays admin-only
  assert.equal((await call('PUT', '/api/m/price-compare/admin/portals/stop_market', { enabled: false }, user.cookie)).status, 403);
  assert.equal((await call('POST', '/api/m/price-compare/admin/portals/custom', { name: 'x', user: 'abc' }, user.cookie)).status, 403);
  assert.equal((await call('GET', '/api/m/price-compare/admin/portals', undefined, user.cookie)).status, 403);
  assert.equal((await call('GET', '/api/m/price-compare/admin/portals/samples/stop_market/x', undefined, user.cookie)).status, 403);
  assert.equal((await call('POST', '/api/m/price-compare/portals/victory/test', {}, user.cookie)).status, 404);
  assert.ok(fake.state.hits.shared >= 1);
  await close();
});
