import { useCallback, useEffect, useRef, useState } from 'react';
import { api, t, errText, getLang, formatMoney, timeAgo } from './sdk';
import CompareSettings from './CompareSettings';
import MatchPanel, { Parts, formatPack, unitPriceText } from './MatchPanel';
import type { Detail } from '../../../web/src/types';
import type { CompareData, CompareResult, Line } from './types';

const CUR = 'ILS';
export const chainLabel = (r: { nameEn: string; nameHe: string; branchName?: string | null }) =>
  `${getLang() === 'he' ? r.nameHe : r.nameEn}${r.branchName ? ` · ${r.branchName}` : ''}`;
const dayOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const KNOWN_ERRORS = ['no_pricefull', 'incomplete_file', 'empty_file'];

// Where is this list cheapest? Open to everyone on the list, so the person at the shop can check.
// Which cities, chains and branches are compared is chosen here or in Manage list (Editors and Owners). Prices come from the branches' daily files;
// each item is matched to a product once (and remembered); receipt prices fill in where no portal price exists and say so.
export default function CompareTab({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const [c, setC] = useState<CompareData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [matching, setMatching] = useState<{ key: string; chain: string; item: { id: number; name: string } } | null>(null);
  const [editing, setEditing] = useState(false); // Editors can change where to compare without leaving this tab
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

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

  const refresh = async () => {
    setBusy(true);
    try { await api(`/lists/${data.list.id}/prices/refresh`, { method: 'POST', body: {} }); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  if (!c) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;

  const best = c.results[0];
  const key = (r: CompareResult) => `${r.chain}:${r.branchId}`;
  const checked = c.results.map((r) => r.checkedAt).filter((x): x is number => !!x);
  const lastChecked = checked.length ? Math.min(...checked) : null;
  const hasBranches = c.selection.some((s) => s.branchId);
  const done = () => { setMatching(null); load(); };

  const lineNote = (l: Line) => {
    const parts: string[] = [];
    if (l.via === 'barcode') parts.push(t('compareViaBarcode'));
    if (l.via === 'receipt') parts.push(t('compareViaReceipt'));
    if (l.old) parts.push(`⚠ ${t('compareOldPrice')}`);
    return parts.join(' · ');
  };

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
        <div className="row between" style={{ flexWrap: 'wrap' }}>
          <p className="muted grow" style={{ margin: 0 }} role="status">
            {c.prices.running
              ? t('compareReading', { done: c.prices.done, total: c.prices.total })
              : lastChecked ? t('compareChecked', { when: timeAgo(lastChecked) }) : t('compareSource')}
          </p>
          <button className="btn small" disabled={busy || c.prices.running} onClick={refresh}>{t('compareRefresh')}</button>
        </div>
      )}
      {!hasBranches && c.selection.length > 0 && <p className="muted">{t('compareNoBranchNote')}</p>}

      {c.selection.length === 0 && <p className="card">{c.canEdit ? t('compareEmptyEditor') : t('compareEmptyShopper')}</p>}
      {c.selection.length > 0 && c.openCount === 0 && <p className="card">{t('compareNothing')}</p>}

      {c.openCount > 0 && c.results.map((r) => {
        const k = key(r), isOpen = open === k;
        const diff = best && r !== best && r.total !== null && best.total !== null && r.priced === best.priced ? r.total - best.total : null;
        const reading = !!r.branchId && c.prices.running && !r.hasData && !r.error;
        return (
          <article className="card trip" key={k}>
            <button className="trip-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : k)}>
              <span className="grow">
                <strong dir="auto">{chainLabel(r)}</strong>
                <span className="muted" style={{ display: 'block' }}>
                  {reading ? t('compareReadingBranch') : r.priced === 0 ? t('compareNoData') : t('compareCoverage', { priced: r.priced, of: r.of })}
                  {r.receiptCount > 0 && ` · ${t('compareFromReceipts', { n: r.receiptCount })}`}
                </span>
                {r.asOf && <span className="muted" style={{ display: 'block' }}>{t('compareAsOf', { date: dayOf(r.asOf) })}</span>}
                {r.error && !r.hasData && <span className="error" style={{ display: 'block' }}>{t('compareReadError', { e: KNOWN_ERRORS.includes(r.error) ? t(`compareErr_${r.error}`) : r.error })}</span>}
                {diff !== null && diff > 0.004 && <span className="muted" style={{ display: 'block' }}>{t('compareMore', { v: formatMoney(diff, CUR), name: chainLabel(best) })}</span>}
                {r.oldCount > 0 && <span className="muted" style={{ display: 'block' }}>⚠ {t('compareOldCount', { n: r.oldCount })}</span>}
              </span>
              <span className="trip-total">{r.total === null ? '—' : formatMoney(r.total, CUR)}</span>
            </button>
            {isOpen && (
              <div className="trip-body stack-sm">
                {r.lines.length > 0 && (
                  <ul className="plain stack-sm">
                    {r.lines.map((l) => (
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
                        {c.canEdit && r.branchId && l.via !== 'receipt' && (
                          <button className="btn link small" onClick={() => setMatching(matching?.key === `${k}:${l.itemId}` ? null : { key: `${k}:${l.itemId}`, chain: r.chain, item: { id: l.itemId, name: l.name } })}>{t('compareChange')}</button>
                        )}
                        {matching?.key === `${k}:${l.itemId}` && <MatchPanel listId={data.list.id} chain={r.chain} item={matching.item} canEdit={c.canEdit} onDone={done} />}
                      </li>
                    ))}
                  </ul>
                )}
                {r.needsMatch.length > 0 && (
                  <>
                    <h3 style={{ margin: 0 }}>{t('compareNeedsMatch', { n: r.needsMatch.length })}</h3>
                    {r.branchId && <p className="muted" style={{ margin: 0 }}>{c.canEdit ? t('compareMatchHelp') : t('compareOnlyEditors')}</p>}
                    <ul className="plain stack-sm">
                      {r.needsMatch.map((m) => (
                        <li key={m.itemId}>
                          <div className="row between">
                            <span className="grow" dir="auto">{m.name}{m.quantity !== 1 ? ` × ${m.quantity}` : ''}</span>
                            {c.canEdit && r.branchId && r.hasData && <button className="btn small" onClick={() => setMatching(matching?.key === `${k}:${m.itemId}` ? null : { key: `${k}:${m.itemId}`, chain: r.chain, item: { id: m.itemId, name: m.name } })}>{t('compareMatchBtn')}</button>}
                          </div>
                          {matching?.key === `${k}:${m.itemId}` && <MatchPanel listId={data.list.id} chain={r.chain} item={matching.item} canEdit={c.canEdit} onDone={done} />}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.notSold.length > 0 && (
                  <>
                    <h3 style={{ margin: 0 }}>{t('compareNotSold', { n: r.notSold.length })}</h3>
                    <ul className="plain stack-sm">
                      {r.notSold.map((m) => (
                        <li key={m.itemId}>
                          <div className="row between">
                            <span className="grow"><span dir="auto">{m.name}{m.quantity !== 1 ? ` × ${m.quantity}` : ''}</span><span className="muted" style={{ display: 'block' }}>{m.reason === 'marked' ? t('compareNotSoldMarked') : t('compareNotAtBranch')}</span></span>
                            {c.canEdit && <button className="btn small" onClick={() => setMatching(matching?.key === `${k}:${m.itemId}` ? null : { key: `${k}:${m.itemId}`, chain: r.chain, item: { id: m.itemId, name: m.name } })}>{t('compareChange')}</button>}
                          </div>
                          {matching?.key === `${k}:${m.itemId}` && <MatchPanel listId={data.list.id} chain={r.chain} item={matching.item} canEdit={c.canEdit} onDone={done} />}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.lines.length === 0 && r.needsMatch.length === 0 && r.notSold.length === 0 && <p className="muted" style={{ margin: 0 }}>{t('compareAllPriced')}</p>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
