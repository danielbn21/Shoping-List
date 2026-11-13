import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText, timeAgo } from './i18n';
import ModulesAdmin from './ModulesAdmin';
import type { Me } from './types';

type AdminUser = {
  id: number; username: string; email: string | null; name: string; role: 'admin' | 'user';
  disabled: boolean; mustChangePassword: boolean; lastSeenAt: number | null; devices: number;
  itemsAdded: number; purchases: number; households: string;
};
type Tab = 'users' | 'modules' | 'settings' | 'audit';

export default function Admin({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <div className="stack">
      <h1>{t('navAdmin')}</h1>
      <div className="tabs" role="group">
        {(['users', 'modules', 'settings', 'audit'] as Tab[]).map((k) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {k === 'users' ? t('adminUsers') : k === 'modules' ? t('adminModules') : k === 'settings' ? t('adminSettings') : t('adminAudit')}
          </button>
        ))}
      </div>
      {tab === 'users' && <Users me={me} />}
      {tab === 'modules' && <ModulesAdmin me={me} />}
      {tab === 'settings' && <ServerSettings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function OneTime({ name, code, onClose }: { name: string; code: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner" role="status">
      <h3>{t('otpTitle', { name })}</h3>
      <div className="code">{code}</div>
      <p>{t('otpBody')}</p>
      <div className="row">
        <button className="btn small" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); } catch { /* ignore */ } }}>
          {copied ? t('copied') : t('copy')}
        </button>
        <button className="btn small" onClick={onClose}>{t('close')}</button>
      </div>
    </div>
  );
}

