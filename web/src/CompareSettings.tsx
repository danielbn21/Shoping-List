import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { t, errText } from './i18n';
import { chainLabel } from './CompareTab';
import type { ChainInfo, CompareData, Detail, PortalBranch, PortalCities, SelEntry } from './types';

type Pick = { chain: string; branchId: string };
const keyOf = (p: Pick) => `${p.chain}|${p.branchId}`;

// Manage list > Compare prices: choose the cities, then the chains, then the branches to compare this list across.
// The directory of cities and branches is public price-file data shared by every household; the first visit loads it in the background.
export default function CompareSettings({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const lid = data.list.id;
  const [c, setC] = useState<CompareData | null>(null);
  const [pc, setPc] = useState<PortalCities | null>(null);
  const [branches, setBranches] = useState<PortalBranch[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => { api<CompareData>(`/lists/${lid}/compare`).then(setC).catch((e) => setError(errText(e))); }, [lid]);

  // The directory loads lazily on the first visit; keep asking while it is loading.
  useEffect(() => {
    let stop = false, timer: number | undefined;
    const load = async () => {
      try {
        const r = await api<PortalCities>('/portals/cities');
        if (stop) return;
        setPc(r);
        if (r.loading) timer = window.setTimeout(load, 2000);
      } catch (e) { if (!stop) setError(errText(e)); }
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, []);

  const picks: Pick[] = useMemo(() => (c?.selection ?? []).map((s) => ({ chain: s.chain, branchId: s.branchId })), [c]);
  const chosenChains = useMemo(() => [...new Set(picks.map((p) => p.chain))], [picks]);
  const cityKeys = useMemo(() => (c?.cities ?? []).map((x) => x.key), [c]);

  // Branches of the chosen chains in the chosen cities.
  useEffect(() => {
    if (!cityKeys.length || !chosenChains.length) { setBranches([]); return; }
    let stop = false;
    api<{ branches: PortalBranch[] }>(`/portals/branches?cities=${encodeURIComponent(cityKeys.join(','))}&chains=${encodeURIComponent(chosenChains.join(','))}`)
      .then((r) => { if (!stop) setBranches(r.branches); }).catch((e) => { if (!stop) setError(errText(e)); });
    return () => { stop = true; };
  }, [cityKeys.join(','), chosenChains.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!c) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;

  const byId = new Map<string, ChainInfo>(c.chains.map((x) => [x.id, x]));
  const picked = new Set(picks.map(keyOf));

  // Optimistic: the tick changes at once and is put back if the server refuses.
  const persist = async (nextPicks: Pick[], nextCities?: string[]) => {
    setError('');
    const before = c;
    const known = new Map<string, SelEntry>(c.selection.map((s) => [`${s.chain}|${s.branchId}`, s]));
    const info = new Map(branches.map((b) => [`${b.chain}|${b.storeId}`, b]));
    setC({
      ...c,
      selection: nextPicks.map((p) => known.get(keyOf(p)) ?? {
        chain: p.chain, branchId: p.branchId, branchName: info.get(keyOf(p))?.name ?? null, cityKey: info.get(keyOf(p))?.cityKey ?? '',
        cityName: info.get(keyOf(p))?.cityName ?? '', address: info.get(keyOf(p))?.address ?? '', banner: info.get(keyOf(p))?.banner ?? '',
      }),
      cities: nextCities ? nextCities.map((k) => ({ key: k, name: pc?.cities.find((x) => x.key === k)?.name ?? k })) : c.cities,
    });
    try {
      const r = await api<{ selection: SelEntry[]; cities: { key: string; name: string }[] }>(`/lists/${lid}/compare/stores`, {
        method: 'PUT', body: { selection: nextPicks, ...(nextCities ? { cities: nextCities } : {}) },
      });
      setC((cur) => (cur ? { ...cur, selection: r.selection, cities: r.cities } : cur));
    } catch (e) { setC(before); setError(errText(e)); }
  };

  const toggleCity = (key: string, on: boolean) => persist(picks, on ? [...cityKeys, key] : cityKeys.filter((x) => x !== key));
  const toggleChain = (id: string, on: boolean) => persist(on ? [...picks, { chain: id, branchId: '' }] : picks.filter((p) => p.chain !== id));
  const setBranches_ = (chain: string, ids: string[], on: boolean) => {
    const rest = picks.filter((p) => !(p.chain === chain && ids.includes(p.branchId)));
    persist(on ? [...rest, ...ids.map((branchId) => ({ chain, branchId }))] : rest);
  };
  const linkStore = async (storeId: number, chain: string) => {
    setError('');
    try { await api(`/stores/${storeId}`, { method: 'PATCH', body: { chain: chain || null } }); await reload(); } catch (e) { setError(errText(e)); }
  };

  const cityList = (pc?.cities ?? []).filter((x) => !filter.trim() || x.name.includes(filter.trim()));
  const usable = c.chains.filter((x) => x.supported && x.enabled);
  const unsupported = c.chains.filter((x) => !x.supported);

  return (
    <>
      <p className="muted">{t('compareHelp')}</p>
      {error && <p className="error" role="alert">{error}</p>}

      {/* 1. cities */}
      <details className="multi">
        <summary>{t('compareCities')} <span className="muted">· {cityKeys.length ? t('compareCitiesCount', { n: cityKeys.length }) : t('compareCitiesNone')}</span></summary>
        <div className="multi-panel">
          {pc?.loading && <p className="muted" role="status">{t('branchListLoading', { done: pc.progress?.done ?? 0, total: pc.progress?.total ?? 0 })}</p>}
          {pc && !pc.loading && pc.cities.length === 0 && <p className="muted">{t('branchListEmpty')}</p>}
          {pc && pc.cities.length > 8 && <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('cityFilter')} aria-label={t('cityFilter')} />}
          {cityList.map((x) => (
            <label className="check" key={x.key}>
              <input type="checkbox" checked={cityKeys.includes(x.key)} onChange={(e) => toggleCity(x.key, e.target.checked)} />
              <span><bdi>{x.name}</bdi> <span className="muted">· {t('cityBranches', { n: x.branches })}</span></span>
            </label>
          ))}
        </div>
      </details>
      {c.cities.length > 0 && (
        <div className="chips">
          {c.cities.map((x) => (
            <span className="chip" key={x.key}><bdi>{x.name}</bdi>
              <button type="button" className="chip-x" aria-label={t('removeItem')} title={t('removeItem')} onClick={() => toggleCity(x.key, false)}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* 2. chains */}
      <details className="multi">
        <summary>{t('compareChains')} <span className="muted">· {chosenChains.length ? t('compareChainsCount', { n: chosenChains.length }) : t('compareChainsNone')}</span></summary>
        <div className="multi-panel">
          {usable.map((x) => (
            <label className="check" key={x.id}>
              <input type="checkbox" checked={chosenChains.includes(x.id)} onChange={(e) => toggleChain(x.id, e.target.checked)} />
              <span>{chainLabel(x)}</span>
            </label>
          ))}
          {unsupported.map((x) => (
            <label className="check" key={x.id} style={{ opacity: 0.55 }}>
              <input type="checkbox" disabled /><span>{chainLabel(x)} <span className="muted">· {t('notSupportedYet')}</span></span>
            </label>
          ))}
        </div>
      </details>

      {/* 3. branches of each chosen chain, in the chosen cities */}
      {chosenChains.map((id) => {
        const chain = byId.get(id);
        if (!chain) return null;
        const mine = branches.filter((b) => b.chain === id);
        const extra = c.selection.filter((s) => s.chain === id && s.branchId && !mine.some((b) => b.storeId === s.branchId));
        const nSel = picks.filter((p) => p.chain === id && p.branchId).length;
        const banners = [...new Set(mine.map((b) => b.banner))];
        const groups = banners.length > 1 ? banners : [''];
        return (
          <details className="multi" key={id}>
            <summary>{chainLabel(chain)} <span className="muted">· {t('compareBranchesTitle')}: {nSel}</span>
              <button type="button" className="chip-x" style={{ marginInlineStart: 'auto' }} aria-label={t('removeItem')} title={t('removeItem')}
                onClick={(e) => { e.preventDefault(); toggleChain(id, false); }}>✕</button>
            </summary>
            <div className="multi-panel">
              {!cityKeys.length && <p className="muted">{t('compareChooseCitiesFirst')}</p>}
              {cityKeys.length > 0 && mine.length === 0 && <p className="muted">{t('compareNoBranchesInCities')}</p>}
              {groups.map((bn) => {
                const list = banners.length > 1 ? mine.filter((b) => b.banner === bn) : mine;
                const ids = list.map((b) => b.storeId);
                const all = ids.length > 0 && ids.every((x) => picked.has(`${id}|${x}`));
                return (
                  <div key={bn || 'all'} className="branch-group">
                    {list.length > 0 && (
                      <div className="row between">
                        <strong><bdi>{bn || ''}</bdi></strong>
                        <button type="button" className="btn small" onClick={() => setBranches_(id, ids, !all)}>{all ? t('compareSelectNone') : t('compareSelectAll')}</button>
                      </div>
                    )}
                    {list.map((b) => (
                      <label className="check" key={b.storeId}>
                        <input type="checkbox" checked={picked.has(`${id}|${b.storeId}`)} onChange={(e) => setBranches_(id, [b.storeId], e.target.checked)} />
                        <span><bdi>{b.name}</bdi> <span className="muted">· <bdi>{b.address}</bdi>{cityKeys.length > 1 ? <>, <bdi>{b.cityName}</bdi></> : null}</span></span>
                      </label>
                    ))}
                  </div>
                );
              })}
              {extra.length > 0 && (
                <div className="branch-group">
                  <strong className="muted">{t('compareOtherCity')}</strong>
                  {extra.map((s) => (
                    <label className="check" key={s.branchId}>
                      <input type="checkbox" checked onChange={() => setBranches_(id, [s.branchId], false)} />
                      <span><bdi>{s.branchName}</bdi> <span className="muted">· <bdi>{s.cityName}</bdi></span></span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
      <p className="muted">{t('compareBranchesSoon')}</p>

      {data.stores.length > 0 && (
        <>
          <p className="muted">{t('compareLinkHelp')}</p>
          {data.stores.map((s) => (
            <label className="row between" key={s.id}>
              <span className="grow" style={{ fontWeight: 600 }}>{s.name}</span>
              <select value={s.chain ?? ''} onChange={(e) => linkStore(s.id, e.target.value)} aria-label={`${t('storeChain')}: ${s.name}`} style={{ maxWidth: '50%' }}>
                <option value="">{t('storeChainNone')}</option>
                {usable.map((x) => <option key={x.id} value={x.id}>{chainLabel(x)}</option>)}
              </select>
            </label>
          ))}
        </>
      )}
    </>
  );
}
