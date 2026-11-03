import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText, timeAgo, type Lang } from './i18n';
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
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required /></label>
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
          <select value={me.language} onChange={(e) => patch({ language: e.target.value as Lang })}>
            <option value="en">English</option>
            <option value="he">עברית</option>
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

      <OcrSettings me={me} onChange={onChange} />

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

function OcrSettings({ me, onChange }: { me: Me; onChange: () => void }) {
  const [engine, setEngine] = useState(me.ocr.engine);
  const [provider, setProvider] = useState(me.ocr.provider);
  const [model, setModel] = useState(me.ocr.model);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const defaults: Record<string, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o', gemini: 'gemini-2.0-flash' };

  const save = async (e: FormEvent, extra: Record<string, unknown> = {}) => {
    e.preventDefault(); setError(''); setMsg('');
    try {
      await api('/me/ocr', { method: 'PUT', body: { engine, provider, model, ...(key ? { apiKey: key } : {}), ...extra } });
      setKey(''); await onChange(); setMsg(t('saved'));
    } catch (err) { setError(errText(err)); }
  };

  return (
    <form className="card stack" onSubmit={save}>
      <div><h2>{t('ocrTitle')}</h2><p className="muted">{t('ocrHelp')}</p></div>
      {!me.ocrEnabled && <p className="error">{t('ocrDisabledByAdmin')}</p>}
      <label className="field"><span>{t('ocrEngine')}</span>
        <select value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}>
          <option value="auto">{t('ocrAuto')}</option>
          <option value="local">{t('ocrLocal')}</option>
          <option value="cloud">{t('ocrCloud')}</option>
        </select></label>
      <label className="field"><span>{t('ocrProvider')}</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Google (Gemini)</option>
        </select></label>
      <label className="field"><span>{t('ocrModel')}</span>
        <input type="text" dir="ltr" autoCapitalize="none" autoCorrect="off" value={model} placeholder={defaults[provider]} onChange={(e) => setModel(e.target.value)} /></label>
      <label className="field"><span>{t('ocrKey')}</span>
        <input type="password" dir="ltr" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={me.ocr.hasKey ? '••••••••' : ''} />
        {me.ocr.hasKey && <span className="muted" style={{ fontWeight: 400 }}>{t('ocrKeySaved')}</span>}</label>
      <div className="row">
        <button className="btn primary" type="submit">{t('save')}</button>
        {me.ocr.hasKey && <button className="btn danger" type="button" onClick={(e) => save(e as unknown as FormEvent, { apiKey: '' })}>{t('ocrRemoveKey')}</button>}
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
