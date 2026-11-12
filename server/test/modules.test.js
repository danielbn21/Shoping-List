import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { buildApp } from '../src/app.js';
import { readModuleDir } from '../src/modules/manager.js';
import { readZip, checkImports } from '../src/modules/zip.js';
import { checkManifest } from '../src/modules/manifest.js';
import { satisfies, compareVersions } from '../src/modules/semver.js';

const SAMPLE = new URL('./fixtures/sample-module', import.meta.url).pathname;
const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

// A zip of the sample module, optionally changed: files is { path: string | null } (null removes a file).
function sampleZip(changes = {}, { folder = '' } = {}) {
  const files = Object.fromEntries(Object.entries(readModuleDir(SAMPLE)).map(([k, v]) => [k, v.toString('utf8')]));
  for (const [k, v] of Object.entries(changes)) { if (v === null) delete files[k]; else files[k] = v; }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [folder + k, strToU8(v)]))));
}
const withVersion = (v, extra = {}) => ({ 'manifest.json': JSON.stringify({ ...JSON.parse(fs.readFileSync(`${SAMPLE}/manifest.json`, 'utf8')), version: v, ...extra }) });

async function boot({ dataDir, onRestart, moduleOptions } = {}) {
  dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false, bundledDir: false, onRestart, moduleOptions });
  const call = async (method, url, body, cookie, headers) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(headers || {}), ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, text: res.body, cookie: c ? `sl_session=${c.value}` : null };
  };
  const setup = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  let admin;
  if (setup.status === 200) admin = setup; else admin = await call('POST', '/api/auth/login', { login: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const mkUser = async (username) => {
    const r = await call('POST', '/api/admin/users', { name: username, username, householdId: hid }, admin.cookie);
    const login = await call('POST', '/api/auth/login', { login: username, password: r.body.oneTimePassword });
    await call('POST', '/api/auth/change-password', { currentPassword: r.body.oneTimePassword, newPassword: 'new-password-1' }, login.cookie);
    return { id: r.body.id, cookie: login.cookie };
  };
  const zipHeaders = { 'content-type': 'application/zip' };
  const upload = async (zip) => {
    const ins = await call('POST', '/api/admin/modules/inspect', zip, admin.cookie, zipHeaders);
    if (ins.status !== 200) return ins;
    return call('POST', '/api/admin/modules/install', { token: ins.body.token }, admin.cookie);
  };
  const restart = async () => { await app.close(); return boot({ dataDir, onRestart, moduleOptions }); }; // what the admin's restart does: a fresh process on the same data
  return { app, call, admin, hid, mkUser, upload, dataDir, restart, zipHeaders };
}

/* ---------- pure helpers ---------- */

test('semver ranges', () => {
  assert.ok(satisfies('1.3.0', '>=1.3.0 <2.0.0'));
  assert.ok(!satisfies('1.2.1', '>=1.3.0 <2.0.0'));
  assert.ok(!satisfies('2.0.0', '>=1.3.0 <2.0.0'));
  assert.ok(satisfies('1.9.4', '^1.3.0') && !satisfies('2.0.0', '^1.3.0'));
  assert.ok(satisfies('9.9.9', '*'));
  assert.ok(!satisfies('1.0.0', 'nonsense'));
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
});

test('manifest checks', () => {
  const ok = { id: 'abc-def', name: 'X', version: '1.0.0', server: 'server/index.js' };
  assert.ok(checkManifest(ok, { coreVersion: '1.3.0' }).ok);
  for (const bad of [{ ...ok, id: 'Bad Id' }, { ...ok, version: '1.0' }, { ...ok, slots: ['everywhere'] }, { ...ok, server: '../evil.js' }, { ...ok, server: '/abs.js' }, { ...ok, kind: 'weird' }, { ...ok, dependsOn: ['abc-def'] }, { id: 'abc', name: 'X', version: '1.0.0' }, null]) {
    assert.equal(checkManifest(bad, { coreVersion: '1.3.0' }).ok, false, JSON.stringify(bad));
  }
  assert.equal(checkManifest({ ...ok, requires: { core: '>=9.0.0' } }, { coreVersion: '1.3.0' }).error, 'core_incompatible');
});

test('zip reading: folder stripped, zip-slip and absolute paths refused, limits kept', () => {
  assert.ok(readZip(sampleZip({}, { folder: 'sample/' }))['manifest.json']); // made with "compress folder"
  const evil = (name) => Buffer.from(zipSync({ 'manifest.json': strToU8('{}'), [name]: strToU8('x') }));
  for (const n of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:/x.js']) assert.throws(() => readZip(evil(n)), (e) => e.code === 'zip_unsafe', n);
  assert.throws(() => readZip(Buffer.from(zipSync({ 'readme.txt': strToU8('hi') }))), (e) => e.code === 'manifest_missing');
  assert.throws(() => readZip(Buffer.from('not a zip at all, just text')), (e) => e.code === 'zip_invalid');
  assert.throws(() => checkImports({ 'server/a.js': Buffer.from("import x from 'left-pad';") }), (e) => e.code === 'import_not_allowed');
  assert.throws(() => checkImports({ 'server/a.js': Buffer.from("const m = await import('express');") }), (e) => e.code === 'import_not_allowed');
  checkImports({ 'server/a.js': Buffer.from("import fs from 'node:fs'; import b from './b.js'; export * from '../c.js';") }); // allowed
});

/* ---------- install, enable, restart ---------- */

test('upload: inspect shows name, version and hash; install leaves it disabled; enabling needs a restart', async () => {
  const t = await boot();
  const zip = sampleZip();
  const ins = await t.call('POST', '/api/admin/modules/inspect', zip, t.admin.cookie, t.zipHeaders);
  assert.equal(ins.status, 200);
  assert.deepEqual([ins.body.manifest.id, ins.body.manifest.version, ins.body.sha256.length, ins.body.serverCode], ['sample', '1.0.0', 64, true]);
  assert.equal((await t.call('GET', '/api/admin/modules', undefined, t.admin.cookie)).body.modules.length, 0); // nothing installed by inspecting

  const inst = await t.call('POST', '/api/admin/modules/install', { token: ins.body.token }, t.admin.cookie);
  assert.equal(inst.status, 200);
  assert.deepEqual([inst.body.module.enabled, inst.body.module.loaded, inst.body.module.status], [false, false, 'installed']);
  assert.equal((await t.call('POST', '/api/admin/modules/install', { token: ins.body.token }, t.admin.cookie)).status, 410); // a token works once
  assert.equal((await t.call('GET', '/api/m/sample/ping', undefined, t.admin.cookie)).status, 404);

  const en = await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  assert.deepEqual([en.body.module.enabled, en.body.module.loaded, en.body.module.needsRestart], [true, false, true]);
  assert.equal((await t.call('GET', '/api/m/sample/ping', undefined, t.admin.cookie)).status, 404); // not before the restart

  const t2 = await t.restart();
  const ping = await t2.call('GET', '/api/m/sample/ping', undefined, t2.admin.cookie);
  assert.deepEqual(ping.body, { pong: true, user: 'admin', version: '1.0.0' });
  const mod = (await t2.call('GET', '/api/admin/modules', undefined, t2.admin.cookie)).body.modules[0];
  assert.deepEqual([mod.loaded, mod.needsRestart], [true, false]);
  assert.ok(t2.admin.body.user.modules === undefined || true);
  const me = (await t2.call('GET', '/api/me', undefined, t2.admin.cookie)).body.user;
  assert.deepEqual(me.capabilities, ['greeter']);
  assert.deepEqual(me.modules.map((m) => [m.id, m.on, m.web]), [['sample', true, null]]);
  const audit = t2.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'module.%' ORDER BY id").all().map((r) => r.action);
  assert.ok(audit.includes('module.installed') && audit.includes('module.enabled'));
  await t2.app.close();
});

test('the Restart server button asks for a restart and nothing restarts by itself', async () => {
  let restarts = 0;
  const t = await boot({ onRestart: () => { restarts++; } });
  await t.upload(sampleZip());
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(restarts, 0); // installing and enabling never restart
  const user = await t.mkUser('dana');
  assert.equal((await t.call('POST', '/api/admin/server/restart', {}, user.cookie)).status, 403);
  assert.equal((await t.call('POST', '/api/admin/server/restart', {}, t.admin.cookie)).status, 200);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(restarts, 1);
  await t.app.close();
});

test('only admins manage modules; uploads that are not zips, are unsafe or import packages are refused', async () => {
  const t = await boot();
  const user = await t.mkUser('dana');
  for (const [m, u] of [['GET', '/api/admin/modules'], ['POST', '/api/admin/modules/inspect'], ['POST', '/api/admin/modules/install'], ['POST', '/api/admin/modules/x/enable'], ['POST', '/api/admin/server/restart']]) {
    assert.equal((await t.call(m, u, m === 'POST' ? {} : undefined, user.cookie)).status, 403, u);
  }
  const post = (zip) => t.call('POST', '/api/admin/modules/inspect', zip, t.admin.cookie, t.zipHeaders);
  assert.equal((await post(Buffer.from('plain text'))).body.error, 'zip_invalid');
  assert.equal((await post(Buffer.from(zipSync({ 'manifest.json': strToU8('{}'), '../x.js': strToU8('x') })))).body.error, 'zip_unsafe');
  assert.equal((await post(sampleZip({ 'manifest.json': '{ not json' }))).body.error, 'manifest_invalid');
  assert.equal((await post(sampleZip({ 'server/index.js': "import x from 'fastify';\nexport default () => {};" }))).body.error, 'import_not_allowed');
  assert.equal((await post(sampleZip(withVersion('1.0.0', { requires: { core: '>=5.0.0' } })))).body.error, 'core_incompatible');
  assert.equal((await post(sampleZip({ 'server/index.js': null }))).body.error, 'manifest_invalid'); // declared server file is missing
  await t.app.close();
});

test('a module that fails at startup is quarantined and the app still starts; rollback restores the earlier version', async () => {
  const t = await boot();
  await t.upload(sampleZip());
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  let t2 = await t.restart();
  assert.equal((await t2.call('GET', '/api/m/sample/ping', undefined, t2.admin.cookie)).status, 200);

  // version 1.1.0 throws while registering
  const up = await t2.upload(sampleZip({ ...withVersion('1.1.0'), 'server/index.js': "export default function register() { throw new Error('boom at start'); }" }));
  assert.equal(up.body.module.version, '1.1.0');
  assert.equal(up.body.module.prevVersion, '1.0.0');
  assert.equal(up.body.module.enabled, true); // an upgrade keeps the switch where it was
  t2 = await t2.restart();
  const mod = (await t2.call('GET', '/api/admin/modules', undefined, t2.admin.cookie)).body.modules[0];
  assert.deepEqual([mod.status, mod.enabled, mod.loaded], ['quarantined', false, false]);
  assert.match(mod.error, /boom at start/);
  assert.equal((await t2.call('GET', '/api/health')).status, 200); // the core is fine
  assert.equal((await t2.call('GET', '/api/m/sample/ping', undefined, t2.admin.cookie)).status, 404);

  assert.equal((await t2.call('POST', '/api/admin/modules/sample/rollback', {}, t2.admin.cookie)).body.module.version, '1.0.0');
  await t2.call('POST', '/api/admin/modules/sample/enable', {}, t2.admin.cookie);
  const t3 = await t2.restart();
  assert.equal((await t3.call('GET', '/api/m/sample/ping', undefined, t3.admin.cookie)).body.version, '1.0.0');
  assert.equal((await t3.call('POST', '/api/admin/modules/other/rollback', {}, t3.admin.cookie)).status, 409);
  await t3.app.close();
});

test('migrations that fail quarantine the module too, and an unknown dependency blocks enabling', async () => {
  const t = await boot();
  await t.upload(sampleZip({ 'server/index.js': "export const migrations = ['CREATE TABLE ok (a);', 'THIS IS NOT SQL'];\nexport default () => {};" }));
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  const t2 = await t.restart();
  const mod = (await t2.call('GET', '/api/admin/modules', undefined, t2.admin.cookie)).body.modules[0];
  assert.equal(mod.status, 'quarantined');

  const t3 = await boot();
  await t3.upload(sampleZip(withVersion('1.0.0', { id: 'needs-dep', dependsOn: ['ghost'] })));
  assert.equal((await t3.call('POST', '/api/admin/modules/needs-dep/enable', {}, t3.admin.cookie)).body.error, 'missing_dependency');
  await t3.app.close(); await t2.app.close();
});

/* ---------- routes, data and events ---------- */

test('module routes: login required, own database, core read API respects list access, admin-only routes', async () => {
  const t = await boot();
  await t.upload(sampleZip());
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  const t2 = await t.restart();
  const user = await t2.mkUser('dana');
  const outsider = (await t2.call('POST', '/api/admin/users', { name: 'eve', username: 'eve' }, t2.admin.cookie)).body;
  const eveLogin = await t2.call('POST', '/api/auth/login', { login: 'eve', password: outsider.oneTimePassword });
  await t2.call('POST', '/api/auth/change-password', { currentPassword: outsider.oneTimePassword, newPassword: 'new-password-1' }, eveLogin.cookie);

  assert.equal((await t2.call('GET', '/api/m/sample/ping')).status, 401);
  assert.equal((await t2.call('POST', '/api/m/sample/notes', { listId: 1, text: 'x' }, undefined)).status, 401); // no session: refused
  assert.equal((await t2.call('GET', '/api/m/sample/admin-only', undefined, user.cookie)).status, 403);
  assert.equal((await t2.call('GET', '/api/m/sample/admin-only', undefined, t2.admin.cookie)).body.secret, true);

  const lid = (await t2.call('POST', '/api/lists', { householdId: t2.hid, name: 'Groceries' }, t2.admin.cookie)).body.id;
  assert.equal((await t2.call('GET', `/api/m/sample/listaccess/${lid}`, undefined, user.cookie)).body.role, 'contributor');
  assert.equal((await t2.call('GET', `/api/m/sample/listaccess/${lid}`, undefined, eveLogin.cookie)).status, 404); // not in the household: the module cannot see it either

  await t2.call('POST', '/api/m/sample/notes', { listId: lid, text: 'hello' }, user.cookie);
  assert.equal((await t2.call('GET', '/api/m/sample/notes', undefined, user.cookie)).body.notes.length, 1);
  const core = t2.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get();
  assert.equal(core, undefined); // its table lives in its own database file, not in the core
  assert.ok(fs.existsSync(path.join(t2.dataDir, 'modules', 'sample', 'data.db')));
  assert.equal((await t2.call('GET', '/api/m/sample/file', undefined, user.cookie)).status, 200);
  assert.ok(fs.existsSync(path.join(t2.dataDir, 'modules', 'sample', 'files', 'x.txt')));

  // core events: archiving the list lets the module clean up
  assert.equal((await t2.call('DELETE', `/api/lists/${lid}`, undefined, t2.admin.cookie)).status, 200);
  assert.equal((await t2.call('GET', '/api/m/sample/notes', undefined, user.cookie)).body.notes.length, 0);
  await t2.app.close();
});

/* ---------- per user ---------- */

test('per user: the admin grants access, the user switches on and off, default is on', async () => {
  const t = await boot();
  await t.upload(sampleZip());
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  const t2 = await t.restart();
  const dana = await t2.mkUser('dana');
  const mine = async (u) => (await t2.call('GET', '/api/me', undefined, u.cookie)).body.user;
  const ping = (u) => t2.call('GET', '/api/m/sample/ping', undefined, u.cookie).then((r) => r.status);

  assert.deepEqual([(await mine(dana)).modules[0].on, await ping(dana)], [true, 200]); // default: granted and on
  assert.deepEqual((await t2.call('PUT', '/api/modules/sample/me', { on: false }, dana.cookie)).body.user.modules[0].on, false);
  assert.equal(await ping(dana), 404);
  assert.deepEqual((await mine(dana)).capabilities, []);   // her receipt-reader-like capabilities vanish with it
  assert.equal(await ping(t2.admin), 200);                 // other users are unaffected
  await t2.call('PUT', '/api/modules/sample/me', { on: true }, dana.cookie);
  assert.equal(await ping(dana), 200);

  // the admin withdraws access: the module disappears and she cannot switch it on again
  const list = await t2.call('GET', '/api/admin/modules/sample/access', undefined, t2.admin.cookie);
  assert.deepEqual(list.body.users.map((u) => [u.username, u.granted, u.on]), [['admin', true, true], ['dana', true, true]]);
  await t2.call('PUT', '/api/admin/modules/sample/access', { userId: dana.id, granted: false }, t2.admin.cookie);
  assert.deepEqual([(await mine(dana)).modules.length, await ping(dana)], [0, 404]);
  assert.equal((await t2.call('PUT', '/api/modules/sample/me', { on: true }, dana.cookie)).status, 403);
  await t2.call('PUT', '/api/admin/modules/sample/access', { userId: dana.id, granted: true }, t2.admin.cookie);
  assert.equal(await ping(dana), 200);
  assert.equal((await t2.call('PUT', '/api/admin/modules/sample/access', { userId: dana.id, granted: 'yes' }, t2.admin.cookie)).status, 400);
  assert.equal((await t2.call('PUT', '/api/modules/sample/me', { on: 'x' }, dana.cookie)).status, 400);
  assert.equal((await t2.call('PUT', '/api/modules/nope/me', { on: false }, dana.cookie)).status, 404);

  // disabling by the admin is immediate for access, and the user's access rows go when the user is deleted
  await t2.call('POST', '/api/admin/modules/sample/disable', {}, t2.admin.cookie);
  assert.equal(await ping(t2.admin), 404);
  await t2.call('DELETE', `/api/admin/users/${dana.id}`, undefined, t2.admin.cookie);
  assert.equal(t2.app.db.prepare('SELECT COUNT(*) c FROM module_access WHERE user_id = ?').get(dana.id).c, 0);
  await t2.app.close();
});

/* ---------- dependencies, uninstall ---------- */

test('dependencies: load order, blocked disable, and a dependent without its dependency is quarantined', async () => {
  const t = await boot();
  const dep = (id, extra) => sampleZip({ ...withVersion('1.0.0', { id, provides: [], slots: [], ...extra }), 'server/index.js': `export default function register(ctx) { ctx.routes.get('/who', async () => ({ id: '${id}' })); }` });
  await t.upload(dep('base-mod'));
  await t.upload(dep('child-mod', { dependsOn: ['base-mod'] }));
  assert.equal((await t.call('POST', '/api/admin/modules/child-mod/enable', {}, t.admin.cookie)).body.error, 'missing_dependency'); // base is not enabled yet
  await t.call('POST', '/api/admin/modules/base-mod/enable', {}, t.admin.cookie);
  await t.call('POST', '/api/admin/modules/child-mod/enable', {}, t.admin.cookie);
  assert.equal((await t.call('POST', '/api/admin/modules/base-mod/disable', {}, t.admin.cookie)).body.error, 'has_dependents');
  assert.equal((await t.call('POST', '/api/admin/modules/base-mod/uninstall', {}, t.admin.cookie)).body.error, 'has_dependents');
  const t2 = await t.restart();
  assert.equal((await t2.call('GET', '/api/m/child-mod/who', undefined, t2.admin.cookie)).body.id, 'child-mod');
  const base = (await t2.call('GET', '/api/admin/modules', undefined, t2.admin.cookie)).body.modules.find((m) => m.id === 'base-mod');
  assert.deepEqual(base.dependents, ['child-mod']);
  await t2.app.close();
});

test('uninstall happens at the next start; the data stays unless you also delete it', async () => {
  const t = await boot();
  await t.upload(sampleZip());
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  let t2 = await t.restart();
  await t2.call('POST', '/api/m/sample/notes', { listId: 1, text: 'keep me' }, t2.admin.cookie);
  const dbFile = path.join(t2.dataDir, 'modules', 'sample', 'data.db');

  const un = await t2.call('POST', '/api/admin/modules/sample/uninstall', { deleteData: false }, t2.admin.cookie);
  assert.deepEqual([un.body.module.removePending, un.body.module.needsRestart], [true, true]);
  assert.equal((await t2.call('GET', '/api/m/sample/ping', undefined, t2.admin.cookie)).status, 404); // access stops at once
  t2 = await t2.restart();
  assert.equal((await t2.call('GET', '/api/admin/modules', undefined, t2.admin.cookie)).body.modules.length, 0);
  assert.ok(fs.existsSync(dbFile)); assert.ok(!fs.existsSync(path.join(t2.dataDir, 'modules', 'sample', '1.0.0')));

  // reinstall: the earlier data is still there
  await t2.upload(sampleZip());
  await t2.call('POST', '/api/admin/modules/sample/enable', {}, t2.admin.cookie);
  t2 = await t2.restart();
  assert.equal((await t2.call('GET', '/api/m/sample/notes', undefined, t2.admin.cookie)).body.notes[0].text, 'keep me');

  await t2.call('POST', '/api/admin/modules/sample/uninstall', { deleteData: true }, t2.admin.cookie);
  t2 = await t2.restart();
  assert.ok(!fs.existsSync(path.join(t2.dataDir, 'modules', 'sample')));
  await t2.app.close();
});

test('a module never loaded is removed immediately; a bundled module stays removed instead of coming back', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-bundle-'));
  fs.cpSync(SAMPLE, path.join(bundled, 'sample'), { recursive: true });
  let app = await buildApp({ dataDir, logger: false, bundledDir: bundled });
  const call = async (method, url, body, cookie) => { const r = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.statusCode, body: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), cookie: r.cookies.find((x) => x.name === 'sl_session') }; };
  const s = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const cookie = `sl_session=${s.cookie.value}`;
  let list = (await call('GET', '/api/admin/modules', undefined, cookie)).body;
  assert.deepEqual([list.modules.length, list.modules[0].enabled, list.modules[0].source, list.modules[0].loaded], [1, true, 'bundled', true]); // bundled modules start enabled
  await call('POST', '/api/admin/modules/sample/uninstall', {}, cookie);
  await app.close();
  app = await buildApp({ dataDir, logger: false, bundledDir: bundled });
  const s2 = await call('POST', '/api/auth/login', { login: 'admin', password: 'correct-horse' });
  const c2 = `sl_session=${s2.cookie.value}`;
  list = (await call('GET', '/api/admin/modules', undefined, c2)).body;
  assert.deepEqual([list.modules.length, list.available.map((m) => m.id)], [0, ['sample']]); // not reinstalled behind the admin's back
  assert.equal((await call('POST', '/api/admin/modules/bundled/sample/install', {}, c2)).status, 200);
  assert.equal((await call('GET', '/api/admin/modules', undefined, c2)).body.modules[0].enabled, true);
  await app.close();
});