function Users({ me }: { me: Me }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [households, setHouseholds] = useState<{ id: number; name: string }[]>([]);
  const [otp, setOtp] = useState<{ name: string; code: string } | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState({ name: '', username: '', email: '', role: 'user', householdId: '' });

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: AdminUser[] }>('/admin/users')).users);
      setHouseholds((await api<{ households: { id: number; name: string }[] }>('/admin/households')).households);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(errText(e)); }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ oneTimePassword?: string }>('/admin/users', {
        method: 'POST',
        body: { name: f.name, username: f.username, email: f.email || undefined, role: f.role, householdId: f.householdId ? Number(f.householdId) : undefined },
      });
      if (r.oneTimePassword) setOtp({ name: f.name, code: r.oneTimePassword });
      setF({ name: '', username: '', email: '', role: 'user', householdId: '' });
      setShowForm(false);
    });
  };

  return (
    <div className="stack">
      {otp && <OneTime name={otp.name} code={otp.code} onClose={() => setOtp(null)} />}
      {error && <p className="error" role="alert">{error}</p>}

      {!showForm ? (
        <div><button className="btn signal" onClick={() => setShowForm(true)}>{t('addUser')}</button></div>
      ) : (
        <form className="card stack" onSubmit={create}>
          <h2>{t('addUser')}</h2>
          <label className="field"><span>{t('name')}</span>
            <input type="text" dir="auto" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field"><span>{t('username')}</span>
            <input type="text" dir="ltr" required autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
          <label className="field"><span>{t('emailOptional')}</span>
            <input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field"><span>{t('joinHousehold')}</span>
            <select value={f.householdId} onChange={(e) => setF({ ...f, householdId: e.target.value })}>
              <option value="">{t('newHousehold')}</option>
              {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select></label>
          <label className="field"><span>{t('role')}</span>
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="user">{t('roleUser')}</option>
              <option value="admin">{t('roleAdmin')}</option>
            </select></label>
          <div className="row">
            <button className="btn primary" type="submit">{t('addUser')}</button>
            <button className="btn" type="button" onClick={() => setShowForm(false)}>{t('cancel')}</button>
          </div>
        </form>
      )}

      {users.map((u) => (
        <article className="card user-card" key={u.id}>
          <div className="row between">
            <div className="grow">
              <h3><bdi>{u.name}</bdi> <span className="muted" dir="ltr">@{u.username}</span></h3>
              <p className="muted">{u.lastSeenAt ? t('lastSeen', { when: timeAgo(u.lastSeenAt) }) : t('neverSeen')}</p>
            </div>
            <div className="chips">
              <span className="chip">{u.role === 'admin' ? t('roleAdmin') : t('roleUser')}</span>
              {u.disabled && <span className="chip off">{t('statusDisabled')}</span>}
              {u.mustChangePassword && <span className="chip warn">{t('statusMustChange')}</span>}
            </div>
          </div>
          <p className="muted">{u.households}</p>
          <p className="muted">{t('usageLine', { items: u.itemsAdded, buys: u.purchases, devices: u.devices })}</p>
          <div className="actions">
            <button className="btn small" onClick={() => {
              if (confirm(t('confirmReset', { name: u.name }))) run(async () => {
                const r = await api<{ oneTimePassword: string }>(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
                setOtp({ name: u.name, code: r.oneTimePassword });
              });
            }}>{t('resetPassword')}</button>
            <button className="btn small" onClick={() => run(async () => { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }); })}>
              {u.disabled ? t('enable') : t('disable')}
            </button>
            <button className="btn small" onClick={() => run(async () => { await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role: u.role === 'admin' ? 'user' : 'admin' } }); })}>
              {u.role === 'admin' ? t('makeUser') : t('makeAdmin')}
            </button>
            {u.id !== me.id && (
              <button className="btn small danger" onClick={() => {
                if (confirm(t('confirmDelete', { name: u.name }))) run(async () => { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); });
              }}>{t('deleteUser')}</button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

type SettingsData = {
  registration_mode: 'open' | 'invite-only' | 'admin-only';
  session_days: number; min_password_length: number; app_url: string; allow_user_households: boolean; estimates_default: boolean;
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
};

function ServerSettings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    api<{ settings: SettingsData }>('/admin/settings').then((r) => setS(r.settings)).catch((e) => setError(errText(e)));
  }, []);
  if (!s) return error ? <p className="error">{error}</p> : <p className="muted">{t('loading')}</p>;

  const save = async (e: FormEvent) => {
    e.preventDefault(); setMsg(''); setError('');
    try {
      const r = await api<{ settings: SettingsData }>('/admin/settings', { method: 'PUT', body: s });
      setS(r.settings); setMsg(t('saved'));
    } catch (err) { setError(errText(err)); }
  };
  const test = async () => {
    setTestMsg(''); setError('');
    try { await api('/admin/settings/test-email', { method: 'POST', body: { to: testTo } }); setTestMsg(t('testEmailOk')); }
    catch (err) { setError(errText(err)); }
  };
  const smtp = (k: keyof SettingsData['smtp'], v: string | number | boolean) => setS({ ...s, smtp: { ...s.smtp, [k]: v } });

  return (
    <form className="stack" onSubmit={save}>
      <section className="card stack">
        <h2>{t('regMode')}</h2>
        <div className="radio-group" role="radiogroup">
          {([['invite-only', t('regInvite')], ['open', t('regOpen')], ['admin-only', t('regAdmin')]] as const).map(([v, label]) => (
            <label className="check" key={v}>
              <input type="radio" name="reg" checked={s.registration_mode === v} onChange={() => setS({ ...s, registration_mode: v })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={s.allow_user_households} onChange={(e) => setS({ ...s, allow_user_households: e.target.checked })} /><span>{t('allowUserHouseholds')}</span></label>
        <label className="check"><input type="checkbox" checked={s.estimates_default} onChange={(e) => setS({ ...s, estimates_default: e.target.checked })} /><span>{t('adminEstimatesDefault')}</span></label>
        <label className="field"><span>{t('sessionDays')}</span>
          <input type="number" min={1} max={3650} value={s.session_days} onChange={(e) => setS({ ...s, session_days: Number(e.target.value) })} /></label>
        <label className="field"><span>{t('minPassword')}</span>
          <input type="number" min={6} max={64} value={s.min_password_length} onChange={(e) => setS({ ...s, min_password_length: Number(e.target.value) })} /></label>
        <label className="field"><span>{t('appUrl')}</span>
          <input type="url" dir="ltr" placeholder="https://list.example.com" value={s.app_url} onChange={(e) => setS({ ...s, app_url: e.target.value })} />
          <span className="muted" style={{ fontWeight: 400 }}>{t('appUrlHint')}</span></label>
      </section>

      <section className="card stack">
        <div><h2>{t('smtpTitle')}</h2><p className="muted">{t('smtpHint')}</p></div>
        <label className="field"><span>{t('smtpHost')}</span>
          <input type="text" dir="ltr" value={s.smtp.host} onChange={(e) => smtp('host', e.target.value)} /></label>
        <label className="field"><span>{t('smtpPort')}</span>
          <input type="number" value={s.smtp.port} onChange={(e) => smtp('port', Number(e.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={s.smtp.secure} onChange={(e) => smtp('secure', e.target.checked)} /><span>{t('smtpSecure')}</span></label>
        <label className="field"><span>{t('smtpUser')}</span>
          <input type="text" dir="ltr" autoComplete="off" value={s.smtp.user} onChange={(e) => smtp('user', e.target.value)} /></label>
        <label className="field"><span>{t('smtpPass')}</span>
          <input type="password" dir="ltr" autoComplete="new-password" value={s.smtp.pass} onChange={(e) => smtp('pass', e.target.value)} /></label>
        <label className="field"><span>{t('smtpFrom')}</span>
          <input type="text" dir="ltr" placeholder="Shopping list <list@example.com>" value={s.smtp.from} onChange={(e) => smtp('from', e.target.value)} /></label>
      </section>

      <div className="row">
        <button className="btn primary" type="submit">{t('save')}</button>
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>

      <section className="card stack-sm">
        <h3>{t('testEmail')}</h3>
        <div className="row">
          <input type="email" dir="ltr" className="grow" aria-label={t('testEmailTo')} placeholder={t('testEmailTo')} value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button className="btn" type="button" onClick={test} disabled={!testTo}>{t('testEmail')}</button>
        </div>
        {testMsg && <p className="ok" role="status">{testMsg}</p>}
      </section>
    </form>
  );
}

function Audit() {
  const [rows, setRows] = useState<{ id: number; ts: number; action: string; target: string | null; actor: string | null }[] | null>(null);
  useEffect(() => { api<{ entries: any[] }>('/admin/audit?limit=100').then((r) => setRows(r.entries)).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">{t('loading')}</p>;
  if (!rows.length) return <p className="muted">{t('noActivity')}</p>;
  return (
    <div className="card scroll-x">
      <table className="log" dir="ltr">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.actor ?? '—'}</td>
              <td>{r.action}</td>
              <td>{r.target ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
