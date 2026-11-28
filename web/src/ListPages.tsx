import type { ReactNode } from 'react';
import { t } from './i18n';
import { useSlots, type Registered } from './slots';
import type { Detail, Me } from './types';
import { CategoriesCard, CsvCard, ListSettings, PeopleCard, StoresCard } from './ManageTab';
import { HouseholdPage } from './HouseholdScreen';

export type ListPage = { id: string; group: 'list' | 'household'; title: string; hint?: string; count?: number; node: ReactNode };

// The rarely used parts of a list, one page each, in two scopes: "This list" (its name and colour, who may do what, module sections) and
// "Household" (what every list of the household shares: stores, categories, items, members). They are listed in the list's menu, drawn as a
// sidebar on a wide screen, and each opens as its own screen. A Shopper has none of them. Module sections join automatically (1.9.2).
export function useListPages(data: Detail | null, me: Me, reload: () => Promise<void>, onDeleted: () => void, extraTabs: Registered[]): ListPage[] {
  const moduleSections = useSlots('manage.section', { me, data: data ?? undefined });
  if (!data || data.list.role === 'viewer') return [];
  const isOwner = data.list.role === 'owner';
  const hh = me.households.find((h) => h.id === data.list.householdId);
  const hhOwner = hh?.role === 'owner' || me.role === 'admin';
  const hid = data.list.householdId;
  const pages: ListPage[] = [];
  if (isOwner) pages.push({ id: 'listsettings', group: 'list', title: t('listNameColour'), node: <ListSettings data={data} reload={reload} onDeleted={onDeleted} /> });
  if (isOwner) pages.push({ id: 'people', group: 'list', title: t('peopleAccess'), node: <PeopleCard data={data} /> });
  for (const m of moduleSections) pages.push({ id: `${m.moduleId}:${m.id}`, group: 'list', title: m.title(), node: <m.component data={data} me={me} reload={reload} /> });
  // A module's second and later tabs do not fit the bottom bar (one module tab at most); they open from the menu instead.
  for (const m of extraTabs) pages.push({ id: `tab:${m.moduleId}:${m.id}`, group: 'list', title: m.title(), node: <m.component data={data} me={me} reload={reload} /> });
  pages.push({ id: 'stores', group: 'household', title: t('stores'), count: data.stores.length, node: <StoresCard data={data} reload={reload} /> });
  pages.push({ id: 'categories', group: 'household', title: t('categoriesOrder'), node: <CategoriesCard data={data} reload={reload} /> });
  pages.push({ id: 'csv', group: 'household', title: t('itemsCsv'), node: <CsvCard data={data} reload={reload} /> });
  if (hh && hhOwner) pages.push({ id: 'members', group: 'household', title: t('membersInvites'), node: <HouseholdPage me={me} hid={hid} part="members" onGone={onDeleted} onChanged={reload} /> });
  if (hh) pages.push({ id: 'export', group: 'household', title: t('exportPurchasesRow'), node: <HouseholdPage me={me} hid={hid} part="export" onGone={onDeleted} onChanged={reload} /> });
  return pages;
}
