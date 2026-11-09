import type { ReactNode } from 'react';
import { DEFAULT_OPEN, setManageOpen, usePrefs } from './prefs';

// A collapsible card of the Manage list. Whether it is open is remembered per user (and follows them across devices).
export default function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const open = usePrefs().manageOpen?.[id] ?? DEFAULT_OPEN[id] ?? false;
  return (
    <details className="card" open={open} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== open) setManageOpen(id, o); }}>
      <summary style={{ fontWeight: 800, cursor: 'pointer', minHeight: 32, fontSize: '1.1rem' }}>{title}</summary>
      <div className="stack-sm" style={{ marginTop: 12 }}>{children}</div>
    </details>
  );
}
