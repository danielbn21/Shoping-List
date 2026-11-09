import { useState } from 'react';
import { api } from './api';
import { t, errText } from './i18n';
import type { Me } from './types';

// Settings > Modules: the modules the admin has granted this user, each with the user's own switch (default on).
export default function ModulesUser({ me, onChange }: { me: Me; onChange: () => void }) {
  const [error, setError] = useState('');
  const mods = me.modules.filter((m) => m.kind === 'feature');
  const flip = async (id: string, on: boolean) => {
    setError('');
    try { await api(`/modules/${id}/me`, { method: 'PUT', body: { on } }); await onChange(); } catch (e) { setError(errText(e)); }
  };
  return (
    <section className="card stack-sm">
      <div><h2>{t('modulesTitle')}</h2><p className="muted">{t('modulesHelp')}</p></div>
      {error && <p className="error" role="alert">{error}</p>}
      {mods.length === 0 && <p className="muted">{t('modulesNone')}</p>}
      {mods.map((m) => (
        <label className="check" key={m.id} style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={m.on} onChange={(e) => flip(m.id, e.target.checked)} />
          <span><strong>{m.name}</strong> <span className="muted" dir="ltr">{t('moduleVersion', { v: m.version })}</span>
            {m.description && <span className="muted" style={{ display: 'block', fontWeight: 400 }}>{m.description}</span>}</span>
        </label>
      ))}
      {me.role === 'admin' && <p className="muted">{t('moduleAdminHint')}</p>}
    </section>
  );
}
