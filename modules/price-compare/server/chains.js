// The supermarket chains that can be compared. Platforms (portal types): 'shufersal' (its own site), 'carrefour' (its own site) and
// 'shared' (url.publishedprices.co.il, one public username per chain, empty password). Usernames and chain list come from the
// il-supermarket-compare plugin. Ids are stable app ids (kept from 1.1.x); `user` is the portal username.
// Victory and Hazi Hinam are listed but not supported yet (the plugin does not cover them); admins can try others by username.
const C = (id, nameEn, nameHe, platform, user, chainId = '') => ({ id, nameEn, nameHe, platform, user, chainId, supported: true });
export const BUILTIN = [
  C('stop_market', 'Stop Market', 'סטופ מרקט', 'shared', 'Stop_Market', '7290639000004'),
  C('shufersal', 'Shufersal', 'שופרסל', 'shufersal', '', '7290027600007'),
  C('rami_levy', 'Rami Levy', 'רמי לוי', 'shared', 'RamiLevi', '7290058140886'),
  C('carrefour', 'Carrefour', 'קרפור', 'carrefour', '', '7290055700007'),
  C('osher_ad', 'Osher Ad', 'אושר עד', 'shared', 'osherad'),
  C('yochananof', 'Yochananof', 'יוחננוף', 'shared', 'yohananof'),
  C('tiv_taam', 'Tiv Taam', 'טיב טעם', 'shared', 'TivTaam'),
  C('keshet_teamim', 'Keshet Teamim', 'קשת טעמים', 'shared', 'Keshet'),
  C('dor_alon', 'Dor Alon (am:pm)', 'דור אלון (am:pm)', 'shared', 'doralon'),
  C('freshmarket', 'Freshmarket', 'פרשמרקט', 'shared', 'freshmarket'),
  C('salach_dabach', 'Salach Dabach', 'סאלח דבאח', 'shared', 'SalachD'),
  C('politzer', 'Politzer', 'פוליצר', 'shared', 'politzer'),
  { id: 'victory', nameEn: 'Victory', nameHe: 'ויקטורי', platform: '', user: '', chainId: '', supported: false },
  { id: 'hazi_hinam', nameEn: 'Hazi Hinam', nameHe: 'חצי חינם', platform: '', user: '', chainId: '', supported: false },
];

// Chains as the app sees them right now: built-ins plus admin-added ones, with the admin's on/off switch.
export function makeChains(db) {
  const all = () => {
    const off = new Set(db.prepare('SELECT chain FROM portal_chain_state WHERE enabled = 0').all().map((r) => r.chain));
    const custom = db.prepare('SELECT id, name, portal_user FROM custom_chains ORDER BY created_at').all()
      .map((c) => ({ id: c.id, nameEn: c.name, nameHe: c.name, platform: 'shared', user: c.portal_user, chainId: '', supported: true, custom: true }));
    return [...BUILTIN, ...custom].map((c) => ({ ...c, enabled: c.supported && !off.has(c.id) }));
  };
  return {
    all,
    get: (id) => all().find((c) => c.id === id) ?? null,
    usable: (id) => { const c = all().find((x) => x.id === id); return !!c && c.supported && c.enabled; },
  };
}
export const publicChain = (c) => ({ id: c.id, nameEn: c.nameEn, nameHe: c.nameHe, supported: c.supported, enabled: c.enabled, custom: !!c.custom });
