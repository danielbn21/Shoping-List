import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { t, errText, type Lang } from './i18n';
import type { Cfg } from './types';

type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'setup';

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void; autoComplete?: string; required?: boolean; dir?: 'ltr' | 'auto'; inputMode?: 'text' | 'email'; }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'} value={props.value} required={props.required ?? true}
        autoComplete={props.autoComplete} dir={props.dir} inputMode={props.inputMode}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function AuthScreens({ cfg, lang, setLang, onDone }: { cfg: Cfg; lang: Lang; setLang: (l: Lang) => void; onDone: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  const initial: Mode = cfg.needsSetup ? 'setup' : path === '/reset' && params.get('token') ? 'reset' : path === '/join' && params.get('code') ? 'register' : 'login';
  const [mode, setMode] = useState<Mode>(initial);
  const [f, setF] = useState({ login: '', username: '', name: '', email: '', password: '', code: params.get('code') ?? '', household: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const go = (m: Mode) => { setMode(m); setError(''); setInfo(''); };
  const finish = () => { window.history.replaceState(null, '', '/'); onDone(); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setInfo('');
    try {
      if (mode === 'login') {
        await api('/auth/login', { method: 'POST', body: { login: f.login, password: f.password } });
        finish();
      } else if (mode === 'setup') {
        await api('/setup', { method: 'POST', body: { name: f.name, username: f.username, email: f.email || undefined, password: f.password, householdName: f.household || undefined, language: lang } });
        finish();
      } else if (mode === 'register') {
        await api('/auth/register', { method: 'POST', body: { name: f.name, username: f.username, email: f.email || undefined, password: f.password, inviteCode: f.code || undefined, language: lang } });
        finish();
      } else if (mode === 'forgot') {
        await api('/auth/forgot', { method: 'POST', body: { login: f.login } });
        setInfo(cfg.emailResetAvailable ? t('resetSent') : t('resetNoEmail'));
      } else if (mode === 'reset') {
        await api('/auth/reset', { method: 'POST', body: { token: params.get('token'), password: f.password } });
        window.history.replaceState(null, '', '/');
        setF((s) => ({ ...s, password: '' }));
        go('login');
      }
    } catch (err) {
      setError(errText(err, { minLen: cfg.minPasswordLength }));
    } finally {
      setBusy(false);
    }
  }

  const title = { login: t('signIn'), register: t('createAccount'), forgot: t('forgotPassword'), reset: t('resetTitle'), setup: t('setupTitle') }[mode];
  const submitLabel = { login: t('signIn'), register: t('createAccount'), forgot: t('sendResetLink'), reset: t('setPassword'), setup: t('createAdmin') }[mode];
  const canRegister = cfg.registrationMode !== 'admin-only';

  let fields: ReactNode = null;
  if (mode === 'login') fields = (<>
    <Field label={t('loginField')} value={f.login} onChange={set('login')} autoComplete="username" dir="ltr" />
    <Field label={t('password')} type="password" value={f.password} onChange={set('password')} autoComplete="current-password" dir="ltr" />
  </>);
  if (mode === 'forgot') fields = <Field label={t('loginField')} value={f.login} onChange={set('login')} autoComplete="username" dir="ltr" />;
  if (mode === 'reset') fields = <Field label={t('newPassword')} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" dir="ltr" />;
  if (mode === 'setup' || mode === 'register') fields = (<>
    {mode === 'register' && cfg.registrationMode === 'invite-only' || mode === 'register' && f.code
      ? <Field label={t('inviteCode')} value={f.code} onChange={set('code')} dir="ltr" required={cfg.registrationMode === 'invite-only'} /> : null}
    <Field label={t('name')} value={f.name} onChange={set('name')} autoComplete="name" />
    <Field label={t('username')} value={f.username} onChange={set('username')} autoComplete="username" dir="ltr" />
    <Field label={t('emailOptional')} type="email" required={false} value={f.email} onChange={set('email')} autoComplete="email" dir="ltr" inputMode="email" />
    <Field label={t('password')} type="password" value={f.password} onChange={set('password')} autoComplete="new-password" dir="ltr" />
    {mode === 'setup' && <Field label={t('householdName')} required={false} value={f.household} onChange={set('household')} />}
  </>);

  return (
    <div className="auth">
      <div className="auth-box">
        <button className="btn link langswitch" onClick={() => setLang(lang === 'he' ? 'en' : 'he')} lang={lang === 'he' ? 'en' : 'he'}>
          {lang === 'he' ? 'English' : 'עברית'}
        </button>
        <div className="pricetag">{t('appName')}</div>
        <form className="card stack" onSubmit={submit}>
          <div>
            <h1>{title}</h1>
            {mode === 'setup' && <p className="muted" style={{ marginTop: 8 }}>{t('setupBody')}</p>}
          </div>
          {fields}
          {error && <p className="error" role="alert">{error}</p>}
          {info && <p className="ok" role="status">{info}</p>}
          <button className="btn primary" disabled={busy} type="submit">{submitLabel}</button>
          {mode === 'login' && (
            <div className="row between">
              <button type="button" className="btn link" onClick={() => go('forgot')}>{t('forgotPassword')}</button>
              {canRegister && <button type="button" className="btn link" onClick={() => go('register')}>
                {cfg.registrationMode === 'open' ? t('createAccount') : t('haveInvite')}
              </button>}
            </div>
          )}
          {(mode === 'register' || mode === 'forgot') && (
            <button type="button" className="btn link" onClick={() => go('login')}>{t('backToSignIn')}</button>
          )}
        </form>
      </div>
    </div>
  );
}

export function ChangePasswordScreen({ cfg, forced, onDone, onLogout }: { cfg: Cfg; forced?: boolean; onDone: () => void; onLogout: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: next } });
      onDone();
    } catch (err) {
      setError(errText(err, { minLen: cfg.minPasswordLength }));
    } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <div className="auth-box">
        <div className="pricetag">{t('appName')}</div>
        <form className="card stack" onSubmit={submit}>
          <div>
            <h1>{t('changePasswordTitle')}</h1>
            {forced && <p className="muted" style={{ marginTop: 8 }}>{t('changePasswordBody')}</p>}
          </div>
          <Field label={t('currentPassword')} type="password" value={cur} onChange={setCur} autoComplete="current-password" dir="ltr" />
          <Field label={t('newPassword')} type="password" value={next} onChange={setNext} autoComplete="new-password" dir="ltr" />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy} type="submit">{t('setPassword')}</button>
          <button type="button" className="btn link" onClick={onLogout}>{t('signOut')}</button>
        </form>
      </div>
    </div>
  );
}
