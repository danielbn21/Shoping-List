import { useEffect, useState } from 'react';
import { getLang } from './i18n';
import type { Cat } from './types';

export const catName = (c: Cat) => (getLang() === 'he' ? c.nameHe : c.nameEn);
export const fmt = (n: number) => String(Math.round(n * 100) / 100);

// True while the media query matches (re-evaluated when the window changes). useNarrow is the phone-width case.
export function useMedia(query: string) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setNarrow(m.matches);
    m.addEventListener('change', f);
    f();
    return () => m.removeEventListener('change', f);
  }, [query]);
  return narrow;
}
export const useNarrow = (query = '(max-width: 640px)') => useMedia(query);
