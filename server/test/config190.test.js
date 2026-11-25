import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { checkManifest } from '../src/modules/manifest.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };
const JPEG = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false });
  const call = async (method, url, body, cookie, headers) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(headers || {}), ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, text: res.body, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const put = (body) => call('PUT', '/api/admin/settings', body, admin.cookie);
  const list = async () => (await call('GET', '/api/admin/config/checkpoints', undefined, admin.cookie)).body.checkpoints;
  const get = async () => (await call('GET', '/api/admin/settings', undefined, admin.cookie)).body;
  return { app, call, admin, put, list, get, db: app.db, hid: admin.body.user.households[0].id };
}

test('1.9.0 settings: the new ones have ranges, bad values are refused, good ones are saved, the screen is told the ranges and the read-only server facts', async () => {
  const t = await boot();
  const g = await t.get();
  assert.equal(g.settings.max_image_mb, 12);
  assert.deepEqual([g.fields.max_image_mb.min, g.fields.max_image_mb.max], [1, 50]);
  assert.equal(g.server.version, t.app.coreVersion);
  assert.ok(g.server.dataDir && g.server.modulesDir);
  for (const bad of [{ max_image_mb: 0 }, { max_image_mb: 51 }, { rl_login_per_min: 1.5 }, { max_trip_lines: 'many' }, { default_currency: 'dollars' }, { default_language: 'xx' }, { registration_mode: 'whatever' }]) {
    assert.equal((await t.put(bad)).body?.error, 'invalid_value', JSON.stringify(bad));
  }
  assert.equal((await t.put({ max_image_mb: 20, rl_login_per_min: 5, default_currency: 'USD', invite_max_days: 30 })).status, 200);
  const s = (await t.get()).settings;
  assert.deepEqual([s.max_image_mb, s.rl_login_per_min, s.default_currency, s.invite_max_days], [20, 5, 'USD', 30]);
  assert.equal((await t.call('GET', '/api/me', undefined, t.admin.cookie)).body.user.currencyDefault, 'USD');
  await t.app.close();
});

test('1.9.0 checkpoints: one is saved automatically before a real change (not for no change); the old value is in it; the SMTP password never is', async () => {
  const t = await boot();
  assert.deepEqual(await t.list(), []);
  await t.put({ smtp: { host: 'mail.example.com', port: 587, user: 'u', pass: 'sup3r-secret-pw', from: 'a@b.co' } });
  await t.put({ registration_mode: 'open', max_csv_mb: 5 });
  await t.put({ registration_mode: 'open' });                                  // nothing changes: nothing is saved
  const cps = await t.list();
  assert.equal(cps.length, 2);
  assert.deepEqual(cps[0].keys.sort(), ['max_csv_mb', 'registration_mode']);
  assert.equal(cps[0].kind, 'auto');
  const snap = t.app.config.get(cps[0].id);
  assert.equal(snap.core.registration_mode, 'invite-only');                    // what it was before
  assert.equal(snap.core.max_csv_mb, 3);
  assert.equal(snap.core.smtp.host, 'mail.example.com');
  for (const row of t.db.prepare('SELECT data FROM config_checkpoints').all()) assert.equal(row.data.includes('sup3r-secret-pw'), false);
  assert.ok(snap.omitted.includes('smtp.pass'));
  await t.app.close();
});

