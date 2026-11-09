import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { Me } from './types';

// Interface preferences that follow the user across devices (stored on the server, applied at once on this device).
export type Prefs = Me['prefs'];
let prefs: Prefs = {};
let pending: { manageOrder?: string[] | null; manageOpen?: Record<string, boolean> } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => { prefs = { ...prefs }; listeners.forEach((l) => l()); };

// Called when the signed-in user's data arrives; a change still waiting to be saved is not overwritten.
export function initPrefs(p: Prefs | undefined) { if (pending) return; prefs = p ?? {}; notify(); }

export const usePrefs = (): Prefs => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => prefs);

function flush() {
  const body = pending; pending = null; timer = undefined;
  if (body) api('/me/prefs', { method: 'PUT', body }).catch(() => { /* the next change saves again */ });
}
export function setManageOpen(id: string, open: boolean) {
  prefs = { ...prefs, manageOpen: { ...(prefs.manageOpen ?? {}), [id]: open } }; notify();
  pending = { ...pending, manageOpen: { ...(pending?.manageOpen ?? {}), [id]: open } };
  clearTimeout(timer); timer = setTimeout(flush, 500);
}
export function setManageOrder(order: string[] | null) {
  if (order) prefs = { ...prefs, manageOrder: order }; else { const { manageOrder: _drop, ...rest } = prefs; prefs = rest; }
  notify();
  pending = { ...pending, manageOrder: order };
  clearTimeout(timer); timer = setTimeout(flush, 300);
}

// The Manage list sections the core knows, in their default order; module sections follow "stores" (see sectionIds).
export const CORE_SECTIONS = ['add', 'onlist', 'past', 'csv', 'categories', 'stores', 'people', 'listsettings'] as const;
export const DEFAULT_OPEN: Record<string, boolean> = { add: true, onlist: true, past: true };

// Default order with module sections after "stores", then the user's order applied; sections the user's order does not know about keep their default place at the end.
export function orderSections(moduleIds: string[], saved: string[] | undefined): string[] {
  const i = CORE_SECTIONS.indexOf('stores') + 1;
  const base = [...CORE_SECTIONS.slice(0, i), ...moduleIds, ...CORE_SECTIONS.slice(i)] as string[];
  if (!saved?.length) return base;
  const known = new Set(base);
  const first = saved.filter((id, k) => known.has(id) && saved.indexOf(id) === k);
  return [...first, ...base.filter((id) => !first.includes(id))];
}
