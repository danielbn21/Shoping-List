import { useId, useState, useEffect } from 'react';
import { api } from './api';
import { t, getLang } from './i18n';
import { catName } from './util';
import type { Cat } from './types';

// A category you can simply type. Existing categories are offered as you type (a drop-down list), and whatever is typed is matched to an
// existing category by name, ignoring case and extra spaces, in either language. Only a name that matches nothing makes a new category,
// and only when the item is actually saved (see resolveCategoryId).

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export const findCategory = (text: string, categories: Cat[]): Cat | undefined => {
  const n = norm(text);
  if (!n) return undefined;
  return categories.find((c) => norm(c.nameEn) === n || norm(c.nameHe) === n);
};

// Returns the id of the category the text names (creating it when it does not exist yet), or null for empty text.
// `made` remembers categories created a moment ago so a retried save never creates the same one twice.
export async function resolveCategoryId(text: string, categories: Cat[], householdId: number, made?: Map<string, number>): Promise<number | null> {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const hit = findCategory(clean, categories);
  if (hit) return hit.id;
  const key = norm(clean);
  const known = made?.get(key);
  if (known) return known;
  const r = await api<{ id: number }>(`/households/${householdId}/categories`, { method: 'POST', body: getLang() === 'he' ? { nameHe: clean } : { nameEn: clean } });
  made?.set(key, r.id);
  return r.id;
}

export function CategoryInput({ categories, value, onChange, onCommit, label }: {
  categories: Cat[]; value: string; onChange: (text: string) => void; onCommit?: (text: string) => void; label?: string;
}) {
  const listId = useId();
  const n = norm(value);
  const isNew = n !== '' && !findCategory(value, categories);
  return (
    <label className="field grow"><span>{label ?? t('categoryLabel')}</span>
      <input type="text" dir="auto" list={listId} value={value} autoComplete="off" enterKeyHint="done"
        placeholder={t('categoryTypeHint')}
        onChange={(e) => {
          onChange(e.target.value);
          // picking an entry from the drop-down fires a change with an exact name: commit that at once
          if (onCommit && findCategory(e.target.value, categories) && (e.nativeEvent as InputEvent).inputType === undefined) onCommit(e.target.value);
        }}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onCommit) { e.preventDefault(); onCommit((e.target as HTMLInputElement).value); } }} />
      <datalist id={listId}>{categories.map((c) => <option key={c.id} value={catName(c)} />)}</datalist>
      {isNew && <span className="muted" style={{ fontWeight: 400 }}>{t('categoryWillBeCreated', { name: value.trim() })}</span>}
    </label>
  );
}

// Text for a category id (for filling the input from an item's current category).
export const categoryText = (id: number | null, categories: Cat[]) => {
  const c = id === null ? undefined : categories.find((x) => x.id === id);
  return c ? catName(c) : '';
};

export function useCategoryText(id: number | null, categories: Cat[]) {
  const [text, setText] = useState(categoryText(id, categories));
  useEffect(() => { setText(categoryText(id, categories)); /* eslint-disable-next-line */ }, [id, categories.map((c) => c.id + catName(c)).join('|')]);
  return [text, setText] as const;
}
