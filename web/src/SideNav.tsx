import type { ReactNode } from 'react';

export type NavEntry = { id: string; label: string; hint?: string; count?: number | string; danger?: boolean; onClick: () => void };
export type NavGroup = { id: string; heading?: string; items: NavEntry[] };

// The grouped list that the ☰ menu shows on a phone, drawn as a sidebar on a tablet or desktop (the same list, so nothing new to learn).
export default function SideLayout({ groups, current, label, children }: { groups: NavGroup[]; current?: string; label: string; children: ReactNode }) {
  return (
    <div className="sidelayout">
      <nav className="sidenav" aria-label={label}>
        {groups.filter((g) => g.items.length).map((g) => (
          <div key={g.id} className="sidegroup">
            {g.heading && <p className="menu-heading" role="presentation">{g.heading}</p>}
            {g.items.map((i) => (
              <button key={i.id} type="button" className={i.danger ? 'danger' : ''} aria-current={i.id === current ? 'page' : undefined} onClick={i.onClick}>
                <span className="grow" dir="auto">{i.label}</span>
                {i.count !== undefined && <span className="menu-count">{i.count}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidecontent stack">{children}</div>
    </div>
  );
}
