import type { MenuItem } from './Menu';
import type { NavGroup } from './SideNav';

// The same grouped list drives the ☰ menu on a phone and the sidebar on a wider screen: This list, Household, Me, Server.
export function flattenGroups(groups: NavGroup[], current?: string): MenuItem[] {
  return groups.filter((g) => g.items.length).flatMap((g): MenuItem[] => [
    ...(g.heading ? [{ heading: g.heading } as MenuItem] : []),
    ...g.items.map((i): MenuItem => ({ label: i.label, hint: i.hint, count: i.count, danger: i.danger, onClick: i.onClick, current: current !== undefined && i.id === current })),
  ]);
}
