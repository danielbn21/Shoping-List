import { useEffect, useState } from 'react';
import { api, t, errText } from './sdk';

type Settings = { branchCacheDays: number; priceRefreshHours: number };

// Admin > Modules > Price comparison: how long a branch list is trusted before it is read again, and how often the price files are read.
export default function AdminSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<Settings>('/admin/settings').then(setS).catch((e) => setError(errText(e))); }, []);
  const save = async () => {
    setError(''); setMsg('');
    try { setS(await api<Settings>('/admin/settings', { method: 'PUT', body: s })); setMsg(t('saved')); } catch (e) { setError(errText(e)); }
  };
  if (!s) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('loading')}</p>;
  return (
    <div className="stack-sm">
      <label className="field"><span>{t('adminBranchCache')}</span>
        <input type="number" min={1} max={90} value={s.branchCacheDays} onChange={(e) => setS({ ...s, branchCacheDays: Number(e.target.value) })} /></label>
      <label className="field"><span>{t('adminPriceRefresh')}</span>
        <input type="number" min={1} max={168} value={s.priceRefreshHours} onChange={(e) => setS({ ...s, priceRefreshHours: Number(e.target.value) })} />
        <span className="muted" style={{ fontWeight: 400 }}>{t('adminPriceRefreshHelp')}</span></label>
      <div className="row">
        <button className="btn primary" onClick={save}>{t('save')}</button>
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