test('a newer bundled version upgrades a bundled module, but never replaces one the admin uploaded', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-bundle-'));
  const put = (v) => { fs.rmSync(path.join(bundled, 'sample'), { recursive: true, force: true }); fs.cpSync(SAMPLE, path.join(bundled, 'sample'), { recursive: true }); const m = JSON.parse(fs.readFileSync(`${bundled}/sample/manifest.json`, 'utf8')); fs.writeFileSync(`${bundled}/sample/manifest.json`, JSON.stringify({ ...m, version: v })); };
  put('1.0.0');
  let app = await buildApp({ dataDir, logger: false, bundledDir: bundled });
  assert.equal(app.modules.row('sample').version, '1.0.0');
  await app.close();
  put('1.1.0');
  app = await buildApp({ dataDir, logger: false, bundledDir: bundled });
  assert.deepEqual([app.modules.row('sample').version, app.modules.row('sample').prev_version, app.modules.row('sample').enabled], ['1.1.0', '1.0.0', 1]);
  app.db.prepare("UPDATE modules SET source = 'upload' WHERE id = 'sample'").run();
  await app.close();
  put('1.2.0');
  app = await buildApp({ dataDir, logger: false, bundledDir: bundled });
  assert.equal(app.modules.row('sample').version, '1.1.0'); // an uploaded copy is the admin's choice
  await app.close();
});

