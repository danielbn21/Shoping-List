import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildApp } from '../../../server/src/app.js';
import { norm } from '../server/matching.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
export const M = '/api/m/price-compare';
export const CH = { stop_market: '2', rami_levy: '1', carrefour: '2', shufersal: '756' };

// An app with the price-compare module, a household, and price rows put straight into the module's database (no portals involved).
export async function boot({ moduleOptions = {} } = {}) {
  const app = await buildApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sl-')), logger: false, moduleOptions: { 'price-compare': moduleOptions } });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id, ck = admin.cookie;
  const db = app.modules.loaded.get('price-compare').db;
  const mkList = async (name) => (await call('POST', '/api/lists', { householdId: hid, name }, ck)).body.id;
  const mkUser = async (lid, username, role) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, ck);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    await call('PUT', `/api/lists/${lid}/members/${r.body.id}`, { role }, ck);
    return { id: r.body.id, cookie: login.cookie };
  };
  const ins = db.prepare('INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, unit_price, unit, unit_per, pack_amount, pack_unit, weighted, price_updated, seen_file, description, desc_norm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  // rows: [code, itemType, name, description, manufacturer, price, weighted, packAmount, packUnit, unitPrice]
  const seed = (chain, rows, store = CH[chain]) => {
    db.transaction(() => {
      for (const [code, itemType, name, description, manufacturer, price, weighted, packAmount, packUnit, unitPrice] of rows) {
        ins.run(chain, store, code, itemType ?? 1, name, norm(name), manufacturer ?? '', price, unitPrice ?? null, '', 0, packAmount ?? null, packUnit ?? null, weighted ? 1 : 0, null, '20261111000000', description ?? '', norm(description ?? ''));
      }
      db.prepare('INSERT OR REPLACE INTO branch_price_state(chain, store_id, file, file_stamp, items, checked_at, updated_at, desc_ok) VALUES (?,?,?,?,?,?,?,1)').run(chain, store, 'f', '20261111000000', rows.length, Date.now(), Date.now());
      db.prepare('INSERT OR REPLACE INTO portal_branches(chain, store_id, name, city_key) VALUES (?,?,?,?)').run(chain, store, `branch ${store}`, '1');
    })();
  };
  const select = async (lid, chains) => (await call('PUT', `${M}/lists/${lid}/stores`, { selection: chains.map((c) => ({ chain: c, branchId: CH[c] })) }, ck)).status;
  const want = async (lid, name, quantity = 1) => { await call('POST', `/api/lists/${lid}/entries`, { name, quantity }, ck); return app.db.prepare('SELECT id FROM items WHERE household_id = ? AND name = ?').get(hid, name).id; };
  const compare = (lid, cookie = ck) => call('GET', `${M}/lists/${lid}/compare`, undefined, cookie).then((r) => r.body);
  // the guessing is done a little at a time: ask until nothing is pending
  const settle = async (lid, cookie = ck) => { let c; for (let i = 0; i < 80; i++) { c = await compare(lid, cookie); if (!c.guessing.pending && !c.ai?.running) break; await new Promise((r) => setTimeout(r, 5)); } return c; };
  const importCsv = async (lid, rows) => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = 'name,category,default_note,price,quantity\n' + rows.map((r) => [r.name, r.category, '', r.price ?? '', 1].map(q).join(',')).join('\n');
    return call('POST', `/api/lists/${lid}/items/import`, { csv, apply: true }, ck);
  };
  return { app, call, admin, hid, ck, db, mkList, mkUser, seed, select, want, compare, settle, importCsv, close: () => app.close() };
}

export const loadFixture = () => {
  const dir = new URL('./fixtures/real/', import.meta.url);
  return { items: JSON.parse(fs.readFileSync(new URL('items.json', dir), 'utf8')), prices: JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('prices.json.gz', dir))).toString('utf8')) };
};
