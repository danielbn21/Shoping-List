import { useCallback, useEffect, useState } from 'react';
import { api, t, errText, timeAgo } from './sdk';
import { chainLabel } from './CompareTab';
import type { AdminChain, PortalReport, PortalSample, RefreshJob } from './types';

type Overview = {
  chains: AdminChain[]; job: RefreshJob; citiesFetchedAt: number | null; cityNames: { source: string; n: number }[]; samples: PortalSample[]; isAdmin: boolean;
};
const STEP_LABEL = { open: 'stepOpen', stores: 'stepStores', pricefull_list: 'stepList', pricefull_parse: 'stepParse' } as const;
const kb = (n: number | null | undefined) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Settings > Supermarket portals: review and debug each supermarket portal separately. Everyone signed in can look, reload and test;
// switching chains on or off, adding chains and keeping raw files are admin-only.
export default function PortalsPanel() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [custom, setCustom] = useState({ name: '', user: '' });

  const load = useCallback(async () => {
    try {
      const st = await api<Omit<Overview, 'samples'>>('/portals/status');
      const samples = st.isAdmin ? (await api<{ samples: PortalSample[] }>('/admin/portals')).samples : [];
      setO({ ...st, samples }); setError('');
    } catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // While a reload is running, keep looking.
  useEffect(() => {
    if (!o?.job?.running) return;
    const id = window.setTimeout(load, 1500);
    return () => clearTimeout(id);
  }, [o, load]);

  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (e) { setError(errText(e)); } };
  if (!o) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;
  const gov = o.cityNames.find((x) => x.source === 'gov')?.n ?? 0, seed = o.cityNames.find((x) => x.source === 'seed')?.n ?? 0;
  const running = !!o.job?.running;

  return (
    <div className="stack">
      <section className="card stack">
        <p className="muted" style={{ margin: 0 }}>{t('portalsIntro')}</p>
        <p className="muted" style={{ margin: 0 }}>{t('portalsCities', { gov, seed })}{o.citiesFetchedAt ? ` · ${timeAgo(o.citiesFetchedAt)}` : ''}</p>
        <div className="row">
          <button className="btn small primary" disabled={running} onClick={() => act(() => api('/portals/refresh', { method: 'POST', body: {} }))}>{t('portalsReloadAll')}</button>
          {running && <span className="muted" role="status">{t('portalsReloading', { done: o.job?.done ?? 0, total: o.job?.total ?? 0 })}</span>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {o.chains.map((c) => (
        <section className="card stack-sm" key={c.id} style={c.supported ? undefined : { opacity: 0.6 }}>
          <div className="row between">
            <strong>{chainLabel(c)}{c.custom ? ' ★' : ''}</strong>
            {c.supported
              ? (o.isAdmin
                ? <label className="check" style={{ minHeight: 0 }}><input type="checkbox" checked={c.enabled} onChange={(e) => act(() => api(`/admin/portals/${c.id}`, { method: 'PUT', body: { enabled: e.target.checked } }))} /><span>{t('portalEnabled')}</span></label>
                : <span className="muted">{c.enabled ? t('portalEnabled') : t('portalOff')}</span>)
              : <span className="muted">{t('portalUnsupported')}</span>}
          </div>
          {c.supported && (
            <>
              <p className="muted" dir="ltr" style={{ margin: 0, textAlign: 'start' }}>{c.platform}{c.user ? ` · ${c.user}` : ''}{c.chainId ? ` · ${c.chainId}` : ''}</p>
              <p style={{ margin: 0 }}>
                {t('portalBranches')}: <strong>{c.branches}</strong> · {t('portalCities')}: <strong>{c.cities}</strong> · {t('portalZip')}: <strong>{c.zipFilled}</strong> · {t('portalFetched')}: {c.fetchedAt ? timeAgo(c.fetchedAt) : t('portalNever')}
              </p>
              {c.lastError && <p className="error" style={{ margin: 0 }}>{t('portalLastError')}: <span dir="ltr">{c.lastError}</span> ({timeAgo(c.lastErrorAt)})</p>}
              <div className="row">
                <button className="btn small" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{t('portalTest')}</button>
                <button className="btn small" disabled={running} onClick={() => act(() => api('/portals/refresh', { method: 'POST', body: { chain: c.id } }))}>{t('portalReload')}</button>
                {o.isAdmin && c.custom && <button className="btn small danger" onClick={() => { if (confirm(c.nameEn)) act(() => api(`/admin/portals/custom/${c.id}`, { method: 'DELETE' })); }}>{t('removeItem')}</button>}
              </div>
              {open === c.id && <TestPanel chain={c} isAdmin={o.isAdmin} onSamples={load} />}
            </>
          )}
        </section>
      ))}

      {o.isAdmin && <section className="card stack-sm">
        <h2 style={{ margin: 0 }}>{t('portalSamples')}</h2>
        {o.samples.length === 0 && <p className="muted" style={{ margin: 0 }}>—</p>}
        {o.samples.map((s) => (
          <div className="row between" key={`${s.chain}/${s.file}`}>
            <span dir="ltr" style={{ overflowWrap: 'anywhere' }}>{s.chain}/{s.file} <span className="muted">· {kb(s.size)}</span></span>
            <span className="row">
              <a className="btn small" href={`/api/m/price-compare/admin/portals/samples/${s.chain}/${s.file}`} download>{t('portalDownload')}</a>
              <button className="btn small danger" onClick={() => act(() => api(`/admin/portals/samples/${s.chain}/${s.file}`, { method: 'DELETE' }))}>{t('removeItem')}</button>
            </span>
          </div>
        ))}
      </section>}

      {o.isAdmin && <section className="card stack-sm">
        <h2 style={{ margin: 0 }}>{t('portalCustomTitle')}</h2>
        <p className="muted" style={{ margin: 0 }}>{t('portalCustomHelp')}</p>
        <div className="row">
          <label className="field grow"><span>{t('portalCustomName')}</span><input type="text" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
          <label className="field grow"><span>{t('portalCustomUser')}</span><input type="text" dir="ltr" value={custom.user} onChange={(e) => setCustom({ ...custom, user: e.target.value })} /></label>
        </div>
        <div><button className="btn small" disabled={!custom.name.trim() || !custom.user.trim()}
          onClick={() => act(async () => { await api('/admin/portals/custom', { method: 'POST', body: custom }); setCustom({ name: '', user: '' }); })}>{t('portalAdd')}</button></div>
      </section>}
    </div>
  );
}

function TestPanel({ chain, isAdmin, onSamples }: { chain: AdminChain; isAdmin: boolean; onSamples: () => void }) {
  const [branch, setBranch] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rep, setRep] = useState<PortalReport | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError(''); setRep(null);
    try {
      const r = await api<{ report: PortalReport }>(`/portals/${chain.id}/test`, { method: 'POST', body: { storeId: branch.trim(), save } });
      setRep(r.report);
      if (isAdmin && save) onSamples();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="row">
        <label className="field grow"><span>{t('portalTestBranch')}</span><input type="text" dir="ltr" inputMode="numeric" value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
      </div>
      {isAdmin && <label className="check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /><span>{t('portalKeepFiles')}</span></label>}
      <div><button className="btn small primary" disabled={busy} onClick={run}>{busy ? t('portalRunning') : t('portalRun')}</button></div>
      {error && <p className="error" role="alert">{error}</p>}
      {rep && (
        <div className="stack-sm" dir="ltr" style={{ textAlign: 'start' }}>
          {rep.steps.map((s) => (
            <div key={s.name}>
              <strong>{s.ok ? '✓' : '✗'} {t(STEP_LABEL[s.name])}</strong> <span className="muted">{s.ms} ms</span>
              {s.error && <p className="error" style={{ margin: '2px 0' }}>{s.error}</p>}
              {s.ok && s.detail && <Detail step={s.name} d={s.detail} />}
            </div>
          ))}
          {rep.files.stores && <Files title={`${t('portalFiles')} · Stores`} files={rep.files.stores} />}
          {rep.files.priceFull && <Files title={`${t('portalFiles')} · PriceFull`} files={rep.files.priceFull} />}
          {rep.files.rawKeys && <p className="muted" style={{ margin: 0 }}>{t('portalRowKeys')}: {rep.files.rawKeys.join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

const Files = ({ title, files }: { title: string; files: { name: string; size: number | null; time: string | null }[] }) => (
  <div>
    <span className="muted">{title}</span>
    <ul className="plain">{files.map((f) => <li key={f.name} style={{ overflowWrap: 'anywhere' }}>{f.name}{f.size != null ? ` · ${kb(f.size)}` : ''}{f.time ? ` · ${f.time}` : ''}</li>)}</ul>
  </div>
);

function Detail({ step, d }: { step: string; d: Record<string, any> }) {
  const line = (pairs: [string, unknown][]) => <p className="muted" style={{ margin: '2px 0' }}>{pairs.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>;
  if (step === 'stores') return line([[t('portalBranches'), d.branches], [t('portalCities'), `${d.cities} (${d.cityCodes})`], [t('portalZip'), d.zipFilled], [t('portalFormat'), d.format], ['file', d.file], ['chain', `${d.chainId} ${d.chainName}`], ['updated', d.updated]]);
  if (step === 'pricefull_list') return line([['branch', d.branch]]);
  if (step === 'pricefull_parse') {
    return (
      <>
        {line([['file', d.file], [t('portalFormat'), d.format], ['branch', d.storeId]])}
        {line([[t('portalItems'), d.items], [t('portalWeighted'), d.weighted], [t('portalBarcodes'), d.barcodes], [t('portalInternal'), d.internalCodes], [t('portalQtyZero'), d.qtyZero], [t('portalBadPrice'), d.badPrice], [t('portalDeposits'), d.deposits], [t('portalDupes'), d.duplicates], [t('portalNoUnit'), d.noUnit]])}
        {line([[t('portalUnits'), (d.units as { unit: string; count: number }[]).map((u) => `${u.unit || '∅'} ×${u.count}`).join(', ')]])}
        {d.unknownUnits.length > 0 && <p className="error" style={{ margin: '2px 0' }}>{t('portalUnknownUnits')}: {(d.unknownUnits as { unit: string; count: number }[]).map((u) => `${u.unit || '∅'} ×${u.count}`).join(', ')}</p>}
      </>
    );
  }
  return d.detail ? <p className="muted" style={{ margin: '2px 0' }}>{String(d.detail)}</p> : null;
}
