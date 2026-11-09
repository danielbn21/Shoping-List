import { useSyncExternalStore, type ComponentType } from 'react';

// Where a module can add something to the app. A module only ever adds to these named slots; it cannot replace core screens.
export type SlotName = 'list.tab' | 'manage.section' | 'settings.section' | 'admin.section';

export type SlotDef = {
  id: string;                          // unique inside the module
  title: () => string;                 // evaluated when drawn, so a language change applies at once
  component: ComponentType<any>;       // props depend on the slot (see host.ts)
  order?: number;                      // lower first; core sections come before module sections with the same order
  visible?: (ctx: { me: any; data?: any }) => boolean;
  collapsible?: boolean;               // settings.section only: drawn closed, mounted when opened (nothing is called until then)
};
export type Registered = SlotDef & { moduleId: string; slot: SlotName };

let entries: Registered[] = [];
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; entries = [...entries]; listeners.forEach((l) => l()); };

export const slots = {
  add(moduleId: string, slot: SlotName, def: SlotDef) {
    entries = entries.filter((e) => !(e.moduleId === moduleId && e.slot === slot && e.id === def.id));
    entries.push({ ...def, moduleId, slot });
    bump();
  },
  removeModule(moduleId: string) { if (entries.some((e) => e.moduleId === moduleId)) { entries = entries.filter((e) => e.moduleId !== moduleId); bump(); } },
  get: (slot: SlotName) => entries.filter((e) => e.slot === slot).sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
};

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
// Re-renders the component when a module adds or removes something. Returns the entries visible in this context.
export function useSlots(slot: SlotName, ctx?: { me: any; data?: any }): Registered[] {
  useSyncExternalStore(subscribe, () => version);
  return slots.get(slot).filter((e) => !e.visible || !ctx || e.visible(ctx));
}
