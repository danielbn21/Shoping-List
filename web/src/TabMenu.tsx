import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

export type TabItem = { id: string; label: string };

// The "More" tab for narrow screens: the secondary tabs live in a drop-down so the tab row never wraps.
// It shows the name of the open secondary tab (highlighted) or "More". Closes on outside tap, Escape or a choice.
export default function TabMenu({ items, current, onPick }: { items: TabItem[]; current: string; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!items.length) return null;
  const active = items.find((i) => i.id === current);
  return (
    <div className="menu tabmenu" ref={ref}>
      <button type="button" aria-pressed={!!active} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {active ? active.label : t('tabMore')} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          {items.map((i) => (
            <button type="button" role="menuitem" key={i.id} aria-current={i.id === current ? 'page' : undefined}
              onClick={() => { setOpen(false); onPick(i.id); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
