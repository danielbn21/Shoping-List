import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from './i18n';

// One entry of a menu: an action, or a small heading that starts a group of actions.
export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; hint?: string; count?: number | string; current?: boolean; heading?: undefined }
  | { heading: string; label?: undefined };

// A burger (☰) menu. On a phone it opens as a sheet from the bottom edge (easy to reach with a thumb), on a wider screen as a small popover.
// Closes on outside tap, Escape or a choice. `icon` replaces the three lines; `compact` keeps the old small look for the little in-page menus.
export default function Menu({ label, items, icon }: { label?: string; items: MenuItem[]; icon?: ReactNode }) {
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
  if (!items.some((i) => i.heading === undefined)) return null;
  const name = label ?? t('menu');
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="iconbtn" aria-haspopup="menu" aria-expanded={open} aria-label={name} title={name} onClick={() => setOpen(!open)}>{icon ?? <span aria-hidden="true">☰</span>}</button>
      {open && <div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="menu-panel" role="menu" aria-label={name}>
          <span className="menu-grab" aria-hidden="true" />
          {items.map((i, k) => i.heading !== undefined
            ? <p key={`h${k}`} className="menu-heading" role="presentation">{i.heading}</p>
            : (
              <button type="button" role="menuitem" key={`${k}:${i.label}`} className={i.danger ? 'danger' : ''} aria-current={i.current ? 'page' : undefined}
                onClick={() => { setOpen(false); i.onClick(); }}>
                <span className="grow">{i.label}{i.hint && <small className="muted" style={{ display: 'block', fontWeight: 400 }}>{i.hint}</small>}</span>
                {i.count !== undefined && <span className="menu-count">{i.count}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
