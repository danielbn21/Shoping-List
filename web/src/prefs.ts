import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Me } from './types';

// Interface preferences that follow the user across devices (stored on the server, applied at once on this device):
// where a list opens ('last' = where the person left off, 'shop', 'manage') and where they left off (1.9.2).
export type Prefs = Me['prefs'];
export type OpenMode = 'last' | 'shop' | 'manage';
let prefs: Prefs = {};
let pending: { last?: { list: number; tabs: Record<string, string> } } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => { prefs = { ...prefs }; listeners.forEach((l) => l()); };

// Called when the signed-in user's data arrives; a change still waiting to be saved is not overwritten.
export function initPrefs(p: Prefs | undefined) { if (pending) return; prefs = p ?? {}; notify(); }
export const getPrefs = (): Prefs => prefs;
export const usePrefs = (): Prefs => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => prefs);
export const openModeOf = (p: Prefs): OpenMode => p.openMode ?? 'last';

function flush() {
  const body = pending; pending = null; timer = undefined;
  if (body) api('/me/prefs', { method: 'PUT', body }).catch(() => { /* the next change saves again */ });
}
// Remember the list the person is on and, when given, the tab they chose on it. Saved a moment later, in one request.
export function rememberPlace(list: number, tab?: string) {
  const tabs = { ...(prefs.last?.tabs ?? {}), ...(tab ? { [list]: tab } : {}) };
  if (prefs.last?.list === list && (!tab || prefs.last.tabs[list] === tab)) return;
  prefs = { ...prefs, last: { list, tabs } }; notify();
  pending = { last: { list, tabs: { ...(pending?.last?.tabs ?? {}), ...(tab ? { [list]: tab } : {}) } } };
  clearTimeout(timer); timer = setTimeout(flush, 600);
}
