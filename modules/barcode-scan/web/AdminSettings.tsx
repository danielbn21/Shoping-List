import { useEffect, useState } from 'react';
import { api, t, errText } from './sdk';

type Settings = { scanPerMin: number; repeatSeconds: number; savePrice: boolean; autoCategory: boolean; ranges?: Record<string, [number, number, number]> };

// The admin's settings for scanning (1.3.0). They are part of the configuration that checkpoints and config files carry.
export default function AdminSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<Settings>('/admin/settings').then(setS).catch((e) => setError(errText(e))); }, []);
  const save = async () => {
    if (!s) return;
    setError(''); setMsg('');
    try { setS(await api<Settings>('/admin/settings', { method: 'PUT', body: { scanPerMin: s.scanPerMin, repeatSeconds: s.repeatSeconds, savePrice: s.savePrice, autoCategory: s.autoCategory } })); setMsg(t('saved')); }
    catch (e) { setError(errText(e)); }
  };
  if (!s) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">{t('loading')}</p>;
  const [, pLo, pHi] = s.ranges?.scan_per_min ?? [180, 10, 600], [, rLo, rHi] = s.ranges?.repeat_seconds ?? [4, 1, 30];
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>{t('scanAdminTitle')}</h3>
      <label className="field"><span>{t('scanAdminPerMin')}</span>
        <input type="number" min={pLo} max={pHi} value={s.scanPerMin} onChange={(e) => setS({ ...s, scanPerMin: Number(e.target.value) })} />
        <span className="muted" style={{ fontWeight: 400 }}>{pLo}–{pHi}</span></label>
      <label className="field"><span>{t('scanAdminRepeat')}</span>
        <input type="number" min={rLo} max={rHi} value={s.repeatSeconds} onChange={(e) => setS({ ...s, repeatSeconds: Number(e.target.value) })} />
        <span className="muted" style={{ fontWeight: 400 }}>{rLo}–{rHi}</span></label>
      <label className="check"><input type="checkbox" checked={s.savePrice} onChange={(e) => setS({ ...s, savePrice: e.target.checked })} /><span>{t('scanAdminSavePrice')}</span></label>
      <label className="check"><input type="checkbox" checked={s.autoCategory} onChange={(e) => setS({ ...s, autoCategory: e.target.checked })} /><span>{t('scanAdminAuto')}</span></label>
      <div className="row">
        <button className="btn primary" onClick={save}>{t('save')}</button>
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
