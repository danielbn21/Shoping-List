import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';

const H = { 'x-sl-client': 'web', 'content-type': 'application/json' };

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const app = await buildApp({ dataDir: dir, logger: false });
  const call = async (method, url, body, cookie) => {
    const res = await app.inject({ method, url, headers: { ...H, ...(cookie ? { cookie } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    const c = res.cookies.find((x) => x.name === 'sl_session');
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, cookie: c ? `sl_session=${c.value}` : null };
  };
  return { app, call };
}

test('first-run setup, login, and persistent session', async () => {
  const { app, call } = await setup();
  assert.equal((await call('GET', '/api/public-config')).body.needsSetup, true);
  const s = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  assert.equal(s.status, 200);
  assert.equal(s.body.user.role, 'admin');
  assert.equal(s.body.user.households.length, 1);
  assert.equal((await call('POST', '/api/setup', { name: 'X', username: 'x2', password: 'correct-horse' })).status, 409);
  assert.equal((await call('GET', '/api/me', undefined, s.cookie)).body.user.username, 'admin');
  assert.equal((await call('POST', '/api/auth/login', { login: 'admin', password: 'wrong-pass' })).status, 401);
  const l = await call('POST', '/api/auth/login', { login: 'ADMIN', password: 'correct-horse' });
  assert.equal(l.status, 200);
  await app.close();
});

test('CSRF header is required for writes', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('registration modes and household invites', async () => {
  const { app, call } = await setup();
  const admin = (await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' }));
  const reg = { name: 'Dana', username: 'dana', password: 'password-1' };
  assert.equal((await call('POST', '/api/auth/register', reg)).status, 403); // invite-only default
  const hid = admin.body.user.households[0].id;
  const inv = await call('POST', '/api/invites', { householdId: hid }, admin.cookie);
  assert.equal(inv.status, 200);
  const r = await call('POST', '/api/auth/register', { ...reg, inviteCode: inv.body.code });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.households[0].id, hid); // joined the inviter's household
  // non-owner member cannot create invites
  assert.equal((await call('POST', '/api/invites', { householdId: hid }, r.cookie)).status, 403);
  // admin-only mode blocks everything
  await call('PUT', '/api/admin/settings', { registration_mode: 'admin-only' }, admin.cookie);
  assert.equal((await call('POST', '/api/auth/register', { ...reg, username: 'dana2', inviteCode: inv.body.code })).status, 403);
  // open mode: no invite needed, own household created
  await call('PUT', '/api/admin/settings', { registration_mode: 'open' }, admin.cookie);
  const o = await call('POST', '/api/auth/register', { name: 'Eli', username: 'eli', password: 'password-2' });
  assert.equal(o.status, 200);
  assert.notEqual(o.body.user.households[0].id, hid);
  await app.close();
});

test('admin creates user with one-time password, forced change, and reset', async () => {
  const { app, call } = await setup();
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const hid = admin.body.user.households[0].id;
  const c = await call('POST', '/api/admin/users', { name: 'Noa', username: 'noa', householdId: hid }, admin.cookie);
  assert.equal(c.status, 200);
  const otp = c.body.oneTimePassword;
  assert.equal(otp.length, 12);
  const l = await call('POST', '/api/auth/login', { login: 'noa', password: otp });
  assert.equal(l.body.user.mustChangePassword, true);
  assert.equal((await call('PATCH', '/api/me', { name: 'Noa B' }, l.cookie)).status, 403); // blocked until changed
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: otp, newPassword: 'my-new-password' }, l.cookie)).status, 200);
  assert.equal((await call('PATCH', '/api/me', { name: 'Noa B', language: 'he' }, l.cookie)).body.user.language, 'he');
  // admin resets -> old sessions die, new OTP works
  const noaId = (await call('GET', '/api/admin/users', undefined, admin.cookie)).body.users.find((u) => u.username === 'noa').id;
  const rp = await call('POST', `/api/admin/users/${noaId}/reset-password`, {}, admin.cookie);
  assert.equal((await call('GET', '/api/me', undefined, l.cookie)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { login: 'noa', password: rp.body.oneTimePassword })).status, 200);
  // non-admin cannot reach admin API
  assert.equal((await call('GET', '/api/admin/users', undefined, l.cookie)).status, 401);
  await app.close();
});

test('last admin cannot be disabled, demoted, or deleted', async () => {
  const { app, call } = await setup();
  const admin = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const id = admin.body.user.id;
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { disabled: true }, admin.cookie)).status, 409);
  assert.equal((await call('PATCH', `/api/admin/users/${id}`, { role: 'user' }, admin.cookie)).status, 409);
  assert.equal((await call('DELETE', `/api/admin/users/${id}`, undefined, admin.cookie)).status, 409);
  await app.close();
});

test('devices can be listed and revoked', async () => {
  const { app, call } = await setup();
  const a = await call('POST', '/api/setup', { name: 'Admin', username: 'admin', password: 'correct-horse' });
  const b = await call('POST', '/api/auth/login', { login: 'admin', password: 'correct-horse' });
  const list = (await call('GET', '/api/devices', undefined, a.cookie)).body.devices;
  assert.equal(list.length, 2);
  const other = list.find((d) => !d.current);
  await call('DELETE', `/api/devices/${other.id}`, undefined, a.cookie);
  assert.equal((await call('GET', '/api/me', undefined, b.cookie)).status, 401);
  assert.equal((await call('GET', '/api/me', undefined, a.cookie)).status, 200);
  await app.close();
});
