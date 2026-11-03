import { getLang } from './i18n';
import type { Me } from './types';

export const CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'INR', 'RUB', 'UAH', 'PLN', 'CZK', 'HUF', 'RON', 'SEK', 'NOK', 'DKK', 'TRY', 'BRL', 'MXN', 'ARS', 'ZAR', 'AED', 'SAR', 'EGP', 'SGD', 'HKD', 'KRW', 'THB'];

const REGION: Record<string, string> = {
  IL: 'ILS', US: 'USD', PR: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', JP: 'JPY', CN: 'CNY', IN: 'INR', RU: 'RUB', UA: 'UAH',
  PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', SE: 'SEK', NO: 'NOK', DK: 'DKK', TR: 'TRY', BR: 'BRL', MX: 'MXN', AR: 'ARS', ZA: 'ZAR', AE: 'AED',
  SA: 'SAR', EG: 'EGP', SG: 'SGD', HK: 'HKD', KR: 'KRW', TH: 'THB',
};
const EURO = new Set('AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK'.split(' '));

// Location first (the timezone), then the browser's language region, then the language itself.
export function detectCurrency(): string {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''; } catch { /* ignore */ }
  if (/^Asia\/(Jerusalem|Tel_Aviv)$/.test(tz)) return 'ILS';
  if (/^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Indiana|Kentucky|Menominee|North_Dakota)/.test(tz) || /^US\//.test(tz) || tz === 'Pacific/Honolulu') return 'USD';
  if (/^(Europe\/London|Europe\/Belfast|GB)$/.test(tz)) return 'GBP';
  if (/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Montreal)/.test(tz)) return 'CAD';
  if (/^Australia\//.test(tz)) return 'AUD';
  if (/^Pacific\/Auckland$/.test(tz)) return 'NZD';
  if (/^Europe\/(Berlin|Paris|Madrid|Rome|Amsterdam|Brussels|Vienna|Dublin|Lisbon|Athens|Helsinki|Tallinn|Riga|Vilnius|Luxembourg|Malta|Bratislava|Ljubljana|Zagreb|Nicosia)$/.test(tz)) return 'EUR';
  const table: Record<string, string> = { 'Europe/Zurich': 'CHF', 'Europe/Warsaw': 'PLN', 'Europe/Prague': 'CZK', 'Europe/Budapest': 'HUF', 'Europe/Bucharest': 'RON', 'Europe/Stockholm': 'SEK', 'Europe/Oslo': 'NOK', 'Europe/Copenhagen': 'DKK', 'Europe/Istanbul': 'TRY', 'Europe/Moscow': 'RUB', 'Europe/Kyiv': 'UAH', 'Europe/Kiev': 'UAH', 'Asia/Tokyo': 'JPY', 'Asia/Shanghai': 'CNY', 'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Dubai': 'AED', 'Asia/Riyadh': 'SAR', 'Africa/Cairo': 'EGP', 'Africa/Johannesburg': 'ZAR', 'Asia/Singapore': 'SGD', 'Asia/Hong_Kong': 'HKD', 'Asia/Seoul': 'KRW', 'Asia/Bangkok': 'THB', 'America/Sao_Paulo': 'BRL', 'America/Mexico_City': 'MXN', 'America/Argentina/Buenos_Aires': 'ARS' };
  if (table[tz]) return table[tz];
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const region = (l.split('-')[1] ?? '').toUpperCase();
    if (REGION[region]) return REGION[region];
    if (EURO.has(region)) return 'EUR';
  }
  if (langs[0]?.toLowerCase().startsWith('he')) return 'ILS';
  return 'USD';
}

export const effectiveCurrency = (me: Pick<Me, 'currency'>) => me.currency ?? detectCurrency();

export function currencyName(code: string): string {
  try { return new Intl.DisplayNames([getLang()], { type: 'currency' }).of(code) ?? code; } catch { return code; }
}

export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—';
  try { return new Intl.NumberFormat(getLang() === 'he' ? 'he-IL' : 'en-US', { style: 'currency', currency }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
}
