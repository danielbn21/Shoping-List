// A fingerprint of what a module ships (its manifest, server code, browser sources, strings), used to make sure a changed module always has a new version.
// Built files (web.js, web.css) and tests are left out: they follow from the sources.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SKIP_DIRS = new Set(['test', 'tests', 'node_modules']);
const SKIP_ROOT_FILES = new Set(['web.js', 'web.css']);

export function moduleFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!(rel === '' && SKIP_DIRS.has(e.name))) walk(path.join(abs, e.name), r); }
      else if (e.isFile() && !(rel === '' && SKIP_ROOT_FILES.has(e.name))) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function moduleHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of moduleFiles(dir)) { h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(dir, f))); h.update('\0'); }
  return h.digest('hex');
}

// { id: { version, sha256 } } for every module in modules/
export function currentState(modulesDir) {
  const out = {};
  for (const id of fs.readdirSync(modulesDir).sort()) {
    const dir = path.join(modulesDir, id);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
    out[id] = { version: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, sha256: moduleHash(dir) };
  }
  return out;
}
