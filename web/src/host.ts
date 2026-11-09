import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { api, apiUpload, ApiError } from './api';
import { t, tx, errText, getLang, timeAgo, addStrings } from './i18n';
import { formatMoney, effectiveCurrency } from './money';
import { slots, type SlotName, type SlotDef } from './slots';
import type { Me } from './types';

// What a module's browser code receives. Modules are compiled ahead of time and get React and everything below from here
// (never their own copy), so state such as the current language is shared.
export type Host = {
  coreVersion: string;
  moduleId: string;
  React: typeof React;
  jsxRuntime: typeof jsxRuntime;
  api: typeof api;
  apiUpload: typeof apiUpload;
  ApiError: typeof ApiError;
  // Module paths: api('/m/<id>/…') is what a module calls; host.moduleApi(path) adds the prefix for you.
  moduleApi: <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  errText: typeof errText;
  getLang: typeof getLang;
  timeAgo: typeof timeAgo;
  formatMoney: typeof formatMoney;
  effectiveCurrency: (me: Me) => string;
  slots: { add: (slot: SlotName, def: SlotDef) => void };
};

declare const __APP_VERSION__: string;

// Compiled modules do not bundle React: they take this copy (see scripts/build-modules.mjs).
(globalThis as any).__SL_HOST__ = { React, jsxRuntime };

export function makeHost(moduleId: string): Host {
  return {
    coreVersion: __APP_VERSION__, moduleId, React, jsxRuntime, api, apiUpload, ApiError,
    moduleApi: (p, o) => api(`/m/${moduleId}${p}`, o),
    t: tx, errText, getLang, timeAgo, formatMoney, effectiveCurrency,
    slots: { add: (slot, def) => slots.add(moduleId, slot, def) },
  };
}

// Props the core gives to the components modules register, per slot.
export type ListTabProps = { data: import('./types').Detail; me: Me; reload: () => Promise<void> };
export type ManageSectionProps = ListTabProps;
export type SettingsSectionProps = { me: Me; onChange: () => void };
export type AdminSectionProps = { me: Me };
export { addStrings };
