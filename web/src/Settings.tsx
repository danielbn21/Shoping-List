import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import ModulesUser from './ModulesUser';
import ManageLayout from './ManageLayout';
import { ModuleSettingsSections } from './ModuleSections';
import { t, errText, timeAgo, availableLanguages } from './i18n';
import { CURRENCIES, currencyName, detectCurrency } from './money';
import type { Cfg, Me } from './types';

type Device = { id: number; label: string; lastSeenAt: number; current: boolean };

export default function Settings({ me, cfg, onChange, onLogout }: { me: Me; cfg: Cfg; onChange: () => void; onLogout: () => void }) {
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');

  const loadDevices = useCallback(async () => {
    try { setDevices((await api<{ devices: Device[] }>('/devices')).devices); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadDevices(); }, [loadDevices]);

  const patch = async (body: Record<string, unknown>) => {
    setError(''); setMsg('');
    try { await api('/me', { method: 'PATCH', body }); await onChange(); setMsg(t('saved')); }
    catch (e) { setError(errText(e)); }
  };
  const saveProfile = (e: FormEvent) => { e.preventDefault(); patch({ name, email }); };

  const changePw = async (e: FormEvent) => {
    e.preventDefault(); setPwErr(''); setPwMsg('');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
      setCur(''); setNext(''); setPwMsg(t('saved')); loadDevices();
    } catch (err) { setPwErr(errText(err, { minLen: cfg.minPasswordLength })); }
  };

  const revoke = async (id: number) => { await api(`/devices/${id}`, { method: 'DELETE' }); loadDevices(); };

  return (
    <div className="stack">
      <h1>{t('navSettings')}</h1>

      <form className="card stack" onSubmit={saveProfile}>
        <h2>{t('profile')}</h2>
        <label className="field"><span>{t('name')}</span>
          <input type="text" dir="auto" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="field"><span>{t('email')}</span>
          <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <div className="row">
          <button className="btn primary" type="submit">{t('save')}</button>
          {msg && <span className="ok" role="status">{msg}</span>}
          {error && <span className="error" role="alert">{error}</span>}
        </div>
      </form>

      <section className="card stack">
        <label className="field"><span>{t('language')}</span>
          <select value={me.language} onChange={(e) => patch({ language: e.target.value })}>
            {availableLanguages().map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.nativeName}</option>)}
          </select></label>
        <label className="field"><span>{t('theme')}</span>
          <select value={me.theme} onChange={(e) => patch({ theme: e.target.value })}>
            <option value="system">{t('themeSystem')}</option>
            <option value="light">{t('themeLight')}</option>
            <option value="dark">{t('themeDark')}</option>
          </select></label>
        <label className="field"><span>{t('currency')}</span>
          <select value={me.currency ?? ''} onChange={(e) => patch({ currency: e.target.value || null })}>
            <option value="">{t('currencyAuto', { code: detectCurrency() })}</option>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c)}</option>)}
          </select>
          <span className="muted" style={{ fontWeight: 400 }}>{t('currencyHelp')}</span></label>
        <label className="check"><input type="checkbox" checked={me.showAddedBy} onChange={(e) => patch({ showAddedBy: e.target.checked })} /><span>{t('showAddedBy')}</span></label>
      </section>

      <form className="card stack" onSubmit={changePw}>
        <div><h2>{t('changePassword')}</h2><p className="muted">{t('otherDevicesNote')}</p></div>
        <label className="field"><span>{t('currentPassword')}</span>
          <input type="password" dir="ltr" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
        <label className="field"><span>{t('newPassword')}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></label>
        <div className="row">
          <button className="btn primary" type="submit">{t('changePassword')}</button>
          {pwMsg && <span className="ok" role="status">{pwMsg}</span>}
          {pwErr && <span className="error" role="alert">{pwErr}</span>}
        </div>
      </form>

      <ManageLayout me={me} />

      <ModuleSettingsSections me={me} onChange={onChange} />

      <ModulesUser me={me} onChange={onChange} />

      <section className="card stack-sm">
        <h2>{t('devices')}</h2>
        {devices.map((d) => (
          <div className="row between" key={d.id}>
            <div className="grow">
              <strong>{d.label}</strong>{d.current && <span className="chip" style={{ marginInlineStart: 8 }}>{t('thisDevice')}</span>}
              <div className="muted">{t('lastActive', { when: timeAgo(d.lastSeenAt) })}</div>
            </div>
            {!d.current && <button className="btn small danger" onClick={() => revoke(d.id)}>{t('signOutDevice')}</button>}
          </div>
        ))}
      </section>

      <div><button className="btn" onClick={onLogout}>{t('signOut')}</button></div>
      <p className="muted" dir="ltr">{t('versionLine', { web: __APP_VERSION__, server: cfg.version ?? '?' })}</p>
    </div>
  );
}
