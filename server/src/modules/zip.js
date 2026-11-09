import { unzipSync } from 'fflate';
import path from 'node:path';

export const LIMITS = { zipBytes: 20 * 1024 * 1024, files: 400, fileBytes: 8 * 1024 * 1024, totalBytes: 60 * 1024 * 1024 };
const BARE_IMPORT = /(?:^|[^\w$.])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g;

// Reads a zip into { 'relative/path': Buffer }. Refuses anything that could escape the module folder (zip-slip),
// absolute paths, too many or too large files. Folders and macOS metadata are skipped. One top-level folder is stripped.
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw coded('zip_invalid');
  if (buf.length > LIMITS.zipBytes) throw coded('zip_too_large');
  let raw;
  try { raw = unzipSync(new Uint8Array(buf), { filter: (f) => f.originalSize <= LIMITS.fileBytes }); }
  catch { throw coded('zip_invalid'); }
  const out = {};
  let total = 0, n = 0;
  const names = Object.keys(raw).filter((k) => !k.endsWith('/') && !k.startsWith('__MACOSX/') && !k.endsWith('.DS_Store'));
  // A zip made by "compress folder" has everything inside one folder: strip it.
  const tops = new Set(names.map((k) => k.split('/')[0]));
  const strip = tops.size === 1 && names.every((k) => k.includes('/')) ? [...tops][0] + '/' : '';
  for (const k of names) {
    const rel = strip ? k.slice(strip.length) : k;
    if (!rel || rel.includes('\\') || rel.includes('\0') || path.posix.isAbsolute(rel) || /(^|\/)\.\.(\/|$)/.test(rel) || /^[A-Za-z]:/.test(rel)) throw coded('zip_unsafe', k);
    if (++n > LIMITS.files) throw coded('zip_too_many_files');
    const b = Buffer.from(raw[k]);
    total += b.length;
    if (b.length > LIMITS.fileBytes || total > LIMITS.totalBytes) throw coded('zip_too_large');
    out[rel] = b;
  }
  if (!out['manifest.json']) throw coded('manifest_missing');
  return out;
}

// Module server code may import Node built-ins and its own files only: everything else comes from the host (ctx).
export function checkImports(files, skip = new Set()) {
  for (const [name, buf] of Object.entries(files)) {
    if (!/\.(m?js)$/.test(name) || name.startsWith('web/') || skip.has(name)) continue;
    const src = buf.toString('utf8');
    BARE_IMPORT.lastIndex = 0;
    let m;
    while ((m = BARE_IMPORT.exec(src))) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!(spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:'))) throw coded('import_not_allowed', `${name}: ${spec}`);
    }
  }
}

function coded(code, detail) { const e = new Error(code); e.code = code; e.detail = detail; e.coded = true; return e; }
