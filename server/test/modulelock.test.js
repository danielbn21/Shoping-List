import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentState } from '../../scripts/module-hash.mjs';

const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

// A bundled module only upgrades an installed copy when its version is higher, and browsers cache a module's files by version.
// So changing a module without bumping its version means installed copies and cached browsers keep the old files.
test('every module that changed has a new version (modules/versions.lock.json is up to date)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(MODULES, 'versions.lock.json'), 'utf8'));
  const now = currentState(MODULES);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(lock).sort(), 'a module was added or removed: run node scripts/module-lock.mjs');
  for (const [id, cur] of Object.entries(now)) {
    if (cur.version === lock[id].version) {
      assert.equal(cur.sha256, lock[id].sha256, `${id} ${cur.version}: its files changed but its version did not. Bump the version in modules/${id}/manifest.json, then run: node scripts/module-lock.mjs`);
    } else {
      assert.fail(`${id}: the version is ${cur.version} but the lock says ${lock[id].version}. Run: node scripts/module-lock.mjs`);
    }
  }
});
