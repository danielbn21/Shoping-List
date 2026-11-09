// Tiny semver helpers: versions are X.Y.Z; ranges are space-separated comparators (">=1.3.0 <2.0.0"), "^X.Y.Z", "X.Y.Z" or "*".
export const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
export const validVersion = (v) => !!parseVersion(v);
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
export function satisfies(version, range) {
  if (!parseVersion(version)) return false;
  const r = String(range ?? '*').trim();
  if (r === '*' || r === '') return true;
  const parts = r.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    let m;
    if ((m = /^\^(\d+\.\d+\.\d+)$/.exec(p))) {
      const lo = parseVersion(m[1]);
      if (compareVersions(version, m[1]) < 0 || compareVersions(version, `${lo[0] + 1}.0.0`) >= 0) return false;
    } else if ((m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(p))) {
      const c = compareVersions(version, m[2]), op = m[1] || '=';
      if (op === '>=' && c < 0) return false;
      if (op === '>' && c <= 0) return false;
      if (op === '<=' && c > 0) return false;
      if (op === '<' && c >= 0) return false;
      if (op === '=' && c !== 0) return false;
    } else return false; // an unreadable range never matches
  }
  return true;
}
