import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, tx, errText, timeAgo, isRtl } from './i18n';
import ScreenHeader from './ScreenHeader';
import SideLayout, { type NavGroup } from './SideNav';
import Menu from './Menu';
import { flattenGroups } from './menus';
import { go, goBack, replace, parentOf } from './nav';
import { useMedia } from './util';
import { CURRENCIES, currencyName } from './money';
import ModulesAdmin from './ModulesAdmin';
import type { Me } from './types';

type AdminUser = {
  id: number; username: string; email: string | null; name: string; role: 'admin' | 'user';
  disabled: boolean; mustChangePassword: boolean; lastSeenAt: number | null; devices: number;
  itemsAdded: number; purchases: number; households: string;
  householdList?: { id: number; name: string; role: 'owner' | 'member' }[];
};
type HMember = { userId: number; name: string; username: string; role: 'owner' | 'member'; disabled: boolean };
type AdminHousehold = { id: number; name: string; createdAt: number; members: HMember[]; counts: { lists: number; items: number; trips: number; receipts: number } };
type Area = 'people' | 'modules' | 'server' | 'audit';

// Administration: four areas instead of six tabs (1.9.2). On a phone the areas are a list and each opens as its own screen with the arrow;
// from 768 px they are a sidebar. People holds Users and Households, Server holds Settings and Config.
export default function Admin({ me, route, accountGroups }: { me: Me; route: { area?: string; sub?: string; id?: number }; accountGroups: NavGroup[] }) {
  const sideBySide = useMedia('(min-width: 768px)');
  const areas: { id: Area; label: string }[] = [
    { id: 'people', label: t('adminPeople') }, { id: 'modules', label: t('adminModules') }, { id: 'server', label: t('adminServer') }, { id: 'audit', label: t('adminAudit') },
  ];
  const picked = areas.find((x) => x.id === route.area)?.id;
  const area: Area | undefined = picked ?? (sideBySide ? 'people' : undefined);
  const areaLabel = areas.find((x) => x.id === area)?.label ?? t('navAdmin');
  const open = (id: Area) => (sideBySide ? replace({ k: 'admin', area: id }) : go({ k: 'admin', area: id }));
  const groups: NavGroup[] = [{ id: 'areas', items: areas.map((x) => ({ id: x.id, label: x.label, onClick: () => open(x.id) })) }];

  const segs: Record<string, { id: string; label: string }[]> = {
    people: [{ id: 'users', label: t('adminUsers') }, { id: 'households', label: t('adminHouseholds') }],
    server: [{ id: 'settings', label: t('adminSettings') }, { id: 'config', label: t('adminConfigTab') }],
  };
  const sub = area && segs[area] ? (segs[area].find((x) => x.id === route.sub)?.id ?? segs[area][0].id) : undefined;
  const content = area && (
    <div className="stack">
      {segs[area] && sub && (
        <div className="seg" role="group" aria-label={areaLabel}>
          {segs[area].map((x) => <button key={x.id} type="button" aria-pressed={sub === x.id} onClick={() => replace({ k: 'admin', area, sub: x.id })}>{x.label}</button>)}
        </div>
      )}
      {area === 'people' && sub === 'users' && <Users me={me} />}
      {area === 'people' && sub === 'households' && <Households me={me} openId={route.id ?? null} onOpen={(id) => (id === null ? goBack({ k: 'admin', area: 'people', sub: 'households' }) : go({ k: 'admin', area: 'people', sub: 'households', id }))} />}
      {area === 'modules' && <ModulesAdmin me={me} />}
      {area === 'server' && sub === 'settings' && <ServerSettings />}
      {area === 'server' && sub === 'config' && <Configuration />}
      {area === 'audit' && <Audit />}
    </div>
  );

  const parent = parentOf({ k: 'admin', ...route });
  return (
    <div className="stack">
      <ScreenHeader title={areaLabel} scope={area ? t('navAdmin') : t('scopeServer')} onBack={() => goBack(parent)} backLabel={area && !sideBySide ? t('backTo', { name: t('navAdmin') }) : t('backGeneric')}
        crumbs={[{ label: t('navHome'), onClick: () => go({ k: 'home' }) }, { label: t('navAdmin'), onClick: area ? () => go({ k: 'admin' }) : undefined }, ...(area ? [{ label: areaLabel }] : [])]}
        right={<Menu items={flattenGroups(accountGroups, 'admin')} />} />
      {sideBySide
        ? <SideLayout groups={groups} current={area} label={t('navAdmin')}>{content}</SideLayout>
        : area ? content : (
          <nav className="card arealist" aria-label={t('navAdmin')}>
            {areas.map((x) => <button key={x.id} type="button" onClick={() => open(x.id)}><span className="grow">{x.label}</span><span aria-hidden="true" className="chev">{isRtl() ? '‹' : '›'}</span></button>)}
          </nav>
        )}
    </div>
  );
}

