#!/usr/bin/env node
// Builds the browser side of every module in modules/<id>/ and packs each one as an installable zip.
//   node scripts/build-modules.mjs          -> modules/<id>/web.js  and  dist-modules/<id>-<version>.zip
// A module's browser code is compiled ahead of time. React is NOT bundled: the app hands its own copy to the module
// (globalThis.__SL_HOST__), so state such as the current language is shared and nothing is loaded twice.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(path.join(root, 'web', 'package.json'));
const esbuild = webRequire('esbuild');
const React = webRequire('react');
const { zipSync } = webRequire('fflate');

const hostReact = {
  name: 'host-react',
  setup(b) {
    b.onResolve({ filter: /^react(\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (a) => ({ path: a.path, namespace: 'host-react' }));
    b.onLoad({ filter: /.*/, namespace: 'host-react' }, (a) => {
      if (a.path === 'react') {
        const names = Object.keys(React).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
        return { loader: 'js', contents: `const R = globalThis.__SL_HOST__.React;\nexport default R;\nexport const { ${names.join(', ')} } = R;\n` };
      }
      return { loader: 'js', contents: 'const J = globalThis.__SL_HOST__.jsxRuntime;\nexport const jsx = J.jsx, jsxs = J.jsxs, Fragment = J.Fragment, jsxDEV = J.jsx;\n' };
    });
  },
};

const IGNORE_TOP = new Set(['web', 'test', 'tests', 'node_modules', '.git']);
function collect(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || (rel === '' && IGNORE_TOP.has(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r); else if (e.isFile()) out[r] = new Uint8Array(fs.readFileSync(path.join(abs, e.name)));
    }
  };
  walk(dir, '');
  return out;
}

const only = process.argv[2];
const outDir = path.join(root, 'dist-modules');
fs.mkdirSync(outDir, { recursive: true });
for (const id of fs.readdirSync(path.join(root, 'modules'))) {
  const dir = path.join(root, 'modules', id);
  if (only && only !== id) continue;
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entry = ['index.tsx', 'index.ts'].map((f) => path.join(dir, 'web', f)).find((f) => fs.existsSync(f));
  if (manifest.web && entry) {
    await esbuild.build({
      entryPoints: [entry], outfile: path.join(dir, manifest.web), bundle: true, format: 'esm', target: 'es2020', minify: true,
      jsx: 'automatic', plugins: [hostReact], legalComments: 'none', logLevel: 'warning',
    });
  }
  const files = collect(dir);
  const zip = zipSync(files, { level: 9 });
  const name = `${manifest.id}-${manifest.version}.zip`;
  fs.writeFileSync(path.join(outDir, name), zip);
  console.log(`${manifest.id} ${manifest.version}: ${manifest.web ? `${manifest.web} ${(fs.statSync(path.join(dir, manifest.web)).size / 1024).toFixed(1)} KB, ` : ''}${Object.keys(files).length} files -> dist-modules/${name} (${(zip.length / 1024).toFixed(1)} KB)`);
}
