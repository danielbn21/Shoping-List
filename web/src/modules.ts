import { addStrings, registerLanguage, unregisterLanguage } from './i18n';
import { makeHost } from './host';
import { slots } from './slots';
import type { MeModule } from './types';

// Loads the browser side of the modules the signed-in user may use and has switched on. A module that fails to load is skipped:
// the app keeps working without it.
const loaded = new Map<string, string>(); // id -> version loaded
const failed = new Set<string>();
const langs = new Map<string, { code: string; version: string }>(); // language module id -> what is registered

export async function syncModules(mods: MeModule[]): Promise<void> {
  await syncLanguages(mods);
  const want = new Map(mods.filter((m) => m.on && m.web).map((m) => [m.id, m]));
  for (const id of [...loaded.keys()]) {
    if (!want.has(id) || want.get(id)!.version !== loaded.get(id)) { slots.removeModule(id); loaded.delete(id); }
  }
  await Promise.all([...want.values()].map(async (m) => {
    if (loaded.has(m.id) || failed.has(`${m.id}@${m.version}`)) return;
    try {
      if (m.css && !document.querySelector(`link[data-module="${m.id}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = m.css; l.dataset.module = m.id;
        document.head.appendChild(l);
      }
      if (m.i18n) {
        const r = await fetch(m.i18n, { credentials: 'same-origin' });
        if (r.ok) addStrings(await r.json());
      }
      const mod = await import(/* @vite-ignore */ m.web!);
      if (typeof mod.default !== 'function') throw new Error('no register function');
      mod.default(makeHost(m.id));
      loaded.set(m.id, m.version);
    } catch (e) {
      failed.add(`${m.id}@${m.version}`);
      console.warn(`Module ${m.id} could not be loaded`, e);
    }
  }));
}

// Language modules are data only: a translation file plus the language's name, direction and locale. They are registered for everyone.
async function syncLanguages(mods: MeModule[]): Promise<void> {
  const want = new Map(mods.filter((m) => m.kind === 'language' && m.lang && m.strings).map((m) => [m.id, m]));
  for (const [id, info] of [...langs]) {
    if (!want.has(id) || want.get(id)!.version !== info.version) { unregisterLanguage(info.code); langs.delete(id); }
  }
  await Promise.all([...want.values()].map(async (m) => {
    if (langs.has(m.id) || failed.has(`${m.id}@${m.version}`)) return;
    try {
      const r = await fetch(m.strings!, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`strings ${r.status}`);
      registerLanguage(m.lang!, await r.json());
      langs.set(m.id, { code: m.lang!.code, version: m.version });
    } catch (e) {
      failed.add(`${m.id}@${m.version}`);
      console.warn(`Language ${m.id} could not be loaded`, e);
    }
  }));
}