// What the server already lets an admin do in any household (households.js); the screens below only call it.
const hhApi = {
  setRole: (hid: number, uid: number, role: string) => api(`/households/${hid}/members/${uid}`, { method: 'PATCH', body: { role } }),
  remove: (hid: number, uid: number, isMe: boolean) => (isMe ? api(`/households/${hid}/leave`, { method: 'POST' }) : api(`/households/${hid}/members/${uid}`, { method: 'DELETE' })),
  add: (hid: number, username: string, role: string) => api(`/households/${hid}/members`, { method: 'POST', body: { username, role } }),
};

function RoleSelect({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  return <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 'auto' }}><option value="owner">{t('roleOwner')}</option><option value="member">{t('roleMember')}</option></select>;
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
          <details>
            <summary>{t('hhUserHouseholds', { n: u.householdList?.length ?? 0 })}</summary>
            <div className="stack-sm">
              {(u.householdList ?? []).length === 0 && <p className="muted">{t('hhNoHouseholds')}</p>}
              {(u.householdList ?? []).map((h) => (
                <div className="row" key={h.id} style={{ gap: 8 }}>
                  <span className="grow"><bdi>{h.name}</bdi></span>
                  <RoleSelect value={h.role} label={`${h.name}: ${t('role')}`} onChange={(v) => run(async () => { await hhApi.setRole(h.id, u.id, v); })} />
                  <button className="btn small danger" aria-label={t('hhRemoveFrom', { name: h.name })} onClick={() => run(async () => { await hhApi.remove(h.id, u.id, u.id === me.id); })}>✕</button>
                </div>
              ))}
              <AddToHousehold user={u} households={households.filter((h) => !(u.householdList ?? []).some((x) => x.id === h.id))} onAdd={(hid, role) => run(async () => { await hhApi.add(hid, u.username, role); })} />
              <p className="muted">{t('hhRemoveNote')}</p>
            </div>
          </details>
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
  default_language: string; default_currency: string;
  max_image_mb: number; max_module_mb: number; max_csv_mb: number; max_trip_lines: number;
  rl_login_per_min: number; rl_register_per_min: number; rl_forgot_per_min: number; rl_reset_per_min: number;
  invite_default_days: number; invite_max_days: number; invite_max_uses: number;
};
type FieldMeta = { type: string; min?: number; max?: number; values?: string[]; group?: string };
type ServerInfo = { version: string; node: string; port: string; dataDir: string; modulesDir: string; ocrLangs: string };
type NumKey = 'max_image_mb' | 'max_module_mb' | 'max_csv_mb' | 'max_trip_lines' | 'rl_login_per_min' | 'rl_register_per_min' | 'rl_forgot_per_min' | 'rl_reset_per_min' | 'invite_default_days' | 'invite_max_days' | 'invite_max_uses';

