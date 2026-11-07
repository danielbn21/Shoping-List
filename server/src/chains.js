// The supermarket chains a list can be compared across. "live" means a price adapter exists (arrives in 1.2.0);
// until then the comparison uses the household's own receipt prices for stores linked to a chain.
// "platform" is informational: which public price-transparency portal the chain publishes through.
export const CHAINS = {
  shufersal: { id: 'shufersal', nameEn: 'Shufersal', nameHe: 'שופרסל', platform: 'shufersal', live: false },
  rami_levy: { id: 'rami_levy', nameEn: 'Rami Levy', nameHe: 'רמי לוי', platform: 'cerberus', live: false },
  yochananof: { id: 'yochananof', nameEn: 'Yochananof', nameHe: 'יוחננוף', platform: 'cerberus', live: false },
  osher_ad: { id: 'osher_ad', nameEn: 'Osher Ad', nameHe: 'אושר עד', platform: 'cerberus', live: false },
  victory: { id: 'victory', nameEn: 'Victory', nameHe: 'ויקטורי', platform: 'cerberus', live: false },
  carrefour: { id: 'carrefour', nameEn: 'Carrefour', nameHe: 'קרפור', platform: 'carrefour', live: false },
  tiv_taam: { id: 'tiv_taam', nameEn: 'Tiv Taam', nameHe: 'טיב טעם', platform: 'cerberus', live: false },
  hazi_hinam: { id: 'hazi_hinam', nameEn: 'Hazi Hinam', nameHe: 'חצי חינם', platform: 'cerberus', live: false },
};
export const chainList = () => Object.values(CHAINS).map(({ id, nameEn, nameHe, live }) => ({ id, nameEn, nameHe, live }));
