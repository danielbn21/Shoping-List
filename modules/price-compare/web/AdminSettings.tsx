import { useEffect, useState } from 'react';
import { api, t, errText } from './sdk';

// Admin > Modules > Price comparison: how long a branch list is trusted before it is read again.
export default function AdminSettings() {
  const [days, setDays] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<{ branchCacheDays: number }>('/admin/settings').then((r) => setDays(r.branchCacheDays)).catch((e) => setError(errText(e))); }, []);
  const save = async () => {
    setError(''); setMsg('');
    try { await api('/admin/settings', { method: 'PUT', body: { branchCacheDays: days } }); setMsg(t('saved')); } catch (e) { setError(errText(e)); }
  };
  if (days === null) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('loading')}</p>;
  return (
    <div className="stack-sm">
      <label className="field"><span>{t('adminBranchCache')}</span>
        <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
      <div className="row">
        <button className="btn primary" onClick={save}>{t('save')}</button>
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
