import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, M } from './auto-helpers.js';
import { translateQuery, phraseKey } from '../server/translate.js';
import { exactMatch, prefixMatch } from '../server/suggest.js';
import { brandKey } from '../server/matching.js';

const MILK = ['7290000000001', 1, 'חלב תנובה 3% 1 ליטר', '', 'תנובה', 7.9, 0, 1, 'l'];
const MILK_RAMI = ['7290000000001', 1, 'חלב תנובה 3% 1 ל', '', 'תנובה בע"מ', 7.5, 0, 1, 'l'];
const COTTAGE = ['7290000000002', 1, 'קוטג 5% תנובה', 'קוטג 5% תנובה 250 גרם', 'תנובה', 6.5, 0, 250, 'g'];
const CUT = ['7290000000003', 1, 'מטליות לחות לרצפה פו', 'מטליות לחות לרצפה פולי ווקס פרקט 70 יח', 'סנו', 12, 0, 70, 'item'];

test('translation: phrases, plurals, alternatives, noise words, and what it cannot translate', () => {
  const v = (s) => translateQuery(s).segments.map((x) => x.variants[0]);
  assert.deepEqual(v('Cottage cheese'), ['גבינת קוטג']);
  assert.deepEqual(v('Cucumbers'), ['מלפפון']);                                   // plural
  assert.deepEqual(v('Tomatoes'), ['עגבניות']);
  assert.deepEqual(v('Potato starch or rice flour'), ['קמח תפוח אדמה', 'קמח אורז']);   // two alternatives
  assert.deepEqual(v('Cheese / yellow cheese'), ['גבינה', 'גבינה צהובה']);
  assert.deepEqual(v('Kosher for Passover olive oil'), ['כשר לפסח שמן זית']);
  assert.deepEqual(v('Osem flour'), ['אסם קמח']);                                  // a brand
  const u = translateQuery('Zorbleflex 3000');
  assert.deepEqual([u.complete, u.unknown], [false, ['zorbleflex']]);              // numbers are not words; the rest is reported
  assert.equal(translateQuery('חלב').segments[0].variants[0], 'חלב');             // Hebrew passes through
  // an answer kept from an AI wins over the dictionary for exactly that name
  const kept = translateQuery('Cottage cheese', { cache: new Map([[phraseKey('Cottage cheese'), 'קוטג 9%']]) });
  assert.deepEqual(kept.segments.map((x) => [x.variants[0], x.via]), [['קוטג 9%', 'ai']]);
});

test('exact and prefix rules: one product only, cut-off names, descriptions', () => {
  const p = (code, name, description = '') => ({ code, name, description });
  assert.equal(exactMatch('חלב 3%', [p('1', 'חלב 3%'), p('2', 'חלב 1%')]).code, '1');
  assert.equal(exactMatch('חלב 3%', [p('1', 'חלב 3%'), p('2', 'חלב 3%')]), null);                   // two products share the name
  assert.equal(exactMatch('קוטג 5% תנובה 250 גרם', [p('3', 'קוטג 5% תנובה', 'קוטג 5% תנובה 250 גרם')]).code, '3');   // the full description
  assert.equal(prefixMatch('מטליות לחות לרצפה פולי ווקס', [p('4', 'מטליות לחות לרצפה פו', 'מטליות לחות לרצפה פולי ווקס פרקט 70 יח')]).code, '4');   // item is the start of the description
  assert.equal(prefixMatch('מטליות לחות לרצפה פולי ווקס פרקט 70/40', [p('4', 'מטליות לחות לרצפה פו', '')]).code, '4');                              // product name was cut at 20 characters
  assert.equal(prefixMatch('מטליות לחות לרצפה', [p('4', 'מטליות לחות לרצפה פו', 'מטליות לחות לרצפה פולי'), p('5', 'מטליות לחות לרצפה גנ', 'מטליות לחות לרצפה גנרי')]), null);
  assert.equal(brandKey('אסם תעשיות בע"מ'), brandKey('אסם'));
  assert.notEqual(brandKey('תנובה'), brandKey('שטראוס'));
});

test('a name that is exactly a product\'s name is matched by itself, says so, and its barcode prices the other chains', async () => {
  const t = await boot();
  const lid = await t.mkList('Groceries');
  t.seed('stop_market', [MILK]); t.seed('rami_levy', [MILK_RAMI]);
  await t.select(lid, ['stop_market', 'rami_levy']);
  await t.want(lid, 'חלב תנובה 3% 1 ליטר');
  const c = await t.settle(lid);
  const stop = c.results.find((r) => r.chain === 'stop_market'), rami = c.results.find((r) => r.chain === 'rami_levy');
  assert.deepEqual([stop.lines[0].via, stop.lines[0].autoVia, stop.total], ['auto', 'name', 7.9]);
  assert.deepEqual([rami.lines[0].via, rami.total], ['barcode', 7.5]);             // the same barcode at the other chain: exact
  assert.deepEqual(c.matchGroups, []);                                             // nothing left to ask
  await t.close();
});

