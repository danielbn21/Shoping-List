import type { ReactNode } from 'react';
import { t } from './i18n';
import { useSlots } from './slots';
import type { Detail, Me } from './types';
import { CategoriesCard, CsvCard, ListSettings, PeopleCard, StoresCard } from './ManageTab';

export type ListPage = { id: string; title: string; hint?: string; count?: number; node: ReactNode };

// The rarely used parts of a list, one page each. They are listed in the list's burger menu and open as their own screen,
// so Manage list itself stays short. Module sections (for example the price comparison settings) join automatically.
export function useListPages(data: Detail | null, me: Me, reload: () => Promise<void>, onDeleted: () => void): ListPage[] {
  const moduleSections = useSlots('manage.section', { me, data: data ?? undefined });
  if (!data || data.list.role === 'viewer') return [];
  const isOwner = data.list.role === 'owner';
  const pages: ListPage[] = [];
  if (isOwner) pages.push({ id: 'listsettings', title: t('listNameLabel'), node: <ListSettings data={data} reload={reload} onDeleted={onDeleted} /> });
  if (isOwner) pages.push({ id: 'people', title: t('people'), node: <PeopleCard data={data} /> });
  pages.push({ id: 'stores', title: t('stores'), count: data.stores.length, node: <StoresCard data={data} reload={reload} /> });
  for (const m of moduleSections) pages.push({ id: `${m.moduleId}:${m.id}`, title: m.title(), node: <m.component data={data} me={me} reload={reload} /> });
  pages.push({ id: 'categories', title: t('categoriesOrder'), node: <CategoriesCard data={data} reload={reload} /> });
  pages.push({ id: 'csv', title: t('csvTitle'), node: <CsvCard data={data} reload={reload} /> });
  return pages;
}