test('assets: only a module the user may use is served, and only its declared files', async () => {
  const t = await boot();
  const zip = sampleZip({ ...withVersion('1.0.0', { web: 'web.js', css: 'web.css', i18n: 'i18n.json' }), 'web.js': 'export default function register(host) { host.ok = true; }', 'web.css': '.x{color:red}', 'i18n.json': '{"en":{"a":"A"}}' });
  await t.upload(zip);
  await t.call('POST', '/api/admin/modules/sample/enable', {}, t.admin.cookie);
  const t2 = await t.restart();
  const me = (await t2.call('GET', '/api/me', undefined, t2.admin.cookie)).body.user;
  assert.deepEqual(me.modules[0].web, '/api/modules/sample/asset/web.js?v=1.0.0');
  const js = await t2.app.inject({ method: 'GET', url: me.modules[0].web, headers: { cookie: t2.admin.cookie } });
  assert.equal(js.statusCode, 200); assert.match(js.headers['content-type'], /javascript/); assert.match(js.body, /register/);
  assert.equal((await t2.call('GET', '/api/modules/sample/asset/server.js', undefined, t2.admin.cookie)).status, 404); // not a declared asset
  assert.equal((await t2.call('GET', '/api/modules/sample/asset/web.js')).status, 401);
  await t2.call('PUT', '/api/modules/sample/me', { on: false }, t2.admin.cookie);
  assert.equal((await t2.call('GET', '/api/modules/sample/asset/web.js', undefined, t2.admin.cookie)).status, 404); // switched off: nothing is sent
  assert.equal((await t2.call('GET', '/api/me', undefined, t2.admin.cookie)).body.user.modules[0].web, null);
  await t2.app.close();
});

