import { getLang } from './i18n';
import type { Cat } from './types';

export const catName = (c: Cat) => (getLang() === 'he' ? c.nameHe : c.nameEn);
export const fmt = (n: number) => String(Math.round(n * 100) / 100);
