import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

export type MenuItem = { label: string; onClick: () => void; danger?: boolean };

// A small burger (☰) popover. Closes on outside tap or Escape.
export default function Menu({ label, items }: { label?: string; items: MenuItem[] }) {
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
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="iconbtn" aria-haspopup="menu" aria-expanded={open} aria-label={label ?? t('menu')} title={label ?? t('menu')} onClick={() => setOpen(!open)}>☰</button>
      {open && (
        <div className="menu-panel" role="menu">
          {items.map((i) => (
            <button type="button" role="menuitem" key={i.label} className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