test('1.9.0 restore from a checkpoint: preview changes nothing; restore puts the settings back, keeps the SMTP password, and saves a restore point so it can be undone', async () => {
  const t = await boot();
  await t.put({ smtp: { host: 'mail.example.com', port: 587, user: 'u', pass: 'sup3r-secret-pw', from: 'a@b.co' }, max_image_mb: 12 });
  const named = (await t.call('POST', '/api/admin/config/checkpoints', { name: 'Good setup' }, t.admin.cookie)).body.id;
  await t.put({ max_image_mb: 30, registration_mode: 'open', smtp: { host: 'other.example.com' } });
  const pv = await t.call('POST', '/api/admin/config/preview', { checkpointId: named }, t.admin.cookie);
  assert.deepEqual(pv.body.changes.map((c) => c.key).sort(), ['max_image_mb', 'registration_mode', 'smtp.host']);
  assert.equal((await t.get()).settings.max_image_mb, 30);                      // the preview wrote nothing
  const r = await t.call('POST', '/api/admin/config/restore', { checkpointId: named }, t.admin.cookie);
  assert.equal(r.status, 200);
  const s = (await t.get()).settings;
  assert.deepEqual([s.max_image_mb, s.registration_mode, s.smtp.host], [12, 'invite-only', 'mail.example.com']);
  assert.equal(t.app.db.prepare("SELECT value FROM settings WHERE key = 'smtp'").get().value.includes('sup3r-secret-pw'), true);   // the password the server had stays
  const restorePoint = (await t.list()).find((c) => c.id === r.body.restorePointId);
  assert.equal(restorePoint.kind, 'restore');
  assert.equal(t.app.config.get(restorePoint.id).core.max_image_mb, 30);        // the settings from before the restore are kept, so it can be undone
  assert.equal((await t.call('POST', '/api/admin/config/restore', { checkpointId: named }, t.admin.cookie)).body.restorePointId, null);   // same as now: nothing to do, nothing saved
  assert.equal((await t.call('POST', '/api/admin/config/restore', { checkpointId: restorePoint.id }, t.admin.cookie)).status, 200);
  assert.equal((await t.get()).settings.max_image_mb, 30);                       // undone
  assert.equal((await t.call('POST', '/api/admin/config/preview', { checkpointId: 99999 }, t.admin.cookie)).status, 404);
  await t.app.close();
});

test('1.9.0 checkpoints: named ones are kept and can be deleted; only the newest 30 automatic ones are kept', async () => {
  const t = await boot();
  const id = (await t.call('POST', '/api/admin/config/checkpoints', { name: 'Keep me' }, t.admin.cookie)).body.id;
  for (let i = 0; i < 34; i++) await t.put({ max_csv_mb: i % 2 ? 4 : 5 });
  const cps = await t.list();
  assert.equal(cps.filter((c) => c.kind === 'auto').length, 30);
  assert.ok(cps.some((c) => c.id === id && c.name === 'Keep me'));
  assert.equal((await t.call('DELETE', `/api/admin/config/checkpoints/${id}`, undefined, t.admin.cookie)).status, 200);
  assert.equal((await t.call('DELETE', `/api/admin/config/checkpoints/${id}`, undefined, t.admin.cookie)).status, 404);
  await t.app.close();
});

test('1.9.0 file: the download is a versioned JSON without the SMTP password; restoring it works; unknown, invalid and missing things are skipped and said; a wrong or newer file is refused', async () => {
  const t = await boot();
  await t.put({ smtp: { host: 'mail.example.com', port: 587, user: 'u', pass: 'sup3r-secret-pw', from: 'a@b.co' }, max_image_mb: 15 });
  const dl = await t.call('GET', '/api/admin/config/export', undefined, t.admin.cookie);
  assert.equal(dl.status, 200);
  assert.equal(dl.text.includes('sup3r-secret-pw'), false);
  const file = dl.body;
  assert.deepEqual([file.format, file.formatVersion, file.omitted], ['shoplist-config', 1, ['smtp.pass']]);
  assert.equal(typeof file.core.max_image_mb, 'number');
  assert.equal('pass' in file.core.smtp, false);

  await t.put({ max_image_mb: 40 });
  const edited = { ...file, core: { ...file.core, no_such_setting: 1, max_csv_mb: 999 }, modules: { ...file.modules, 'ghost-module': { enabled: true, settings: { a: 1 } } } };
  const pv = (await t.call('POST', '/api/admin/config/preview', { data: edited }, t.admin.cookie)).body;
  assert.ok(pv.changes.some((c) => c.key === 'max_image_mb'));
  assert.deepEqual(pv.skipped.map((x) => [x.key, x.reason]).sort(), [['max_csv_mb', 'invalid_value'], ['module:ghost-module', 'module_not_installed'], ['no_such_setting', 'unknown_setting']]);
  assert.equal((await t.call('POST', '/api/admin/config/restore', { data: edited }, t.admin.cookie)).status, 200);
  assert.equal((await t.get()).settings.max_image_mb, 15);
  assert.equal((await t.get()).settings.max_csv_mb, 3);                            // the invalid value was not applied

  assert.equal((await t.call('POST', '/api/admin/config/preview', { data: { hello: 1 } }, t.admin.cookie)).body.error, 'not_a_config_file');
  assert.equal((await t.call('POST', '/api/admin/config/preview', { data: { ...file, formatVersion: 2 } }, t.admin.cookie)).body.error, 'config_too_new');
  assert.equal((await t.call('POST', '/api/admin/config/preview', {}, t.admin.cookie)).body.error, 'not_a_config_file');
  await t.app.close();
});

