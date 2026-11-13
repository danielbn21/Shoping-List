#!/usr/bin/env node
// Records the version and fingerprint of every module in modules/versions.lock.json.
// Run it after bumping a module's version. The test suite fails when a module's files changed but its version did not,
// because an installed copy only upgrades when the bundled version is higher (and browsers cache a module's files by version).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentState } from './module-hash.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modules');
const state = currentState(dir);
fs.writeFileSync(path.join(dir, 'versions.lock.json'), JSON.stringify(state, null, 2) + '\n');
for (const [id, v] of Object.entries(state)) console.log(`${id} ${v.version}  ${v.sha256.slice(0, 12)}`);