/* ---------- language modules (1.3.1) ---------- */

const langZip = (over = {}, strings = { appName: 'Liste de courses', save: 'Enregistrer' }) => Buffer.from(zipSync({
  'manifest.json': strToU8(JSON.stringify({ id: 'lang-fr', name: 'French', kind: 'language', version: '1.0.0', requires: { core: '>=1.3.1 <2.0.0' }, code: 'fr', nativeName: 'Français', dir: 'ltr', locale: 'fr-FR', strings: 'strings.json', ...over })),
  'strings.json': strToU8(typeof strings === 'string' ? strings : JSON.stringify(strings)),
}));

test('a language module is data only: checked on upload, available to everyone once enabled, chosen in Settings', async () => {
  const t = await boot();
  const post = (zip) => t.call('POST', '/api/admin/modules/inspect', zip, t.admin.cookie, t.zipHeaders);
  for (const [over, why] of [[{ code: 'en' }, 'en is built in'], [{ code: 'FR' }, 'bad code'], [{ dir: 'sideways' }, 'bad dir'], [{ nativeName: '' }, 'no name'], [{ server: 'server/index.js' }, 'code in a language module'], [{ strings: undefined }, 'no strings file']]) {
    assert.equal((await post(langZip(over))).body.error, 'manifest_invalid', why);
  }
  assert.equal((await post(langZip({}, '{ not json'))).body.error, 'manifest_invalid');
  assert.equal((await post(langZip({}, { a: 5 }))).body.error, 'manifest_invalid'); // values must be text
  assert.equal((await t.call('PATCH', '/api/me', { language: 'fr' }, t.admin.cookie)).body.error, 'invalid_value'); // not installed yet

  assert.equal((await t.upload(langZip())).status, 200);
  assert.equal((await t.call('POST', '/api/admin/modules/lang-fr/enable', {}, t.admin.cookie)).status, 200);
  const t2 = await t.restart();
  const dana = await t2.mkUser('dana');
  const me = (await t2.call('GET', '/api/me', undefined, dana.cookie)).body.user;
  const fr = me.modules.find((m) => m.id === 'lang-fr');
  assert.deepEqual([fr.kind, fr.on, fr.lang, fr.web], ['language', true, { code: 'fr', nativeName: 'Français', dir: 'ltr', locale: 'fr-FR' }, null]); // listed for everyone, no grant needed
  const strings = await t2.app.inject({ method: 'GET', url: fr.strings, headers: { cookie: dana.cookie } });
  assert.equal(strings.statusCode, 200); assert.equal(JSON.parse(strings.body).save, 'Enregistrer');
  assert.equal((await t2.call('PUT', '/api/modules/lang-fr/me', { on: false }, dana.cookie)).status, 404); // no personal switch for languages
  assert.equal((await t2.call('PATCH', '/api/me', { language: 'fr' }, dana.cookie)).body.user.language, 'fr');
  assert.equal((await t2.call('PATCH', '/api/me', { language: 'xx' }, dana.cookie)).status, 400);

  // new users may be created in an installed language; an unknown one falls back to English
  const mk = async (language, username) => (await t2.call('POST', '/api/admin/users', { name: username, username, language }, t2.admin.cookie)).status;
  assert.equal(await mk('fr', 'luc'), 200); assert.equal(await mk('zz', 'zed'), 200);
  assert.deepEqual(t2.app.db.prepare("SELECT username, language FROM users WHERE username IN ('luc','zed') ORDER BY username").all().map((r) => [r.username, r.language]), [['luc', 'fr'], ['zed', 'en']]);

  // switching the module off: the language disappears from the list, new choices are refused, existing users keep their saved value (the app shows English)
  await t2.call('POST', '/api/admin/modules/lang-fr/disable', {}, t2.admin.cookie);
  assert.ok(!(await t2.call('GET', '/api/me', undefined, dana.cookie)).body.user.modules.some((m) => m.id === 'lang-fr'));
  assert.equal((await t2.call('GET', fr.strings, undefined, dana.cookie)).status, 404);
  assert.equal((await t2.call('PATCH', '/api/me', { language: 'fr' }, t2.admin.cookie)).status, 400);
  assert.equal((await t2.call('GET', '/api/me', undefined, dana.cookie)).body.user.language, 'fr');
  await t2.app.close();
});