function ServerSettings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [fields, setFields] = useState<Record<string, FieldMeta>>({});
  const [languages, setLanguages] = useState<string[]>(['en']);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    api<{ settings: SettingsData; fields: Record<string, FieldMeta>; languages: string[]; server: ServerInfo }>('/admin/settings')
      .then((r) => { setS(r.settings); setFields(r.fields); setLanguages(r.languages); setServer(r.server); }).catch((e) => setError(errText(e)));
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

      {([['setGroupLimits', 'limits'], ['setGroupAbuse', 'abuse']] as const).map(([title, group]) => (
        <section className="card stack" key={group}>
          <h2>{t(title)}</h2>
          {(Object.keys(fields) as NumKey[]).filter((k) => fields[k].group === group).map((k) => (
            <label className="field" key={k}><span>{tx(`set_${k}`)}</span>
              <input type="number" inputMode="numeric" min={fields[k].min} max={fields[k].max} value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
              <span className="muted" style={{ fontWeight: 400 }}>{t('setRange', { min: fields[k].min ?? 0, max: fields[k].max ?? 0 })}</span></label>
          ))}
        </section>
      ))}

      <section className="card stack">
        <h2>{t('setGroupDefaults')}</h2>
        <label className="field"><span>{t('set_default_language')}</span>
          <select value={s.default_language} onChange={(e) => setS({ ...s, default_language: e.target.value })}>{languages.map((c) => <option key={c} value={c}>{c === 'en' ? 'English' : (() => { try { return new Intl.DisplayNames([c], { type: 'language' }).of(c) ?? c; } catch { return c; } })()}</option>)}</select></label>
        <label className="field"><span>{t('set_default_currency')}</span>
          <select value={s.default_currency} onChange={(e) => setS({ ...s, default_currency: e.target.value })}><option value="auto">{t('setCurrencyAuto')}</option>{CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c)}</option>)}</select></label>
      </section>

      {server && (
        <section className="card stack">
          <div><h2>{t('setGroupServer')}</h2><p className="muted">{t('setServerNote')}</p></div>
          <dl className="kv" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }} data-testid="server-info">
            {([['setServerVersion', server.version], ['setServerNode', server.node], ['setServerPort', server.port], ['setServerData', server.dataDir], ['setServerModules', server.modulesDir], ['setServerOcr', server.ocrLangs]] as const).map(([k, v]) => (
              <Fragment key={k}><dt className="muted">{t(k)}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }} dir="ltr">{v}</dd></Fragment>
            ))}
          </dl>
        </section>
      )}

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

