import { validVersion, satisfies } from './semver.js';

export const SLOTS = ['list.tab', 'manage.section', 'settings.section', 'admin.section'];
export const KINDS = ['feature', 'language'];
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const FILE = /^[A-Za-z0-9_.\/-]{1,80}$/;

// Validates a parsed manifest.json. Returns { ok, manifest } or { ok: false, error } (error is a stable code, detail is for people).
export function checkManifest(m, { coreVersion } = {}) {
  const fail = (error, detail) => ({ ok: false, error, detail });
  if (!m || typeof m !== 'object' || Array.isArray(m)) return fail('manifest_invalid', 'not an object');
  if (typeof m.id !== 'string' || !ID.test(m.id)) return fail('manifest_invalid', 'id: lowercase letters, digits and dashes, 2 to 40 characters');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) return fail('manifest_invalid', 'name');
  if (!validVersion(m.version)) return fail('manifest_invalid', 'version must look like 1.2.3');
  const kind = m.kind ?? 'feature';
  if (!KINDS.includes(kind)) return fail('manifest_invalid', 'kind');
  const list = (k) => (m[k] === undefined ? [] : m[k]);
  for (const k of ['dependsOn', 'optionalDepends', 'provides', 'slots']) {
    if (!Array.isArray(list(k)) || list(k).some((x) => typeof x !== 'string' || x.length > 60)) return fail('manifest_invalid', k);
  }
  if (list('dependsOn').some((d) => !ID.test(d)) || list('optionalDepends').some((d) => !ID.test(d))) return fail('manifest_invalid', 'dependsOn');
  if (list('dependsOn').includes(m.id)) return fail('manifest_invalid', 'a module cannot depend on itself');
  if (list('slots').some((s) => !SLOTS.includes(s))) return fail('manifest_invalid', `slots must be among ${SLOTS.join(', ')}`);
  for (const k of ['server', 'web', 'css', 'i18n', 'strings']) {
    if (m[k] !== undefined && (typeof m[k] !== 'string' || !FILE.test(m[k]) || m[k].includes('..') || m[k].startsWith('/'))) return fail('manifest_invalid', k);
  }
  if (kind === 'feature' && !m.server && !m.web) return fail('manifest_invalid', 'a feature module needs server and/or web');
  if (kind === 'language') {
    // A language module is data only: a translation file plus how the language is named and written.
    if (typeof m.code !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(m.code) || m.code === 'en') return fail('manifest_invalid', 'code: a language code such as fr or pt-BR (en is built in)');
    if (typeof m.nativeName !== 'string' || !m.nativeName.trim() || m.nativeName.length > 40) return fail('manifest_invalid', 'nativeName');
    if (!['ltr', 'rtl'].includes(m.dir)) return fail('manifest_invalid', 'dir must be ltr or rtl');
    if (m.locale !== undefined && (typeof m.locale !== 'string' || !/^[A-Za-z0-9-]{2,20}$/.test(m.locale))) return fail('manifest_invalid', 'locale');
    if (!m.strings) return fail('manifest_invalid', 'a language module needs a strings file');
    if (m.server || m.web) return fail('manifest_invalid', 'a language module has no server or web code');
  }
  if (m.requires !== undefined && (typeof m.requires !== 'object' || (m.requires.core !== undefined && typeof m.requires.core !== 'string'))) return fail('manifest_invalid', 'requires');
  if (coreVersion && !satisfies(coreVersion, m.requires?.core ?? '*')) return fail('core_incompatible', `needs core ${m.requires.core}, this is ${coreVersion}`);
  return {
    ok: true,
    manifest: {
      id: m.id, name: m.name.trim(), version: m.version, kind, description: typeof m.description === 'string' ? m.description.slice(0, 300) : '',
      author: typeof m.author === 'string' ? m.author.slice(0, 80) : '',
      requires: { core: m.requires?.core ?? '*' }, dependsOn: list('dependsOn'), optionalDepends: list('optionalDepends'),
      provides: list('provides'), slots: list('slots'),
      server: m.server ?? null, web: m.web ?? null, css: m.css ?? null, i18n: m.i18n ?? null, strings: m.strings ?? null,
      ...(kind === 'language' ? { code: m.code, nativeName: m.nativeName.trim(), dir: m.dir, locale: m.locale ?? m.code } : {}),
    },
  };
}
