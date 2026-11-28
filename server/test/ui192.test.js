import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir, logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.statusCode, body: json, cookie: c ? `sl_session=${c.value}` : null };
  };
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  return { app, call, cookie: admin.cookie };
}

test('1.9.2 prefs: openMode takes last, shop, manage or null; anything else is refused', async () => {
  const t = await boot();
  for (const v of ['last', 'shop', 'manage']) {
    const r = await t.call('PUT', '/api/me/prefs', { openMode: v }, t.cookie);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.prefs.openMode, v);
  }
  for (const bad of ['plan', '', 5, true, {}]) assert.equal((await t.call('PUT', '/api/me/prefs', { openMode: bad }, t.cookie)).body?.error, 'invalid_value', JSON.stringify(bad));
  const r = await t.call('PUT', '/api/me/prefs', { openMode: null }, t.cookie);
  assert.equal(r.body.user.prefs.openMode, undefined);
  await t.app.close();
});

test('1.9.2 prefs: last remembers the list and each list\'s tab; tabs merge, are validated and are capped', async () => {
  const t = await boot();
  let r = await t.call('PUT', '/api/me/prefs', { last: { list: 3, tabs: { 3: 'manage' } } }, t.cookie);
  assert.deepEqual(r.body.user.prefs.last, { list: 3, tabs: { 3: 'manage' } });
  r = await t.call('PUT', '/api/me/prefs', { last: { list: 4, tabs: { 4: 'price-compare:compare' } } }, t.cookie);
  assert.deepEqual(r.body.user.prefs.last, { list: 4, tabs: { 3: 'manage', 4: 'price-compare:compare' } });
  for (const bad of [{ list: 0, tabs: {} }, { list: 1.5, tabs: {} }, { list: 1 }, { list: 1, tabs: { x: 'shop' } }, { list: 1, tabs: { 1: 'sh op' } }, { list: 1, tabs: { 1: 5 } }, [], 'shop']) {
    assert.equal((await t.call('PUT', '/api/me/prefs', { last: bad }, t.cookie)).body?.error, 'invalid_value', JSON.stringify(bad));
  }
  // the oldest entries are dropped beyond 40
  for (let i = 10; i < 60; i += 5) {
    const tabs = {}; for (let k = i; k < i + 5; k++) tabs[k] = 'shop';
    await t.call('PUT', '/api/me/prefs', { last: { list: i, tabs } }, t.cookie);
  }
  const final = (await t.call('GET', '/api/me', undefined, t.cookie)).body.user.prefs.last;
  assert.ok(Object.keys(final.tabs).length <= 40);
  assert.equal(final.list, 55);
  assert.equal((await t.call('PUT', '/api/me/prefs', { last: null }, t.cookie)).body.user.prefs.last, undefined);
  await t.app.close();
});

test('1.9.2 prefs: the older keys still work and a change to one key keeps the others', async () => {
  const t = await boot();
  await t.call('PUT', '/api/me/prefs', { showEstimates: true, manageOpen: { add: true } }, t.cookie);
  const r = await t.call('PUT', '/api/me/prefs', { openMode: 'shop' }, t.cookie);
  assert.equal(r.body.user.prefs.showEstimates, true);
  assert.deepEqual(r.body.user.prefs.manageOpen, { add: true });
  assert.equal(r.body.user.prefs.openMode, 'shop');
  await t.app.close();
});
