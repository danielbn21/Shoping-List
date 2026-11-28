import { useMemo, useSyncExternalStore } from 'react';

// One place that knows where the person is. The address (the part after #) is the route, so the phone's back gesture, the browser's
// Back button, Esc and the arrow in every header all do the same thing, and a refresh keeps the place (1.9.2).
//   #/                                home            #/settings[/account|preferences|modules]
//   #/list/5[/tab/manage|/page/people]                #/admin[/people|modules|server|audit[/users|households[/7]|settings|config]]
//   #/new-list/2   #/new-household    #/household/2/members|export
export type Route =
  | { k: 'home' }
  | { k: 'list'; id: number; tab?: string; page?: string }
  | { k: 'newList'; hid: number }
  | { k: 'newHousehold' }
  | { k: 'household'; hid: number; part: 'members' | 'export' }
  | { k: 'settings'; section?: string }
  | { k: 'admin'; area?: string; sub?: string; id?: number };

const seg = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const num = (s: string | undefined) => (s && /^\d{1,12}$/.test(s) ? Number(s) : undefined);

export function parseRoute(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(seg);
  switch (p[0]) {
    case 'list': {
      const id = num(p[1]);
      if (id === undefined) return { k: 'home' };
      if (p[2] === 'tab' && p[3]) return { k: 'list', id, tab: p[3] };
      if (p[2] === 'page' && p[3]) return { k: 'list', id, page: p[3] };
      return { k: 'list', id };
    }
    case 'new-list': { const hid = num(p[1]); return hid === undefined ? { k: 'home' } : { k: 'newList', hid }; }
    case 'new-household': return { k: 'newHousehold' };
    case 'household': { const hid = num(p[1]); return hid === undefined ? { k: 'home' } : { k: 'household', hid, part: p[2] === 'export' ? 'export' : 'members' }; }
    case 'settings': return { k: 'settings', section: p[1] };
    case 'admin': return { k: 'admin', area: p[1], sub: p[2], id: num(p[3]) };
    default: return { k: 'home' };
  }
}

export function toHash(r: Route): string {
  const e = encodeURIComponent;
  switch (r.k) {
    case 'home': return '#/';
    case 'list': return `#/list/${r.id}${r.page ? `/page/${e(r.page)}` : r.tab ? `/tab/${e(r.tab)}` : ''}`;
    case 'newList': return `#/new-list/${r.hid}`;
    case 'newHousehold': return '#/new-household';
    case 'household': return `#/household/${r.hid}/${r.part}`;
    case 'settings': return r.section ? `#/settings/${e(r.section)}` : '#/settings';
    case 'admin': return `#/admin${r.area ? `/${e(r.area)}${r.sub ? `/${e(r.sub)}${r.id !== undefined ? `/${r.id}` : ''}` : ''}` : ''}`;
  }
}

// Where the arrow goes when there is nothing earlier in this app's own history (opened from a link, or after a refresh at the start).
export function parentOf(r: Route): Route {
  switch (r.k) {
    case 'list': return r.page ? { k: 'list', id: r.id } : { k: 'home' };
    case 'admin': return r.id !== undefined ? { k: 'admin', area: r.area, sub: r.sub } : r.sub && r.area ? { k: 'admin', area: r.area } : r.area ? { k: 'admin' } : { k: 'home' };
    default: return { k: 'home' };
  }
}

let idx = typeof history !== 'undefined' && typeof history.state?.sl === 'number' ? history.state.sl : 0;
if (typeof history !== 'undefined' && typeof history.state?.sl !== 'number') history.replaceState({ ...(history.state ?? {}), sl: 0 }, '');
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const sync = (e?: PopStateEvent) => { idx = typeof e?.state?.sl === 'number' ? e.state.sl : typeof history.state?.sl === 'number' ? history.state.sl : 0; notify(); };
if (typeof window !== 'undefined') { window.addEventListener('popstate', sync); window.addEventListener('hashchange', () => notify()); }

const asHash = (r: Route | string) => (typeof r === 'string' ? r : toHash(r));
export function go(r: Route | string) {
  const h = asHash(r);
  if (h === location.hash) return;
  idx += 1;
  history.pushState({ sl: idx }, '', h);
  notify();
}
export function replace(r: Route | string) {
  const h = asHash(r);
  if (h === location.hash) return;
  history.replaceState({ sl: idx }, '', h);
  notify();
}
// The arrow: one step back where this app has been, otherwise straight to the parent screen.
export function goBack(parent: Route) {
  if (idx > 0) history.back();
  else replace(parent);
}
export const canGoBack = () => idx > 0;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  return useMemo(() => parseRoute(hash), [hash]);
}

// The first screen after the page opens may jump to the last list (see Home). It happens once per sign-in, never when someone comes back to Home.
let startup = typeof location !== 'undefined' && (location.hash === '' || location.hash === '#' || location.hash === '#/');
export const consumeStartup = () => { const s = startup; startup = false; return s; };
export const resetStartup = () => { startup = true; };
