import { useEffect, useState, type FormEvent } from 'react';
import { api, t, errText, formatMoney } from './sdk';
import type { Candidate, MatchInfo } from './types';

const CUR = 'ILS';
const UNIT: Record<string, string> = { g: 'g', kg: 'kg', ml: 'ml', l: 'l', item: '', m: 'm', cm: 'cm' };

export const formatPack = (p: { amount: number; unit: string } | null) => {
  if (!p) return '';
  if (p.unit === 'g') return p.amount >= 1000 ? `${+(p.amount / 1000).toFixed(2)} kg` : `${+p.amount.toFixed(0)} g`;
  if (p.unit === 'ml') return p.amount >= 1000 ? `${+(p.amount / 1000).toFixed(2)} l` : `${+p.amount.toFixed(0)} ml`;
  if (p.unit === 'item') return p.amount === 1 ? '' : `× ${p.amount}`;
  return `${p.amount} ${p.unit}`;
};
// "₪2.94 per 100 g": what the shelf shows per unit of measure, so packs of different sizes can be compared.
export const unitPriceText = (c: { unitPrice: number | null; unit: string; unitPer: number; weighted?: boolean; price?: number }) => {
  if (c.weighted && c.price) return t('compareUnitPrice', { p: formatMoney(c.price, CUR), u: 'kg' });
  if (!c.unitPrice || !c.unit) return '';
  const u = UNIT[c.unit] ?? c.unit;
  return t('compareUnitPrice', { p: formatMoney(c.unitPrice, CUR), u: `${c.unitPer > 1 ? c.unitPer + ' ' : ''}${u}`.trim() || t('compareUnitItem') });
};

// Pieces of mixed Hebrew and English text joined by dots: each piece keeps its own direction, so the order never scrambles.
export function Parts({ parts }: { parts: (string | null | undefined)[] }) {
  const p = parts.filter((x): x is string => !!x);
  return <>{p.map((x, i) => <span key={i}><bdi>{x}</bdi>{i < p.length - 1 ? ' · ' : ''}</span>)}</>;
}

// Which product does this chain sell for one of the household's items? Candidates come from the branches' price files; the choice is
// confirmed once and remembered for the household, so every list and every later comparison uses it.
export default function MatchPanel({ listId, chain, item, canEdit, onDone }: { listId: number; chain: string; item: { id: number; name: string }; canEdit: boolean; onDone: () => void }) {
  const [info, setInfo] = useState<MatchInfo | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Candidate | null>(null);   // a weighed product waiting for "how much is 1?"
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<'kg' | 'g'>('kg');

  const load = async (query?: string) => {
    try { setInfo(await api<MatchInfo>(`/lists/${listId}/items/${item.id}/match?chain=${encodeURIComponent(chain)}${query ? `&q=${encodeURIComponent(query)}` : ''}`)); setError(''); } catch (e) { setError(errText(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [listId, item.id, chain]);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await api(`/lists/${listId}/items/${item.id}/match`, { method: 'PUT', body: { chain, ...body } }); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const choose = (c: Candidate) => { if (c.weighted) { setPick(c); setAmount(info?.current?.amountKg ? String(info.current.amountKg) : '1'); setUnit('kg'); } else save({ code: c.code }); };
  const confirmWeighed = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(amount.replace(',', '.'));
    const kg = unit === 'g' ? n / 1000 : n;
    if (!pick) return;
    if (!(kg >= 0.01 && kg <= 50)) { setError(t('err_invalid_value')); return; }
    save({ code: pick.code, amountKg: Math.round(kg * 1000) / 1000 });
  };
  const forget = async () => {
    setBusy(true);
    try { await api(`/lists/${listId}/items/${item.id}/match?chain=${encodeURIComponent(chain)}`, { method: 'DELETE' }); onDone(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  if (!info) return <p className={error ? 'error' : 'muted'}>{error || t('loading')}</p>;
  return (
    <div className="stack-sm match-panel">
      <p style={{ margin: 0 }}><strong>{t('compareMatchFor')}</strong><bdi dir="auto"> {item.name}</bdi></p>
      {error && <p className="error" role="alert">{error}</p>}
      {info.current?.status === 'confirmed' && <p className="muted" style={{ margin: 0 }}>{t('compareMatchChosen', { name: info.current.name ?? '' })}</p>}
      {info.current?.status === 'none' && <p className="muted" style={{ margin: 0 }}>{t('compareNotSoldMarked')}</p>}
      {info.noData && <p className="muted">{t('compareMatchNoData')}</p>}
      {!info.noData && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); load(q.trim() || undefined); }}>
          <input type="search" dir="auto" className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={info.query} aria-label={t('compareMatchSearch')} style={{ minHeight: 44 }} />
          <button className="btn small" type="submit">{t('compareMatchSearch')}</button>
        </form>
      )}
      {!info.noData && info.candidates.length === 0 && <p className="muted">{t('compareMatchNoCandidates')}</p>}
      {pick && (
        <form className="card stack-sm" onSubmit={confirmWeighed}>
          <p style={{ margin: 0 }}><bdi dir="auto">{pick.name}</bdi> · {unitPriceText(pick)}</p>
          <label className="field"><span>{t('compareMatchAmount')}</span>
            <span className="row">
              <input type="text" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 110 }} />
              <select value={unit} onChange={(e) => setUnit(e.target.value as 'kg' | 'g')} aria-label={t('compareMatchAmount')}><option value="kg">kg</option><option value="g">g</option></select>
            </span></label>
          <div className="row"><button className="btn primary" disabled={busy || !canEdit} type="submit">{t('compareMatchUse')}</button><button className="btn" type="button" onClick={() => setPick(null)}>{t('cancel')}</button></div>
        </form>
      )}
      {!pick && info.candidates.map((c) => (
        <button key={c.code} className="similar" disabled={busy || !canEdit} onClick={() => choose(c)} style={{ textAlign: 'start', display: 'flex', width: '100%', gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }} aria-pressed={info.current?.code === c.code}>
          <span className="grow">
            <strong dir="auto">{c.name}</strong>
            <span className="muted" style={{ display: 'block' }}><Parts parts={[c.manufacturer, formatPack(c.pack), unitPriceText(c)]} /></span>
            {c.barcodeMatch && <span className="chip">{t('compareViaBarcode')}</span>}
          </span>
          <span>{formatMoney(c.price, CUR)}{c.weighted ? ' / kg' : ''}</span>
        </button>
      ))}
      {canEdit && !pick && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn small" disabled={busy} onClick={() => save({ none: true })}>{t('compareMatchNone')}</button>
          {info.current && <button className="btn small" disabled={busy} onClick={forget}>{t('compareMatchForget')}</button>}
        </div>
      )}
      {!canEdit && <p className="muted">{t('compareOnlyEditors')}</p>}
    </div>
  );
}