test('a generic name gets a pre-filled suggestion with alternatives; one tap accepts it; the user\'s own choices are never replaced; Shoppers cannot accept', async () => {
  const t = await boot();
  const lid = await t.mkList('Groceries');
  const rows = [MILK, ['7290000000004', 1, 'חלב סויה אלפרו 1 ליטר', '', 'אלפרו', 14, 0, 1, 'l'], ['7290000000005', 1, 'אורז בסמטי 1 ק"ג', '', 'סוגת', 12, 0, 1000, 'g'], COTTAGE];
  t.seed('stop_market', rows);
  await t.select(lid, ['stop_market']);
  const milk = await t.want(lid, 'חלב'), rice = await t.want(lid, 'אורז'), cheese = await t.want(lid, 'קוטג');
  const dana = await t.mkUser(lid, 'dana', 'viewer');
  let c = await t.settle(lid);
  const items = Object.fromEntries(c.matchGroups[0].items.map((i) => [i.name, i]));
  assert.ok(items['חלב'].guess.product.name.startsWith('חלב'), 'a milk is suggested');
  assert.ok(items['חלב'].guess.alts.length >= 1, 'with the other milk as an alternative');
  assert.ok(['likely', 'guess'].includes(items['חלב'].guess.tier));
  assert.equal(c.results[0].priced, 0, 'a suggestion is not applied until accepted');

  // the user has already chosen for the rice: it is left alone
  await t.call('PUT', `${M}/lists/${lid}/items/${rice}/match`, { chain: 'stop_market', none: true }, t.ck);
  assert.equal((await t.call('POST', `${M}/lists/${lid}/matches/accept`, { chain: 'stop_market' }, dana.cookie)).status, 403);   // a Shopper may not
  const r = await t.call('POST', `${M}/lists/${lid}/matches/accept`, { chain: 'stop_market' }, t.ck);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, 2);                                                // milk and cottage cheese; the rice is the user's own "not sold"
  c = await t.settle(lid);
  assert.deepEqual(c.results[0].lines.map((l) => [l.name, l.via]).sort(), [['חלב', 'confirmed'], ['קוטג', 'confirmed']]);
  assert.equal(c.results[0].notSold.length, 1);
  assert.equal(c.matchGroups.length, 0);
  // accepting again changes nothing
  assert.equal((await t.call('POST', `${M}/lists/${lid}/matches/accept`, { chain: 'stop_market' }, t.ck)).body.accepted, 0);
  void milk; void cheese;
  await t.close();
});

test('an item typed in English is searched in Hebrew, shown as such, and offered as a guess (never applied)', async () => {
  const t = await boot();
  const lid = await t.mkList('Groceries');
  t.seed('stop_market', [MILK, COTTAGE]);
  await t.select(lid, ['stop_market']);
  const id = await t.want(lid, 'Cottage cheese');
  const c = await t.settle(lid);
  const g = c.matchGroups[0].items[0].guess;
  assert.equal(g.product.name, 'קוטג 5% תנובה');
  assert.equal(g.tier, 'guess');
  assert.match(g.searched, /קוטג/);
  assert.equal(c.results[0].priced, 0);
  // the match panel searches the same way and says how
  const m = (await t.call('GET', `${M}/lists/${lid}/items/${id}/match?chain=stop_market`, undefined, t.ck)).body;
  assert.equal(m.candidates[0].code, COTTAGE[0]);
  assert.match(m.searchedAs, /קוטג/);
  await t.close();
});

test('the product\'s long description is stored and used; a product name cut at 20 characters is found from the full name', async () => {
  const t = await boot();
  const lid = await t.mkList('Groceries');
  t.seed('stop_market', [CUT, ['7290000000009', 1, 'מטליות לחות לרצפה פו', 'מטליות לחות לרצפה פוליש 40 יח', 'סנו', 9, 0, 40, 'item']]);
  await t.select(lid, ['stop_market']);
  await t.want(lid, 'מטליות לחות לרצפה פולי ווקס פרקט 70 יח');                      // the household's own full name
  const c = await t.settle(lid);
  assert.deepEqual([c.results[0].lines[0].via, c.results[0].lines[0].autoVia, c.results[0].lines[0].product.code], ['auto', 'name', CUT[0]]);
  await t.close();
});