test('1.9.0 everything under Admin → Configuration is for the admin only', async () => {
  const t = await boot();
  const r = await t.call('POST', '/api/admin/users', { name: 'dana', username: 'dana', householdId: t.hid }, t.admin.cookie);
  const login = await t.call('POST', '/api/auth/login', { login: 'dana', password: r.body.oneTimePassword });
  await t.call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
  for (const [m, u, b] of [['GET', '/api/admin/config/checkpoints'], ['POST', '/api/admin/config/checkpoints', {}], ['GET', '/api/admin/config/export'], ['POST', '/api/admin/config/preview', {}], ['POST', '/api/admin/config/restore', {}], ['DELETE', '/api/admin/config/checkpoints/1']]) {
    assert.equal((await t.call(m, u, b, login.cookie)).status, 403, `${m} ${u}`);
  }
  await t.app.close();
});

test('1.9.0 module configuration: a module\'s declared settings are in the snapshot with their defaults, changing them takes one checkpoint, and a restore brings them and the on/off switch back', async () => {
  const t = await boot();
  const mod = 'barcode-scan';
  assert.equal((await t.call('POST', `/api/admin/modules/${mod}/enable`, {}, t.admin.cookie)).status, 200, 'barcode-scan is installed and can be switched on');
  assert.deepEqual(t.app.config.snapshot().modules[mod].settings, { scan_per_min: 180, repeat_seconds: 4, save_price: true, auto_category: true });
  const before = (await t.list()).length;
  const set = await t.call('PUT', `/api/m/${mod}/admin/settings`, { scanPerMin: 50, repeatSeconds: 9, savePrice: false, autoCategory: false }, t.admin.cookie);
  assert.equal(set.status, 200);
  const cps = await t.list();
  assert.equal(cps.length, before + 1);                                              // four keys, one checkpoint
  assert.equal(t.app.config.get(cps[0].id).modules[mod].settings.scan_per_min, 180);
  assert.equal((await t.call('PUT', `/api/m/${mod}/admin/settings`, { scanPerMin: 5 }, t.admin.cookie)).body.error, 'invalid_value');

  const file = (await t.call('GET', '/api/admin/config/export', undefined, t.admin.cookie)).body;     // the settings as they are now (50, 9, off, off), module on
  await t.call('PUT', `/api/m/${mod}/admin/settings`, { scanPerMin: 300 }, t.admin.cookie);
  const nBefore = (await t.list()).length;
  await t.call('POST', `/api/admin/modules/${mod}/disable`, {}, t.admin.cookie);
  const afterOff = await t.list();
  assert.equal(afterOff.length, nBefore + 1);                                           // switching a module off takes a checkpoint too
  assert.deepEqual(afterOff[0].keys, [`module:${mod}:enabled`]);
  assert.equal(t.app.config.get(afterOff[0].id).modules[mod].enabled, true);            // with the module still on in it
  const r = await t.call('POST', '/api/admin/config/restore', { data: file }, t.admin.cookie);
  assert.equal(r.status, 200);
  assert.equal(t.app.modules.row(mod).enabled, 1);                                    // switched back on
  assert.deepEqual(t.app.modules.readConfig(mod), { scan_per_min: 50, repeat_seconds: 9, save_price: false, auto_category: false });
  assert.ok(r.body.changes.some((c) => c.key === `module:${mod}:enabled`));
  await t.app.close();
});

