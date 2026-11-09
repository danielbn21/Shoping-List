import { useCallback, useEffect, useState } from 'react';
import { api, t, errText, getLang, formatMoney } from './sdk';
import CompareSettings from './CompareSettings';
import type { Detail } from '../../../web/src/types';
import type { CompareData, CompareResult } from './types';

const CUR = 'ILS';
export const chainLabel = (r: { nameEn: string; nameHe: string; branchName?: string | null }) =>
  `${getLang() === 'he' ? r.nameHe : r.nameEn}${r.branchName ? ` · ${r.branchName}` : ''}`;

// Where is this list cheapest? Open to everyone on the list, so the person at the shop can check.
// Which chains are compared is chosen in Manage list (Editors and Owners).
export default function CompareTab({ data, reload }: { data: Detail; reload: () => Promise<void> }) {
  const [c, setC] = useState<CompareData | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false); // Editors can change where to compare without leaving this tab

  // Recalculate whenever what is left to buy changes.
  const stamp = data.entries.filter((e) => e.state === 'open').map((e) => `${e.itemId}:${e.quantity}`).join();
  const load = useCallback(async () => {
    try { setC(await api<CompareData>(`/lists/${data.list.id}/compare`)); setError(''); } catch (e) { setError(errText(e)); }
  }, [data.list.id]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [load, stamp]);

  if (!c) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;

  const best = c.results[0];
  const key = (r: CompareResult) => r.chain;
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
      <div className="row between">
        <p className="muted grow" style={{ margin: 0 }}>{t('compareSource')}</p>
        <button className="btn small" onClick={load}>{t('compareRecalc')}</button>
      </div>

      {c.selection.length === 0 && <p className="card">{c.canEdit ? t('compareEmptyEditor') : t('compareEmptyShopper')}</p>}
      {c.selection.length > 0 && c.openCount === 0 && <p className="card">{t('compareNothing')}</p>}

      {c.openCount > 0 && c.results.map((r) => {
        const isOpen = open === key(r);
        const diff = best && r !== best && r.total !== null && best.total !== null && r.priced === best.priced ? r.total - best.total : null;
        return (
          <article className="card trip" key={key(r)}>
            <button className="trip-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key(r))}>
              <span className="grow">
                <strong>{chainLabel(r)}</strong>
                <span className="muted" style={{ display: 'block' }}>
                  {r.priced === 0 ? t('compareNoData') : t('compareCoverage', { priced: r.priced, of: r.of })}
                </span>
                {diff !== null && diff > 0.004 && <span className="muted" style={{ display: 'block' }}>{t('compareMore', { v: formatMoney(diff, CUR), name: chainLabel(best) })}</span>}
                <span className="muted" style={{ display: 'block' }}>
                  {r.branches.length ? t('compareBranchesLine', { list: r.branches.map((b) => `\u2068${b.name || b.storeId}\u2069`).join(', ') }) : t('compareBranchesNone')}
                </span>
              </span>
              <span className="trip-total">{r.total === null ? '—' : formatMoney(r.total, CUR)}</span>
            </button>
            {isOpen && (
              <div className="trip-body stack-sm">
                {r.missing.length === 0
                  ? <p className="muted" style={{ margin: 0 }}>{t('compareAllPriced')}</p>
                  : <>
                    <h3 style={{ margin: 0 }}>{t('compareMissing', { n: r.missing.length })}</h3>
                    <ul className="plain">{r.missing.map((m) => <li key={m.itemId} dir="auto">{m.name}{m.quantity !== 1 ? ` × ${m.quantity}` : ''}</li>)}</ul>
                  </>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