test('AI translation is off without a key (nothing is sent), asks once per name with a key, sends only the names, and never shows the key', async () => {
  const calls = [];
  const translate = async ({ provider, apiKey, phrases }) => { calls.push({ provider, apiKey, phrases }); return new Map(phrases.map((p) => [p, 'חלב'])); };
  const t = await boot({ moduleOptions: { ai: { translate } } });
  const lid = await t.mkList('Groceries');
  t.seed('stop_market', [MILK]);
  await t.select(lid, ['stop_market']);
  await t.want(lid, 'Zorbleflex');
  let c = await t.settle(lid);
  assert.deepEqual([c.ai.enabled, calls.length, c.matchGroups[0].items[0].guess?.product ?? null], [false, 0, null]);   // no key: no call, no guess

  assert.equal((await t.call('PUT', `${M}/ai/settings`, { provider: 'nope', apiKey: 'k' }, t.ck)).status, 400);
  const saved = await t.call('PUT', `${M}/ai/settings`, { provider: 'anthropic', apiKey: 'sk-secret-123' }, t.ck);
  assert.deepEqual(saved.body.settings, { provider: 'anthropic', hasKey: true });
  assert.ok(!JSON.stringify((await t.call('GET', `${M}/ai/settings`, undefined, t.ck)).body).includes('sk-secret'), 'the key is never returned');
  assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM ai_settings').all()).includes('sk-secret'), 'and it is stored encrypted');

  c = await t.settle(lid);
  await new Promise((r) => setTimeout(r, 30));
  c = await t.settle(lid);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].phrases, ['zorbleflex']);                              // only the name, once
  assert.equal(calls[0].apiKey, 'sk-secret-123');
  assert.equal(c.matchGroups[0].items[0].guess.product.name, 'חלב תנובה 3% 1 ליטר');
  await t.settle(lid); await t.settle(lid);
  assert.equal(calls.length, 1, 'remembered: the same name is not asked again');

  // a provider error is reported, not thrown, and the key can be removed
  const t2 = await boot({ moduleOptions: { ai: { translate: async () => { throw new Error('ai_http_401'); } } } });
  const l2 = await t2.mkList('G'); t2.seed('stop_market', [MILK]); await t2.select(l2, ['stop_market']); await t2.want(l2, 'Zorbleflex');
  await t2.call('PUT', `${M}/ai/settings`, { provider: 'openai', apiKey: 'sk-x' }, t2.ck);
  await t2.compare(l2); await new Promise((r) => setTimeout(r, 30));
  assert.equal((await t2.compare(l2)).ai.error, 'ai_http_401');
  assert.deepEqual((await t2.call('PUT', `${M}/ai/settings`, { apiKey: '' }, t2.ck)).body.settings.hasKey, false);
  await t.close(); await t2.close();
});

test('upgrading re-reads the price files once, so the descriptions are filled before the next daily file, and then skips the same file as before', async () => {
  let svc;
  const t = await boot({ moduleOptions: { expose: (x) => { svc = x; } } });
  const FILE = 'PriceFull7290639000004-001-002-20261111-010000.gz';
  const xml = '<Root><Items><Item><PriceUpdateTime>2026-11-11 10:00</PriceUpdateTime><ItemCode>7290000000001</ItemCode><ItemType>1</ItemType><ItemName>חלב תנובה</ItemName><ManufactureName>תנובה</ManufactureName>'
    + '<ManufactureItemDescription>חלב תנובה 3% בקבוק 1 ליטר</ManufactureItemDescription><UnitQty>ליטר</UnitQty><Quantity>1</Quantity><bIsWeighted>0</bIsWeighted><UnitOfMeasure>ליטר</UnitOfMeasure><QtyInPackage>1</QtyInPackage><ItemPrice>7.90</ItemPrice><UnitOfMeasurePrice>7.90</UnitOfMeasurePrice></Item></Items></Root>';
  let reads = 0;
  const access = { priceFullList: async () => [{ name: FILE }], priceFull: async () => { reads++; return { name: FILE, bytes: Buffer.from(xml, 'utf8') }; } };
  const chain = { id: 'stop_market' };
  // a database from before 1.5.0: today's file was read, without descriptions
  t.db.prepare("INSERT INTO branch_price_state(chain, store_id, file, file_stamp, items, checked_at, updated_at, desc_ok) VALUES ('stop_market','2',?,?,?,?,?,0)").run(FILE, '20261111010000', 1, Date.now(), Date.now());
  const first = await svc.prices.refreshOne(access, chain, '2');
  assert.deepEqual([first.ok, first.skipped ?? null, reads], [true, null, 1]);                      // read again although the file is the same
  assert.equal(t.db.prepare('SELECT description FROM branch_prices WHERE code = ?').get('7290000000001').description, 'חלב תנובה 3% בקבוק 1 ליטר');
  assert.equal(t.db.prepare("SELECT desc_ok FROM branch_price_state WHERE chain = 'stop_market'").get().desc_ok, 1);
  const second = await svc.prices.refreshOne(access, chain, '2');
  assert.deepEqual([second.skipped, reads], ['same_file', 1]);                                      // and then the same file is skipped as before
  await t.close();
});
