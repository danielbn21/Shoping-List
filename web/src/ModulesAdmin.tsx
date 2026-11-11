import { useCallback, useEffect, useState } from 'react';
import { api, apiUpload, ApiError } from './api';
import { t, errText } from './i18n';
import { useSlots } from './slots';
import type { Me } from './types';

type Mod = {
  id: string; name: string; kind: string; version: string; prevVersion: string | null; enabled: boolean; status: 'installed' | 'quarantined'; error: string | null;
  source: 'bundled' | 'upload'; sha256: string | null; description: string; provides: string[]; slots: string[]; dependsOn: string[]; loaded: boolean;
  needsRestart: boolean; removePending: boolean; dependents: string[];
};
type Listing = { coreVersion: string; modules: Mod[]; available: { id: string; name: string; version: string; description: string }[] };
type Staged = { token: string; manifest: { id: string; name: string; version: string; description: string }; sha256: string; installed: { version: string } | null };
type AccessUser = { id: number; username: string; name: string; granted: boolean; on: boolean };

const detailOf = (e: unknown) => (e instanceof ApiError && e.detail ? ` (${e.detail})` : '');

// Admin > Modules: install (zip upload with confirmation), switch on and off, who may use each, roll back, uninstall, restart.
export default function ModulesAdmin({ me }: { me: Me }) {
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [staged, setStaged] = useState<Staged | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [configFor, setConfigFor] = useState<string | null>(null);
  const adminSlots = useSlots('admin.section', { me }); // what each module offers to configure (registered by the module's browser code)

  const load = useCallback(async () => {
    try { setList(await api<Listing>('/admin/modules')); } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, ok = '') => {
    setError(''); setMsg(''); setBusy(true);
    try { await fn(); if (ok) setMsg(ok); await load(); } catch (e) { setError(errText(e) + detailOf(e)); } finally { setBusy(false); }
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    run(async () => {
      const blob = new Blob([await file.arrayBuffer()], { type: 'application/zip' });
      setStaged(await apiUpload<Staged>('/admin/modules/inspect', blob));
    });
  };
  const install = () => staged && run(async () => { await api('/admin/modules/install', { method: 'POST', body: { token: staged.token } }); setStaged(null); }, t('modInstalled'));

  const uninstall = (m: Mod) => {
    if (!confirm(t('modUninstallConfirm', { name: m.name }))) return;
    const deleteData = confirm(`${t('modDeleteData')}?\n\nOK = ${t('modDeleteData')}\n${t('cancel')} = no`);
    run(() => api(`/admin/modules/${m.id}/uninstall`, { method: 'POST', body: { deleteData } }));
  };

  const openAccess = async (id: string) => {
    if (accessFor === id) { setAccessFor(null); return; }
    try { setUsers((await api<{ users: AccessUser[] }>(`/admin/modules/${id}/access`)).users); setAccessFor(id); } catch (e) { setError(errText(e)); }
  };
  const grant = async (id: string, userId: number, granted: boolean) => {
    try { setUsers((await api<{ users: AccessUser[] }>(`/admin/modules/${id}/access`, { method: 'PUT', body: { userId, granted } })).users); } catch (e) { setError(errText(e)); }
  };

  // After the restart request the server goes away and comes back; reload once it answers.
  const restart = async () => {
    if (!confirm(t('modRestartConfirm'))) return;
    setError(''); setBusy(true);
    try { await api('/admin/server/restart', { method: 'POST', body: {} }); } catch (e) { setError(errText(e)); setBusy(false); return; }
    setRestarting(true);
    await new Promise((r) => setTimeout(r, 2500));
    for (let i = 0; i < 90; i++) {
      try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch { /* still down */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    setRestarting(false); setBusy(false);
  };

  if (restarting) return <p className="card" role="status">{t('modRestarting')}</p>;
  const anyRestart = !!list?.modules.some((m) => m.needsRestart);

  return (
    <div className="stack">
      <section className="card stack-sm">
        <div><h2>{t('adminModules')}</h2><p className="muted">{t('modAdminHelp')}</p></div>
        {error && <p className="error" role="alert">{error}</p>}
        {msg && <p className="ok" role="status">{msg}</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="btn primary" style={{ cursor: 'pointer' }}>{t('modInstallBtn')}
            <input type="file" accept=".zip,application/zip" hidden disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <button className={`btn${anyRestart ? ' primary' : ''}`} disabled={busy} onClick={restart}>{t('modRestart')}</button>
          {anyRestart && <span className="chip warn">{t('modNeedsRestart')}</span>}
        </div>
        {staged && (
          <div className="card stack-sm" role="dialog" aria-label={t('modConfirmTitle', { name: staged.manifest.name, v: staged.manifest.version })}>
            <h3 style={{ margin: 0 }}>{t('modConfirmTitle', { name: staged.manifest.name, v: staged.manifest.version })}</h3>
            {staged.manifest.description && <p className="muted" style={{ margin: 0 }}>{staged.manifest.description}</p>}
            {staged.installed && <p style={{ margin: 0 }}>{t('modReplaces', { v: staged.installed.version })}</p>}
            <p className="muted" style={{ margin: 0 }}>{t('modHash')}:<br /><code dir="ltr" style={{ wordBreak: 'break-all' }}>{staged.sha256}</code></p>
            <p className="error" style={{ margin: 0 }}>{t('modConfirmBody')}</p>
            <div className="row"><button className="btn primary" disabled={busy} onClick={install}>{t('modInstall')}</button><button className="btn" onClick={() => setStaged(null)}>{t('cancel')}</button></div>
          </div>
        )}
      </section>

      {!list && !error && <p className="muted">{t('loading')}</p>}
      {list && list.modules.length === 0 && <p className="muted">{t('modNone')}</p>}
      {list?.modules.map((m) => (
        <section className="card stack-sm" key={m.id}>
          <div className="row between" style={{ flexWrap: 'wrap' }}>
            <div className="grow">
              <strong>{m.name}</strong> <span className="muted" dir="ltr">{t('moduleVersion', { v: m.version })}</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                <span className={`chip${m.status === 'quarantined' ? ' warn' : ''}`}>{m.status === 'quarantined' ? t('modStatus_quarantined') : m.loaded ? t('modRunning') : m.enabled ? t('modStatus_installed') : t('modOff')}</span>
                <span className="chip">{m.source === 'bundled' ? t('modSourceBundled') : t('modSourceUpload')}</span>
                {m.needsRestart && <span className="chip warn">{t('modNeedsRestart')}</span>}
              </div>
            </div>
          </div>
          {m.description && <p className="muted" style={{ margin: 0 }}>{m.description}</p>}
          {m.provides.length > 0 && <p className="muted" style={{ margin: 0 }} dir="ltr">{t('modProvides', { list: m.provides.join(', ') })}</p>}
          {m.dependsOn.length > 0 && <p className="muted" style={{ margin: 0 }} dir="ltr">{t('modDeps', { list: m.dependsOn.join(', ') })}</p>}
          {m.error && <p className="error" style={{ margin: 0 }} dir="ltr">{t('modError', { e: m.error })}</p>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {m.enabled
              ? <button className="btn small" disabled={busy || m.dependents.length > 0} onClick={() => run(() => api(`/admin/modules/${m.id}/disable`, { method: 'POST', body: {} }))}>{t('modDisable')}</button>
              : <button className="btn small primary" disabled={busy || m.removePending} onClick={() => run(() => api(`/admin/modules/${m.id}/enable`, { method: 'POST', body: {} }))}>{t('modEnable')}</button>}
            {adminSlots.some((s) => s.moduleId === m.id) && m.enabled && <button className="btn small" aria-expanded={configFor === m.id} onClick={() => setConfigFor(configFor === m.id ? null : m.id)}>{t('modConfigure')}</button>}
            {m.kind === 'feature' && <button className="btn small" aria-expanded={accessFor === m.id} onClick={() => openAccess(m.id)}>{t('modAccess')}</button>}
            {m.prevVersion && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/admin/modules/${m.id}/rollback`, { method: 'POST', body: {} }))}>{t('modRollback', { v: m.prevVersion })}</button>}
            <button className="btn small danger" disabled={busy || m.dependents.length > 0 || m.removePending} onClick={() => uninstall(m)}>{t('modUninstall')}</button>
          </div>
          {configFor === m.id && (
            <div className="stack config-panel" style={{ borderTop: '1px solid var(--border, #d6dccf)', paddingTop: 12 }}>
              {adminSlots.filter((s) => s.moduleId === m.id).map((s, _i, all) => (
                <section className="stack-sm" key={s.id}>{all.length > 1 && <h3 style={{ margin: 0 }}>{s.title()}</h3>}<s.component me={me} /></section>
              ))}
            </div>
          )}
          {accessFor === m.id && (
            <div className="stack-sm">
              <p className="muted" style={{ margin: 0 }}>{t('modAccessHelp')}</p>
              {users.map((u) => (
                <label className="check" key={u.id}><input type="checkbox" checked={u.granted} onChange={(e) => grant(m.id, u.id, e.target.checked)} /><span><bdi>{u.name}</bdi> <span className="muted" dir="ltr">@{u.username}</span></span></label>
              ))}
            </div>
          )}
        </section>
      ))}

      {list && list.available.length > 0 && (
        <section className="card stack-sm">
          <h3 style={{ margin: 0 }}>{t('modAvailable')}</h3>
          {list.available.map((a) => (
            <div className="row between" key={a.id}>
              <span className="grow"><strong>{a.name}</strong> <span className="muted" dir="ltr">{t('moduleVersion', { v: a.version })}</span></span>
              <button className="btn small" disabled={busy} onClick={() => run(() => api(`/admin/modules/bundled/${a.id}/install`, { method: 'POST', body: {} }), t('modInstalled'))}>{t('modInstall')}</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
