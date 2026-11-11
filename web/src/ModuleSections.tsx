import { useState, type ReactNode } from 'react';
import { useSlots } from './slots';
import type { Me } from './types';

function Lazy({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="card" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ fontWeight: 800, cursor: 'pointer', minHeight: 32, fontSize: '1.1rem' }}>{title}</summary>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </details>
  );
}

// Sections that modules add to Settings.
export function ModuleSettingsSections({ me, onChange }: { me: Me; onChange: () => void }) {
  const sections = useSlots('settings.section', { me });
  return <>{sections.map((s) => {
    const key = `${s.moduleId}:${s.id}`;
    return s.collapsible ? <Lazy key={key} title={s.title()}><s.component me={me} onChange={onChange} /></Lazy> : <s.component key={key} me={me} onChange={onChange} />;
  })}</>;
}