function AddToHousehold({ user, households, onAdd }: { user: AdminUser; households: { id: number; name: string }[]; onAdd: (hid: number, role: string) => void }) {
  const [hid, setHid] = useState('');
  const [role, setRole] = useState('member');
  if (!households.length) return null;
  return (
    <div className="row" style={{ gap: 8 }}>
      <select aria-label={`${user.name}: ${t('hhAddTo')}`} value={hid} onChange={(e) => setHid(e.target.value)} className="grow"><option value="">{t('hhAddTo')}</option>{households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
      <RoleSelect value={role} label={t('role')} onChange={setRole} />
      <button className="btn small" disabled={!hid} onClick={() => { onAdd(Number(hid), role); setHid(''); }}>{t('hhAdd')}</button>
    </div>
  );
}

function Households({ me, openId, onOpen }: { me: Me; openId: number | null; onOpen: (id: number | null) => void }) {
  const [hs, setHs] = useState<AdminHousehold[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const open = openId;
  const setOpen = onOpen;
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [nf, setNf] = useState({ name: '', ownerId: String(me.id) });
  const [rename, setRename] = useState('');
  const [add, setAdd] = useState({ userId: '', role: 'member' });
  const [del, setDel] = useState<{ id: number; typed: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setHs((await api<{ households: AdminHousehold[] }>('/admin/households')).households);
      setUsers((await api<{ users: AdminUser[] }>('/admin/users')).users);
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); await load(); } catch (e) { setError(errText(e)); } };
  const when = (ms: number) => new Date(ms).toLocaleDateString();

  const h = hs.find((x) => x.id === open) ?? null;
  useEffect(() => { if (h) setRename(h.name); }, [h?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const owners = (x: AdminHousehold) => x.members.filter((m) => m.role === 'owner').map((m) => m.name).join(', ');

  if (h) {
    const candidates = users.filter((u) => !u.disabled && !h.members.some((m) => m.userId === u.id));
    return (
      <div className="stack">
        {error && <p className="error" role="alert">{error}</p>}
        <div className="card stack">
          <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (rename.trim() && rename.trim() !== h.name) run(async () => { await api(`/households/${h.id}`, { method: 'PATCH', body: { name: rename.trim() } }); }); }}>
            <input type="text" dir="auto" aria-label={t('hhName')} value={rename} onChange={(e) => setRename(e.target.value)} className="grow" maxLength={60} />
            <button className="btn small" type="submit" disabled={!rename.trim() || rename.trim() === h.name}>{t('rename')}</button>
          </form>
          <p className="muted">{t('hhCounts', h.counts)} · {when(h.createdAt)}</p>
          <div className="stack-sm">
            {h.members.map((m) => (
              <div className="row" key={m.userId} style={{ gap: 8 }}>
                <span className="grow"><bdi>{m.name}</bdi> <span className="muted" dir="ltr">@{m.username}</span>{m.disabled && <span className="chip off"> {t('statusDisabled')}</span>}</span>
                <RoleSelect value={m.role} label={`${m.name}: ${t('role')}`} onChange={(v) => run(async () => { await hhApi.setRole(h.id, m.userId, v); })} />
                <button className="btn small danger" aria-label={t('hhRemoveFrom', { name: m.name })} onClick={() => run(async () => { await hhApi.remove(h.id, m.userId, m.userId === me.id); })}>✕</button>
              </div>
            ))}
          </div>
          {candidates.length > 0 && (
            <div className="row" style={{ gap: 8 }}>
              <select aria-label={t('hhAddUser')} value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })} className="grow"><option value="">{t('hhAddUser')}</option>{candidates.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}</select>
              <RoleSelect value={add.role} label={t('role')} onChange={(v) => setAdd({ ...add, role: v })} />
              <button className="btn small" disabled={!add.userId} onClick={() => { const u = users.find((x) => x.id === Number(add.userId)); if (u) run(async () => { await hhApi.add(h.id, u.username, add.role); setAdd({ userId: '', role: 'member' }); }); }}>{t('hhAdd')}</button>
            </div>
          )}
          <p className="muted">{t('hhLastOwnerNote')}</p>
        </div>

        {!del || del.id !== h.id ? (
          <div><button className="btn danger" onClick={() => setDel({ id: h.id, typed: '' })}>{t('hhDelete')}</button></div>
        ) : (
          <form className="card stack" data-testid="hh-delete" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/households/${h.id}`, { method: 'DELETE', body: { confirmName: del.typed } }); setOpen(null); setDel(null); }); }}>
            <h2 className="error">{t('hhDeleteTitle', { name: h.name })}</h2>
            <p>{t('hhDeleteWhat')}</p>
            <ul>
              <li>{t('hhDeleteLists', { lists: h.counts.lists, items: h.counts.items })}</li>
              <li>{t('hhDeleteTrips', { trips: h.counts.trips })}</li>
              {h.counts.receipts > 0 && <li>{t('hhDeleteReceipts', { n: h.counts.receipts })}</li>}
              <li>{t('hhDeleteOther')}</li>
            </ul>
            <p className="muted">{t('hhDeleteMembers', { n: h.members.length })}</p>
            <label className="field"><span>{t('hhTypeName')}</span><input type="text" dir="auto" autoFocus placeholder={h.name} value={del.typed} onChange={(e) => setDel({ ...del, typed: e.target.value })} /></label>
            <div className="row">
              <button className="btn danger" type="submit" disabled={del.typed.trim().toLowerCase() !== h.name.trim().toLowerCase()}>{t('hhDeleteBtn')}</button>
              <button className="btn" type="button" onClick={() => setDel(null)}>{t('cancel')}</button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <p className="error" role="alert">{error}</p>}
      {!showNew ? (
        <div><button className="btn signal" onClick={() => setShowNew(true)}>{t('hhNew')}</button></div>
      ) : (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api<{ id: number }>('/admin/households', { method: 'POST', body: { name: nf.name, ownerId: Number(nf.ownerId) } }); setNf({ name: '', ownerId: String(me.id) }); setShowNew(false); setOpen(r.id); setRename(nf.name.trim()); }); }}>
          <label className="field"><span>{t('hhName')}</span><input type="text" dir="auto" required maxLength={60} value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></label>
          <label className="field"><span>{t('hhOwnerLabel')}</span>
            <select value={nf.ownerId} onChange={(e) => setNf({ ...nf, ownerId: e.target.value })}>{users.filter((u) => !u.disabled).map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username})</option>)}</select></label>
          <div className="row"><button className="btn primary" type="submit">{t('hhCreate')}</button><button className="btn" type="button" onClick={() => setShowNew(false)}>{t('cancel')}</button></div>
        </form>
      )}
      {hs.map((x) => (
        <button key={x.id} className="card" style={{ textAlign: 'start', width: '100%' }} onClick={() => { setOpen(x.id); setRename(x.name); setError(''); }}>
          <h3><bdi>{x.name}</bdi></h3>
          <p className="muted">{t('hhSummary', { members: x.members.length, lists: x.counts.lists, when: when(x.createdAt) })} · {t('hhOwners', { names: owners(x) })}</p>
        </button>
      ))}
    </div>
  );
}

type Checkpoint = { id: number; createdAt: number; kind: 'auto' | 'named' | 'restore'; name: string | null; keys: string[]; by: string | null };
type CfgPlan = { changes: { key: string; from: unknown; to: unknown }[]; skipped: { key: string; reason: string }[]; warnings: { code: string; detail: string }[]; restorePointId?: number | null; failed?: { key: string }[] };
type CfgSource = { checkpointId: number } | { data: unknown };

// A setting's name as the screens show it (keys of modules: "module <id>: <key>").
const cfgLabel = (key: string) => {
  if (key.startsWith('module:')) { const [, id, k] = key.split(':'); return k === 'enabled' ? t('cfgModuleEnabled', { id }) : `${id}: ${k}`; }
  const s = tx(`set_${key}`);
  return s === `set_${key}` ? key : s;
};
const cfgValue = (v: unknown) => (typeof v === 'boolean' ? (v ? t('on') : t('off')) : Array.isArray(v) ? `${v.length} …` : v === '' || v === null || v === undefined ? '—' : String(v));

function Configuration() {
  const [list, setList] = useState<Checkpoint[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [view, setView] = useState<{ title: string; source: CfgSource; plan: CfgPlan } | null>(null);

  const load = useCallback(async () => {
    try { setList((await api<{ checkpoints: Checkpoint[] }>('/admin/config/checkpoints')).checkpoints); } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<void>) => { setError(''); setMsg(''); try { await fn(); } catch (e) { setError(errText(e)); } };

  const title = (c: Checkpoint) => (c.kind === 'named' ? (c.name || t('cfgNamed')) : c.kind === 'restore' ? t('cfgRestorePoint') : t('cfgBefore', { keys: c.keys.slice(0, 3).map(cfgLabel).join(', ') + (c.keys.length > 3 ? ' …' : '') }));
  const preview = (name: string, source: CfgSource) => run(async () => {
    const plan = await api<CfgPlan>('/admin/config/preview', { method: 'POST', body: source });
    setView({ title: name, source, plan });
  });
  const apply = () => view && run(async () => {
    const r = await api<CfgPlan>('/admin/config/restore', { method: 'POST', body: view.source });
    setView(null); await load();
    setMsg(r.failed?.length ? t('cfgFailedSome', { items: r.failed.map((f) => cfgLabel(f.key)).join(', ') }) : t('cfgRestored'));
  });
  const fromFile = (f: File | null) => run(async () => {
    if (!f) return;
    let data: unknown;
    try { data = JSON.parse(await f.text()); } catch { throw new Error('not_a_config_file'); }
    await preview(t('cfgFromFile', { name: f.name.slice(0, 40) }), { data });
  });

  if (view) {
    const p = view.plan;
    return (
      <div className="stack">
        {error && <p className="error" role="alert">{error}</p>}
        <section className="card stack" data-testid="cfg-preview">
          <h2>{t('cfgPreviewTitle', { name: view.title })}</h2>
          {p.changes.length === 0 ? <p>{t('cfgNoChanges')}</p> : (
            <>
              <p>{t('cfgChangeCount', { n: p.changes.length })}</p>
              <div className="stack-sm">
                {p.changes.map((c) => (
                  <div className="row between" key={c.key} style={{ gap: 8 }}><span>{cfgLabel(c.key)}</span><span className="muted" dir="auto">{cfgValue(c.from)} → {cfgValue(c.to)}</span></div>
                ))}
              </div>
            </>
          )}
          {p.skipped.length > 0 && <p className="muted">{t('cfgSkipped', { items: p.skipped.map((x) => `${cfgLabel(x.key)} (${tx(`cfgReason_${x.reason}`)})`).join(', ') })}</p>}
          {p.warnings.length > 0 && <p className="muted">{t('cfgWarn', { items: p.warnings.map((w) => w.detail).join(', ') })}</p>}
          <p className="muted">{t('cfgModulesNote')}</p>
          <div className="row">
            {p.changes.length > 0 && <button className="btn primary" onClick={apply}>{t('cfgApply')}</button>}
            <button className="btn" onClick={() => setView(null)}>{t('cancel')}</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p className="ok" role="status">{msg}</p>}
      <section className="card stack">
        {naming === null ? (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => setNaming('')}>{t('cfgSave')}</button>
            <a className="btn" href="/api/admin/config/export" download>{t('cfgDownload')}</a>
            <label className="btn filebtn">{t('cfgRestoreFile')}<input type="file" accept="application/json,.json" hidden onChange={(e) => { fromFile(e.target.files?.[0] ?? null); e.target.value = ''; }} /></label>
          </div>
        ) : (
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/admin/config/checkpoints', { method: 'POST', body: { name: naming } }); setNaming(null); await load(); }); }}>
            <input type="text" dir="auto" autoFocus aria-label={t('cfgName')} placeholder={t('cfgName')} maxLength={80} value={naming} onChange={(e) => setNaming(e.target.value)} className="grow" />
            <button className="btn primary" type="submit">{t('cfgSaveNow')}</button>
            <button className="btn" type="button" onClick={() => setNaming(null)}>{t('cancel')}</button>
          </form>
        )}
        <p className="muted">{t('cfgAutoNote')}</p>
        <p className="muted">{t('cfgSecretNote')}</p>
      </section>

      <h2>{t('cfgCheckpoints', { n: list.length })}</h2>
      {list.length === 0 && <p className="muted">{t('cfgNone')}</p>}
      {list.map((c) => (
        <article className="card stack-sm" key={c.id} data-testid="cfg-checkpoint">
          <div>
            <strong dir="auto">{title(c)}</strong>
            <div className="muted" style={{ fontSize: '.85rem' }}>{new Date(c.createdAt).toLocaleString()} · {t(c.kind === 'auto' ? 'cfgAuto' : c.kind === 'named' ? 'cfgNamed' : 'cfgRestorePoint')}{c.by ? ` · ${t('cfgBy', { name: c.by })}` : ''}</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => preview(title(c), { checkpointId: c.id })}>{t('cfgRestore')}</button>
            <a className="btn small" href={`/api/admin/config/checkpoints/${c.id}/export`} download>{t('cfgDownloadOne')}</a>
            <button className="btn small danger" onClick={() => { if (confirm(t('cfgConfirmDelete'))) run(async () => { await api(`/admin/config/checkpoints/${c.id}`, { method: 'DELETE' }); await load(); }); }}>{t('cfgDelete')}</button>
          </div>
        </article>
      ))}
    </div>
  );
}
