import { useCallback, useEffect, useRef, useState } from 'react';
import { api, t, errText, getLang, formatMoney, timeAgo } from './sdk';
import CompareSettings from './CompareSettings';
import MatchPanel, { Parts, formatPack, unitPriceText } from './MatchPanel';
import type { Detail } from '../../../web/src/types';
import type { CompareData, CompareResult, Line, Missing } from './types';

const CUR = 'ILS';
export const chainLabel = (r: { nameEn: string; nameHe: string; branchName?: string | null }) =>
  `${getLang() === 'he' ? r.nameHe : r.nameEn}${r.branchName ? ` · ${r.branchName}` : ''}`;
const dayOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const KNOWN_ERRORS = ['no_pricefull', 'incomplete_file', 'empty_file'];
const NOTICE_MS = 10_000;

const Spinner = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style={{ verticalAlign: 'text-bottom', marginInlineEnd: 6 }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="40 20">
      <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
    </circle>
  </svg>
);

// Where is this list cheapest? Open to everyone on the list, so the person at the shop can check.
// Which cities, chains and branches are compared is chosen here or in Manage list (Editors and Owners). Prices come from the branches' daily files;
// each item is matched to a product once per chain (every branch of the chain uses it, clear matches at other chains are carried over automatically);
// receipt prices fill in where no shelf price exists and say so.
export default function CompareTab({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const [c, setC] = useState<CompareData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [matching, setMatching] = useState<{ key: string; chain: string; item: { id: number; name: string } } | null>(null);
  const [editing, setEditing] = useState(false); // Editors can change where to compare without leaving this tab
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'info'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  const wasRunning = useRef(false);
  const autoOpened = useRef<Set<string>>(new Set());   // cards opened by themselves once; closing one keeps it closed

  const say = (n: { kind: 'ok' | 'warn' | 'info'; text: string }) => { setNotice(n); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS); };

  // Recalculate whenever what is left to buy changes.
  const stamp = data.entries.filter((e) => e.state === 'open').map((e) => `${e.itemId}:${e.quantity}`).join();
  const load = useCallback(async () => {
    try { setC(await api<CompareData>(`/lists/${data.list.id}/compare`)); setError(''); } catch (e) { setError(errText(e)); }
  }, [data.list.id]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [load, stamp]);
  // While prices are being read, look again every couple of seconds.
  useEffect(() => {
    clearTimeout(timer.current);
    if (c?.prices.running) timer.current = setTimeout(load, 2000);
    return () => clearTimeout(timer.current);
  }, [c, load]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // The job just finished: say what happened (and, once, open the branches that need the user's attention).
  useEffect(() => {
    if (!c) return;
    if (wasRunning.current && !c.prices.running && c.prices.lastJob) {
      const j = c.prices.lastJob;
      if (j.failed > 0) say({ kind: 'warn', text: t('compareFailedSome', { n: j.failed }) });
      else if (j.updated > 0) say({ kind: 'ok', text: j.updated === 1 ? t('compareDoneOne') : t('compareDoneMany', { n: j.updated }) });
      else say({ kind: 'ok', text: t('compareDoneSame') });
    }
    wasRunning.current = c.prices.running;
    // A branch that cannot be fully compared opens by itself, once: it needs the user.
    const fresh = c.results.filter((r) => r.hasData && r.priced < r.of && !autoOpened.current.has(`${r.chain}:${r.branchId}`));
    if (fresh.length) { fresh.forEach((r) => autoOpened.current.add(`${r.chain}:${r.branchId}`)); setOpen((o) => new Set([...o, ...fresh.map((r) => `${r.chain}:${r.branchId}`)])); }
  }, [c]);

  const checked = (c?.results ?? []).map((r) => r.checkedAt).filter((x): x is number => !!x);
  const lastChecked = checked.length ? Math.min(...checked) : null;

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api<{ started: boolean; reason: string | null }>(`/lists/${data.list.id}/prices/refresh`, { method: 'POST', body: {} });
      if (!r.started) say({ kind: 'info', text: r.reason === 'running' ? t('compareAlready') : t('compareUpToDate', { when: lastChecked ? timeAgo(lastChecked) : '' }) });
      await load();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  if (!c) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;

  const best = c.results[0];
  const key = (r: CompareResult) => `${r.chain}:${r.branchId}`;
  const hasBranches = c.selection.some((s) => s.branchId);
  const done = () => { setMatching(null); load(); };
  const chainName = (id: string) => { const ch = c.chains.find((x) => x.id === id); return ch ? (getLang() === 'he' ? ch.nameHe : ch.nameEn) : id; };
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const openMatch = (k: string, chain: string, m: Missing) => setMatching(matching?.key === k ? null : { key: k, chain, item: { id: m.itemId, name: m.name } });
  const panel = (k: string, chain: string) => matching?.key === k && <MatchPanel listId={data.list.id} chain={chain} item={matching.item} canEdit={c.canEdit} onDone={done} chainName={chainName} />;

  const lineNote = (l: Line) => {
    const parts: string[] = [];
    if (l.via === 'auto') parts.push(t('compareAutoFrom', { chain: chainName(l.autoFrom ?? '') }));
    if (l.via === 'sameName') parts.push(t('compareSameName'));
    if (l.via === 'barcode') parts.push(t('compareViaBarcode'));
    if (l.via === 'receipt') parts.push(t('compareViaReceipt'));
    if (l.old) parts.push(`⚠ ${t('compareOldPrice')}`);
    return parts.join(' · ');
  };

  const status = c.prices.running
    ? <span role="status"><Spinner />{t('compareFetching', { done: c.prices.done, total: c.prices.total })}</span>
    : notice
      ? <span role="status" className={notice.kind === 'warn' ? 'error' : notice.kind === 'ok' ? 'ok' : undefined}>{notice.kind === 'ok' ? '✓ ' : ''}{notice.text}</span>
      : <span role="status">{lastChecked ? t('compareChecked', { when: timeAgo(lastChecked) }) : t('compareSource')}</span>;

  return (
    <div className="stack-sm">
      {error && <p className="error" role="alert">{error}</p>}
      <div className="card stack-sm">
        <div className="row between">
          <p className="grow" style={{ margin: 0 }}>
            {c.cities.length
              ? t('compareWhere', { cities: c.cities.map((x) => `\u2068${x.name}\u2069`).join(', ') })
              : t('compareWhereNone')}
          </p>
          {c.canEdit && <button className="btn small" aria-expanded={editing} onClick={() => { if (editing) load(); setEditing(!editing); }}>{editing ? t('done') : t('compareEditWhere')}</button>}
        </div>
        {editing && <CompareSettings data={data} reload={reload} />}
      </div>

      {hasBranches && (
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <p className="muted grow" style={{ margin: 0 }}>{status}</p>
          <button className="btn small primary" disabled={busy || c.prices.running} onClick={refresh}>{c.prices.running ? <><Spinner />{t('compareFetching', { done: c.prices.done, total: c.prices.total })}</> : t('compareNow')}</button>
        </div>
      )}
      {!hasBranches && c.selection.length > 0 && <p className="muted">{t('compareNoBranchNote')}</p>}

      {c.selection.length === 0 && <p className="card">{c.canEdit ? t('compareEmptyEditor') : t('compareEmptyShopper')}</p>}
      {c.selection.length > 0 && c.openCount === 0 && <p className="card">{t('compareNothing')}</p>}

      {c.openCount > 0 && c.matchGroups.length > 0 && (
        <section className="card stack-sm" style={{ borderColor: 'var(--danger)' }} aria-label={t('compareToMatchTitle')}>
          <h3 style={{ margin: 0 }} className="error">⚠ {t('compareToMatchTitle')}</h3>
          <p className="muted" style={{ margin: 0 }}>{c.canEdit ? t('compareToMatchHelp') : t('compareOnlyEditors')}</p>
          {c.matchGroups.map((g) => (
            <div key={g.chain} className="stack-sm">
              <strong>{t('compareToMatchChain', { chain: getLang() === 'he' ? g.nameHe : g.nameEn, n: g.items.length })}</strong>
              <ul className="plain stack-sm">
                {g.items.map((m) => {
                  const k = `g:${g.chain}:${m.itemId}`;
                  return (
                    <li key={k}>
                      <div className="row between">
                        <span className="grow" dir="auto">{m.name}{m.quantity !== 1 ? ` × ${m.quantity}` : ''}</span>
                        {c.canEdit && <button className="btn small" onClick={() => openMatch(k, g.chain, m)}>{t('compareMatchBtn')}</button>}
                      </div>
                      {panel(k, g.chain)}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {c.openCount > 0 && c.results.map((r) => {
        const k = key(r), isOpen = open.has(k);
        const diff = best && r !== best && r.total !== null && best.total !== null && r.priced === best.priced ? r.total - best.total : null;
        const reading = !!r.branchId && c.prices.running && !r.hasData && !r.error;
        const incomplete = r.priced < r.of;
        return (
          <article className="card trip" key={k}>
            <button className="trip-head" aria-expanded={isOpen} onClick={() => toggle(k)}>
              <span className="grow">
                <strong dir="auto">{chainLabel(r)}</strong>
                {reading
                  ? <span className="muted" style={{ display: 'block' }}><Spinner />{t('compareReadingBranch')}</span>
                  : r.hasData || r.receiptCount > 0 || r.priced > 0
                    ? (
                      <span className={incomplete ? 'error' : 'muted'} style={{ display: 'block', ...(incomplete ? { fontWeight: 800 } : {}) }}>
                        {incomplete && '⚠ '}{t('compareCoverage', { priced: r.priced, of: r.of })}
                        {r.receiptCount > 0 && ` · ${t('compareFromReceipts', { n: r.receiptCount })}`}
                      </span>
                    )
                    : <span className="error" style={{ display: 'block', fontWeight: 800 }}>⚠ {t('compareNoData')}</span>}
                {r.asOf && <span className="muted" style={{ display: 'block' }}>{t('compareAsOf', { date: dayOf(r.asOf) })}</span>}
                {r.error && !r.hasData && <span className="error" style={{ display: 'block' }}>{t('compareReadError', { e: KNOWN_ERRORS.includes(r.error) ? t(`compareErr_${r.error}`) : r.error })}</span>}
                {diff !== null && diff > 0.004 && <span className="muted" style={{ display: 'block' }}>{t('compareMore', { v: formatMoney(diff, CUR), name: chainLabel(best) })}</span>}
                {r.oldCount > 0 && <span className="muted" style={{ display: 'block' }}>⚠ {t('compareOldCount', { n: r.oldCount })}</span>}
              </span>
              <span className="trip-total">{r.total === null ? '—' : formatMoney(r.total, CUR)}</span>
            </button>
            {isOpen && (
              <div className="trip-body stack-sm">
                {r.needsMatch.length > 0 && r.branchId && <p className="error" style={{ margin: 0 }}>{t('compareBranchNeeds', { n: r.needsMatch.length })}</p>}
                {r.lines.length > 0 && (
                  <ul className="plain stack-sm">
                    {r.lines.map((l) => {
                      const lk = `${k}:${l.itemId}`;
                      return (
                        <li key={l.itemId}>
                          <div className="row between" style={{ alignItems: 'flex-start' }}>
                            <span className="grow">
                              <span dir="auto">{l.name}{l.quantity !== 1 ? ` × ${l.quantity}` : ''}</span>
                              {l.product && <span className="muted" style={{ display: 'block' }}><Parts parts={[l.product.name, formatPack(l.product.pack), l.amountKg !== null ? `${l.amountKg} kg` : '']} /></span>}
                              {(l.sizeDiffers || l.amountKg !== null) && l.product && unitPriceText(l.product) && <span className="muted" style={{ display: 'block' }}>{unitPriceText(l.product)}{l.sizeDiffers ? ` · ${t('compareSizeNote')}` : ''}</span>}
                              {lineNote(l) && <span className="muted" style={{ display: 'block' }}>{lineNote(l)}</span>}
                            </span>
                            <span>{formatMoney(l.lineTotal, CUR)}</span>
                          </div>
                          {c.canEdit && r.branchId && l.via !== 'receipt' && <button className="btn link small" onClick={() => openMatch(lk, r.chain, { itemId: l.itemId, name: l.name, quantity: l.quantity })}>{t('compareChange')}</button>}
                          {panel(lk, r.chain)}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {r.notSold.length > 0 && (
                  <>
                    <h3 style={{ margin: 0 }}>{t('compareNotSold', { n: r.notSold.length })}</h3>
                    <ul className="plain stack-sm">
                      {r.notSold.map((m) => {
                        const nk = `${k}:${m.itemId}`;
                        return (
                          <li key={m.itemId}>
                            <div className="row between">
                              <span className="grow"><span dir="auto">{m.name}{m.quantity !== 1 ? ` × ${m.quantity}` : ''}</span><span className="muted" style={{ display: 'block' }}>{m.reason === 'marked' ? t('compareNotSoldMarked') : t('compareNotAtBranch')}</span></span>
                              {c.canEdit && <button className="btn small" onClick={() => openMatch(nk, r.chain, m)}>{t('compareChange')}</button>}
                            </div>
                            {panel(nk, r.chain)}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                {r.lines.length === 0 && r.notSold.length === 0 && r.needsMatch.length === 0 && <p className="muted" style={{ margin: 0 }}>{t('compareAllPriced')}</p>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
