// The module's view of the app. Everything comes from the host the app hands to register(); nothing is imported from the core
// at run time (type imports are erased when the module is built).
import type { Host } from '../../../web/src/host';

let H: Host | null = null;
export const setHost = (h: Host) => { H = h; };
const h = (): Host => { if (!H) throw new Error('module host not ready'); return H; };

export const api = <T = any>(path: string, opts?: { method?: string; body?: unknown }) => h().moduleApi<T>(path, opts);
export const t = (key: string, vars?: Record<string, string | number>) => h().t(key, vars);
export const errText = (e: unknown) => h().errText(e);
export const getLang = () => h().getLang();
export const timeAgo = (ms: number | null | undefined) => h().timeAgo(ms);
export const formatMoney = (n: number, cur: string) => h().formatMoney(n, cur);
export const effectiveCurrency = (me: Parameters<Host['effectiveCurrency']>[0]) => h().effectiveCurrency(me);