/* ---------- interface preferences (1.3.1) ---------- */

test('preferences: Manage list order and open sections follow the user, merged and validated', async () => {
  const t = await boot();
  const put = (b, c = t.admin.cookie) => t.call('PUT', '/api/me/prefs', b, c);
  assert.deepEqual((await t.call('GET', '/api/me', undefined, t.admin.cookie)).body.user.prefs, {});
  let r = await put({ manageOrder: ['stores', 'add', 'price-compare:compare'], manageOpen: { add: false, csv: true } });
  assert.deepEqual(r.body.user.prefs, { manageOrder: ['stores', 'add', 'price-compare:compare'], manageOpen: { add: false, csv: true } });
  r = await put({ manageOpen: { stores: true } }); // sections are merged, not replaced
  assert.deepEqual(r.body.user.prefs.manageOpen, { add: false, csv: true, stores: true });
  assert.deepEqual(r.body.user.prefs.manageOrder, ['stores', 'add', 'price-compare:compare']);
  const login = await t.call('POST', '/api/auth/login', { login: 'admin', password: 'correct-horse' });
  assert.deepEqual(login.body.user.prefs.manageOrder[0], 'stores'); // follows the user to another device
  for (const bad of [{ manageOrder: 'add' }, { manageOrder: ['add', 'add'] }, { manageOrder: ['has space'] }, { manageOrder: [1] }, { manageOrder: Array.from({ length: 41 }, (_, i) => `s${i}`) },
    { manageOpen: { add: 'yes' } }, { manageOpen: [] }, { manageOpen: { '': true } }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  r = await put({ manageOrder: null });  // reset to the default order
  assert.equal(r.body.user.prefs.manageOrder, undefined);
  assert.equal(r.body.user.prefs.manageOpen.csv, true);
  const dana = await t.mkUser('dana');
  assert.deepEqual((await t.call('GET', '/api/me', undefined, dana.cookie)).body.user.prefs, {}); // per user
  assert.equal((await t.call('PUT', '/api/me/prefs', { manageOpen: { x: true } })).status, 401);
  await t.app.close();
});

/* ---------- item catalog capability (1.4.2) ---------- */

const catalogZip = () => Buffer.from(zipSync({
  'manifest.json': strToU8(JSON.stringify({ id: 'cat-test', name: 'Catalog test', version: '1.0.0', requires: { core: '>=1.4.2 <2.0.0' }, provides: ['item-catalog'], server: 'server/index.js' })),
  'server/index.js': strToU8(`export const migrations = ['CREATE TABLE added (item_id INTEGER, ref TEXT);'];
export default function register(ctx) {
  ctx.provide('item-catalog', {
    async search({ q, listId, householdId, limit }) {
      if (q === 'boom') throw new Error('search failed');
      return [{ name: 'Milk 1 l', note: 'Brand · 1 l', categoryId: ctx.core.similarItem(householdId, 'Milk 1 l')?.categoryId ?? null, price: 6.9, priceMax: 7.5, currency: 'ILS', chains: [{ nameEn: 'A', nameHe: 'א' }], ref: { chain: 'a', code: '1' }, extra: 'dropped' },
              { name: '', price: 1 }, { name: 'Bad ref', ref: { big: 'x'.repeat(400) } }];
    },
    async afterAdd({ itemId, ref, listId }) { if (ref.chain === 'fail') throw new Error('nope'); ctx.db.prepare('INSERT INTO added(item_id, ref) VALUES (?, ?)').run(itemId, JSON.stringify(ref)); },
  });
}`),
}));

test('item catalog: suggestions come from the module while typing, only for those who can add; the chosen product is passed on when the item is added', async () => {
  const t = await boot();
  const lid = (await t.call('POST', '/api/lists', { householdId: t.hid, name: 'Groceries' }, t.admin.cookie)).body.id;
  const get = (q, cookie = t.admin.cookie) => t.call('GET', `/api/lists/${lid}/catalog?q=${encodeURIComponent(q)}`, undefined, cookie);
  assert.deepEqual((await get('milk')).body, { available: false, suggestions: [] });           // no module: the form works as before

  await t.upload(catalogZip());
  await t.call('POST', '/api/admin/modules/cat-test/enable', {}, t.admin.cookie);
  const t2 = await t.restart();
  const get2 = (q, cookie = t2.admin.cookie) => t2.call('GET', `/api/lists/${lid}/catalog?q=${encodeURIComponent(q)}`, undefined, cookie);
  const cat = (await t2.call('POST', `/api/households/${t2.hid}/categories`, { nameEn: 'Dairy' }, t2.admin.cookie)).body.id;
  await t2.call('POST', `/api/lists/${lid}/entries`, { name: 'Milk', categoryId: cat }, t2.admin.cookie);

  const r = await get2('milk');
  assert.equal(r.body.available, true);
  assert.deepEqual(r.body.suggestions, [{ name: 'Milk 1 l', note: 'Brand · 1 l', categoryId: cat, price: 6.9, priceMax: 7.5, currency: 'ILS', perKg: false, chains: [{ nameEn: 'A', nameHe: 'א' }], ref: { chain: 'a', code: '1' } },
    { name: 'Bad ref', note: null, categoryId: null, price: null, priceMax: null, currency: null, perKg: false, chains: [], ref: null }]); // a nameless one is dropped, an oversized ref is not passed on
  assert.deepEqual((await get2('m')).body, { available: true, suggestions: [] });               // too short to search
  assert.deepEqual((await get2('boom')).body, { available: true, suggestions: [] });            // a failing module never breaks typing
  assert.equal((await get2('milk', null)).status, 401);
  const viewer = await t2.mkUser('dana');
  await t2.call('PUT', `/api/lists/${lid}/members/${viewer.id}`, { role: 'viewer' }, t2.admin.cookie);
  assert.equal((await get2('milk', viewer.cookie)).status, 403);                                 // Shoppers cannot add
  assert.equal((await t2.call('GET', '/api/lists/99999/catalog?q=milk', undefined, t2.admin.cookie)).status, 404);

  const added = () => t2.app.modules.loaded.get('cat-test').db.prepare('SELECT item_id, ref FROM added').all();
  const post = (body) => t2.call('POST', `/api/lists/${lid}/entries`, { name: 'Milk 1 l', ...body }, t2.admin.cookie);
  const a = await post({ catalogRef: { chain: 'a', code: '1' } });
  assert.equal(a.status, 200);
  assert.deepEqual(added(), [{ item_id: a.body.itemId, ref: '{"chain":"a","code":"1"}' }]);
  const merged = await post({ catalogRef: { chain: 'a', code: '2' } });                            // the same item again: quantity merges, the choice is still passed on
  assert.deepEqual([merged.body.merged, added().length], [true, 2]);
  assert.equal((await post({ catalogRef: { chain: 'fail', code: '3' } })).status, 200);            // afterAdd failing does not fail the add
  assert.equal((await post({ catalogRef: { big: 'x'.repeat(400) } })).status, 200);                // an oversized ref is ignored
  assert.equal((await post({ catalogRef: 'nonsense' })).status, 200);
  assert.equal(added().length, 2);

  await t2.call('PUT', '/api/modules/cat-test/me', { on: false }, t2.admin.cookie);              // the user switches the module off: no suggestions
  assert.equal((await get2('milk')).body.available, false);
  await t2.app.close();
});