test('1.9.0 a module manifest may declare config; a bad declaration is refused', () => {
  const base = { id: 'x-mod', name: 'X', version: '1.0.0', kind: 'feature', server: 'server/index.js' };
  const ok = checkManifest({ ...base, config: { a_b: { type: 'int', min: 1, max: 5, default: 2 }, c: { type: 'bool', default: false }, d: { type: 'enum', values: ['x', 'y'], default: 'y' } } }, '1.9.0');
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.manifest.config), ['a_b', 'c', 'd']);
  for (const config of [{ a: { type: 'int', min: 1, max: 5, default: 9 } }, { A: { type: 'bool', default: true } }, { a: { type: 'text', default: '' } }, { a: { type: 'enum', values: [], default: '' } }, []]) {
    assert.equal(checkManifest({ ...base, config }, '1.9.0').ok, false, JSON.stringify(config));
  }
});

test('1.9.0 limits: the admin\'s sizes and counts are enforced (receipt photo, CSV, trip lines, invites)', async () => {
  const t = await boot();
  const lid = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Groceries' }, t.admin.cookie)).body.id;
  const photo = (n) => t.call('POST', `/api/lists/${lid}/receipt-read`, JPEG(n), t.admin.cookie, { 'content-type': 'image/jpeg' });
  await t.put({ max_image_mb: 1 });
  assert.equal((await photo(1.5 * 1024 * 1024)).body.error, 'file_too_large');
  assert.notEqual((await photo(1000)).body?.error, 'file_too_large');                  // under the limit it gets further (no reader here: another error)
  await t.put({ max_image_mb: 3 });
  assert.notEqual((await photo(1.5 * 1024 * 1024)).body?.error, 'file_too_large');     // raised: allowed

  await t.put({ max_csv_mb: 1 });
  const big = `name\n${'x'.repeat(1.2 * 1024 * 1024)}\n`;
  const imp = await t.call('POST', `/api/lists/${lid}/items/import`, { csv: big, apply: false }, t.admin.cookie);
  assert.equal(imp.body.error, 'file_too_large');

  await t.put({ max_trip_lines: 10 });
  const lines = (n) => Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, quantity: 1, unitPrice: 1 }));
  assert.equal((await t.call('POST', `/api/lists/${lid}/trips`, { lines: lines(11) }, t.admin.cookie)).body.error, 'too_many_lines');
  assert.equal((await t.call('POST', `/api/lists/${lid}/trips`, { lines: lines(10) }, t.admin.cookie)).status, 200);

  await t.put({ invite_default_days: 2, invite_max_days: 5, invite_max_uses: 3 });
  const inv = (b) => t.call('POST', '/api/invites', { householdId: t.hid, ...b }, t.admin.cookie);
  const row = () => t.db.prepare('SELECT expires_at, max_uses FROM invites ORDER BY id DESC LIMIT 1').get();
  await inv({});
  assert.equal(Math.round((row().expires_at - Date.now()) / 86400000), 2);
  await inv({ expiresInDays: 90, maxUses: 50 });
  assert.deepEqual([Math.round((row().expires_at - Date.now()) / 86400000), row().max_uses], [5, 3]);
  await t.app.close();
});

test('1.9.0 rate limits: the admin\'s number is used at once, without a restart', async () => {
  const t = await boot();
  const login = () => t.call('POST', '/api/auth/login', { login: 'nobody', password: 'wrong-password' });
  await t.put({ rl_login_per_min: 2 });
  assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 429);
  await t.app.close();
});
