import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText, getLang, dateLocale } from './i18n';
import { effectiveCurrency, formatMoney } from './money';
import { uploadReceiptPhoto } from './imaging';
import { fmt } from './util';
import type { Detail, Me, TripDetailData, TripLine, TripSummary } from './types';

const when = (ms: number) => new Date(ms).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' });
const num = (s: string) => (s.trim() === '' ? null : Number(s));

// Everyone on the list can look back, fix prices, attach receipts and restore past trips.
export default function HistoryTab({ data, me, reload }: { data: Detail; me: Me; reload: () => Promise<void> }) {
  const { list } = data;
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const cur = effectiveCurrency(me);

  const first = useCallback(async () => {
    try { const r = await api<{ trips: TripSummary[]; more: boolean }>(`/lists/${list.id}/history`); setTrips(r.trips); setMore(r.more); } catch { /* offline */ }
  }, [list.id]);
  useEffect(() => { first(); }, [first]);

  const older = async () => {
    if (!trips?.length) return;
    try {
      const r = await api<{ trips: TripSummary[]; more: boolean }>(`/lists/${list.id}/history?before=${trips[trips.length - 1].finishedAt}`);
      setTrips([...trips, ...r.trips]); setMore(r.more);
    } catch { /* offline */ }
  };

  const csv = `/api/households/${list.householdId}/purchases.csv?listId=${list.id}&lang=${getLang()}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`;

  if (!trips) return <p className="muted">{t('loading')}</p>;
  return (
    <div className="stack-sm">
      <details className="card">
        <summary style={{ fontWeight: 700, cursor: 'pointer', minHeight: 32 }}>{t('exportPurchases')}</summary>
        <div className="stack-sm" style={{ marginTop: 10 }}>
          <div className="row">
            <label className="field grow"><span>{t('dateFrom')}</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label>
            <label className="field grow"><span>{t('dateTo')}</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label>
          </div>
          <div><a className="btn small primary" href={csv} download>{t('exportPurchases')}</a></div>
        </div>
      </details>

      {trips.length === 0 && <p className="muted">{t('historyEmpty')}</p>}
      {trips.map((tr) => {
        const open = openId === tr.id;
        const shown = tr.total ?? tr.computedTotal;
        return (
          <article className="card trip" key={tr.id}>
            <button className="trip-head" aria-expanded={open} onClick={() => setOpenId(open ? null : tr.id)}>
              <span className="grow">
                <strong>{when(tr.finishedAt)}</strong>
                <span className="muted" dir="auto" style={{ display: 'block' }}>
                  {[tr.storeName, tr.shopperName ? t('shoppedBy', { name: tr.shopperName }) : null, t('itemCount', { n: tr.itemCount })].filter(Boolean).join(' · ')}
                </span>
              </span>
              {tr.firstReceiptId && <img className="thumb" src={`/api/receipts/${tr.firstReceiptId}/image`} alt="" loading="lazy" />}
              <span className="trip-total">{formatMoney(shown, tr.currency ?? cur)}</span>
            </button>
            {open && <TripDetail id={tr.id} me={me} listId={list.id} onChanged={async () => { await first(); await reload(); }} />}
          </article>
        );
      })}
      {more && <div><button className="btn" onClick={older}>{t('showOlder')}</button></div>}
    </div>
  );
}

function TripDetail({ id, me, listId, onChanged }: { id: number; me: Me; listId: number; onChanged: () => Promise<void> }) {
  const [d, setD] = useState<TripDetailData | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editTotal, setEditTotal] = useState(false);
  const [totalStr, setTotalStr] = useState('');
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const seen = useRef<Set<number>>(new Set());
  const load = useCallback(async () => {
    try {
      const r = await api<TripDetailData>(`/trips/${id}`);
      setD(r);
      // Every line starts ticked for restore, including lines that appear later (for example added from a receipt).
      const fresh = r.lines.filter((l) => !seen.current.has(l.id));
      fresh.forEach((l) => seen.current.add(l.id));
      if (fresh.length) setSelected((s) => { const n = new Set(s); fresh.forEach((l) => n.add(l.id)); return n; });
    } catch (e) { setError(errText(e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const pending = d?.receipts.some((r) => r.ocrStatus === 'pending');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => load(), 2000);
    return () => clearInterval(timer);
  }, [pending, load]);

  if (!d) return <p className="muted" style={{ marginTop: 10 }}>{error || t('loading')}</p>;
  const cur = d.trip.currency ?? effectiveCurrency(me);
  const sum = d.lines.reduce((a, l) => a + (l.lineTotal ?? 0), 0);
  const hasSum = d.lines.some((l) => l.lineTotal !== null);
  const picked = d.lines.filter((l) => selected.has(l.id)); // ignore lines that have since been removed

  const run = async (fn: () => Promise<unknown>, after = true) => {
    setError(''); setMsg('');
    try { await fn(); await load(); if (after) await onChanged(); } catch (e) { setError(errText(e)); }
  };
  const saveLine = (lineId: number, patch: Record<string, unknown>) => run(() => api(`/purchases/${lineId}`, { method: 'PATCH', body: patch }));
  const toggle = (lineId: number, on: boolean) => setSelected((s) => { const n = new Set(s); on ? n.add(lineId) : n.delete(lineId); return n; });

  const restore = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api<{ added: number; merged: number }>(`/trips/${id}/restore`, { method: 'POST', body: { purchaseIds: picked.map((l) => l.id), listId } });
      setMsg(t('restoreDone', { added: r.added, merged: r.merged }));
      await onChanged();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const addPhoto = async (f: File | null) => {
    if (!f) return;
    setBusy(true); setError('');
    try { await uploadReceiptPhoto(id, f); await load(); await onChanged(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="stack-sm trip-body">
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p className="ok" role="status">{msg}</p>}

      <div className="row between">
        <div>
          <span className="muted">{t('total')}</span>
          {editTotal ? (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api(`/trips/${id}`, { method: 'PATCH', body: { total: num(totalStr) } }); setEditTotal(false); }); }}>
              <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" autoFocus value={totalStr} onChange={(e) => setTotalStr(e.target.value)} aria-label={t('total')} />
              <button className="btn small primary" type="submit">{t('save')}</button>
            </form>
          ) : (
            <div><strong style={{ fontSize: '1.3rem' }}>{formatMoney(d.trip.total ?? (hasSum ? sum : null), cur)}</strong>
              <button className="iconbtn" aria-label={t('editTotal')} title={t('editTotal')} onClick={() => { setTotalStr(d.trip.total === null ? '' : String(d.trip.total)); setEditTotal(true); }}>✎</button></div>
          )}
          {hasSum && d.trip.total !== null && Math.abs(sum - d.trip.total) > 0.005 && <div className="muted">{t('itemsAddUp', { v: formatMoney(sum, cur) })}</div>}
        </div>
      </div>

      <section className="stack-sm">
        <h3>{t('receiptsHeading')}</h3>
        <div className="receipts">
          {d.receipts.map((r) => (
            <div className="receipt" key={r.id}>
              <a href={`/api/receipts/${r.id}/image`} target="_blank" rel="noreferrer" aria-label={t('openPhoto')}>
                <img className="thumb big" src={`/api/receipts/${r.id}/image`} alt={t('receiptsHeading')} loading="lazy" />
              </a>
              <div className="stack-sm" style={{ gap: 4 }}>
                {r.ocrStatus === 'pending' && <span className="chip warn">{t('ocrPending')}</span>}
                {r.ocrStatus === 'failed' && <span className="muted">{t('ocrFailedMsg', { reason: r.ocrError ?? '' })}</span>}
                {r.ocrStatus === 'done' && <button className="btn small primary" onClick={() => setReviewId(reviewId === r.id ? null : r.id)}>{t('reviewReceipt')}</button>}
                {me.capabilities.includes('receipt-reader') && r.ocrStatus !== 'pending' && (
                  <button className="btn small" onClick={() => run(() => api(`/receipts/${r.id}/scan`, { method: 'POST', body: {} }), false)}>{r.ocrStatus === 'done' ? t('readAgain') : t('readReceipt')}</button>
                )}
                <button className="btn small danger" onClick={() => { if (confirm(t('confirmDeleteReceipt'))) run(() => api(`/receipts/${r.id}`, { method: 'DELETE' })); }}>{t('deleteReceipt')}</button>
              </div>
            </div>
          ))}
        </div>
        <div><label className="btn small filebtn">{t('addReceiptPhoto')}<input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { addPhoto(e.target.files?.[0] ?? null); e.target.value = ''; }} /></label></div>
        {reviewId !== null && <ReceiptReview key={reviewId} receiptId={reviewId} currency={cur} onClose={() => setReviewId(null)} onApplied={async () => { setReviewId(null); await load(); await onChanged(); }} />}
      </section>

      <section className="stack-sm">
        <h3>{t('restoreHeading')}</h3>
        <div className="hrow hhead muted" aria-hidden="true"><span /><span /><span className="hnum">{t('qtyShort')}</span><span className="hnum">{t('priceShort')}</span><span className="hnum">{t('lineTotalShort')}</span><span /></div>
        {d.lines.map((l) => <LineRow key={l.id} line={l} checked={selected.has(l.id)} onCheck={(on) => toggle(l.id, on)} onSave={saveLine}
          onDelete={() => { if (confirm(t('confirmRemoveLine', { name: l.name }))) run(() => api(`/purchases/${l.id}`, { method: 'DELETE' })); }} />)}
        <div className="row">
          <button className="btn primary" disabled={busy || picked.length === 0} onClick={restore}>{t('restoreSelected', { n: picked.length })}</button>
          <button className="btn small" aria-label={picked.length === d.lines.length ? '☐' : '☑'} onClick={() => setSelected(picked.length === d.lines.length ? new Set() : new Set(d.lines.map((l) => l.id)))}>
            {picked.length === d.lines.length ? '☐' : '☑'}
          </button>
        </div>
      </section>
    </div>
  );
}

const n2 = (v: number | null) => (v === null ? '—' : v.toFixed(2));

// One line per purchased item: tick (for restore), name, quantity bought, unit price, line total, and ✎ to correct them.
// Delete lives inside the correction panel (with a confirmation), not on the row. Restore uses the purchased quantities; adjust them afterwards in Manage list.
function LineRow({ line, checked, onCheck, onSave, onDelete }: { line: TripLine; checked: boolean; onCheck: (on: boolean) => void; onSave: (id: number, patch: Record<string, unknown>) => Promise<void> | void; onDelete: () => void }) {
  const [full, setFull] = useState(false); // tap the name to read all of it
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(fmt(line.quantity));
  const [price, setPrice] = useState(line.unitPrice === null ? '' : String(line.unitPrice));
  const [total, setTotal] = useState(line.lineTotal === null ? '' : String(line.lineTotal));
  const reset = () => { setQty(fmt(line.quantity)); setPrice(line.unitPrice === null ? '' : String(line.unitPrice)); setTotal(line.lineTotal === null ? '' : String(line.lineTotal)); };
  useEffect(() => { if (!editing) reset(); /* eslint-disable-next-line */ }, [line.quantity, line.unitPrice, line.lineTotal, editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    const q = Number(qty);
    if (q > 0 && q !== line.quantity) patch.quantity = q;
    const p = num(price), tl = num(total);
    if (p !== line.unitPrice) patch.unitPrice = p;
    if (tl !== line.lineTotal) patch.lineTotal = tl; // if both are changed the total wins
    if (Object.keys(patch).length) await onSave(line.id, patch);
    setEditing(false);
  };

  return (
    <div className="hline">
      <div className="hrow">
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={line.name} />
        <button type="button" className={`hn${full ? ' open' : ''}`} title={line.name} aria-expanded={full} onClick={() => setFull(!full)} dir="auto">{line.name}</button>
        <span className="hnum" dir="ltr">{fmt(line.quantity)}</span>
        <span className="hnum" dir="ltr">{n2(line.unitPrice)}</span>
        <strong className="hnum" dir="ltr">{n2(line.lineTotal)}</strong>
        <button type="button" className="iconbtn" aria-label={t('editLine')} title={t('editLine')} aria-expanded={editing} onClick={() => setEditing(!editing)}>✎</button>
      </div>
      {editing && (
        <form className="stack-sm" onSubmit={submit}>
          <div className="hnums">
            <label><span className="muted">{t('qtyShort')}</span>
              <input type="number" inputMode="decimal" min="0" step="any" dir="ltr" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label><span className="muted">{t('priceShort')}</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
            <label><span className="muted">{t('lineTotalShort')}</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={total} onChange={(e) => setTotal(e.target.value)} /></label>
          </div>
          <div className="row">
            <button className="btn small primary" type="submit">{t('save')}</button>
            <button className="btn small" type="button" onClick={() => { reset(); setEditing(false); }}>{t('cancel')}</button>
            <span className="grow" />
            <button className="btn small danger" type="button" onClick={onDelete}>{t('removeLine')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

type RLine = { key: number; include: boolean; name: string; quantity: string; lineTotal: string; match: { purchaseId?: number; itemId?: number; name: string } | null };

// The scanner proposes; a person confirms. Nothing is saved until "Save to history".
function ReceiptReview({ receiptId, currency, onClose, onApplied }: { receiptId: number; currency: string; onClose: () => void; onApplied: () => void }) {
  const [rv, setRv] = useState<any>(null);
  const [lines, setLines] = useState<RLine[]>([]);
  const [total, setTotal] = useState('');
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api<any>(`/receipts/${receiptId}`);
        if (!alive) return;
        setRv(r);
        if (r.result) {
          setLines(r.result.lines.map((l: any, i: number) => ({ key: i, include: true, name: l.name, quantity: fmt(l.quantity ?? 1), lineTotal: l.lineTotal === null || l.lineTotal === undefined ? '' : String(l.lineTotal), match: l.match })));
          setTotal(r.result.total === null || r.result.total === undefined ? '' : String(r.result.total));
        }
      } catch (e) { if (alive) setError(errText(e)); }
    })();
    return () => { alive = false; };
  }, [receiptId]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rv) return <p className="muted">{t('loading')}</p>;
  if (!rv.result) return <p className="muted">{rv.ocrStatus === 'pending' ? t('ocrPending') : t('ocrFailedMsg', { reason: rv.ocrError ?? '' })}</p>;

  const set = (key: number, patch: Partial<RLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const sum = lines.filter((l) => l.include).reduce((a, l) => a + (Number(l.lineTotal) || 0), 0);

  const apply = async () => {
    setError('');
    try {
      await api(`/receipts/${receiptId}/apply`, {
        method: 'POST',
        body: {
          total: num(total),
          lines: lines.map((l) => ({ include: l.include, name: l.name, quantity: Number(l.quantity) || 1, lineTotal: num(l.lineTotal), purchaseId: l.match?.purchaseId, itemId: l.match?.itemId })),
        },
      });
      onApplied();
    } catch (e) { setError(errText(e)); }
  };
  const showRaw = async () => {
    if (raw !== null) { setRaw(null); return; }
    try { setRaw((await api<any>(`/receipts/${receiptId}?raw=1`)).result.text ?? ''); } catch (e) { setError(errText(e)); }
  };

  return (
    <div className="card review stack-sm">
      <div><h3>{t('reviewTitle')}</h3><p className="muted">{t('reviewHelp')}</p>
        <p className="muted">{t('engineUsed', { engine: rv.result.engine === 'cloud' ? t('engineCloud') : t('engineLocal') })}</p></div>
      {lines.length === 0 && <p className="muted">{t('noLinesFound')}</p>}
      {lines.map((l) => (
        <div className="rline" key={l.key}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="checkbox" checked={l.include} onChange={(e) => set(l.key, { include: e.target.checked })} aria-label={t('useLine')} style={{ width: 22, height: 22, accentColor: 'var(--brand)', flex: 'none' }} />
            <input type="text" dir="auto" className="grow" value={l.name} aria-label={t('itemLabel')} onChange={(e) => set(l.key, { name: e.target.value, match: null })} />
          </div>
          <div className="hnums">
            <label><span className="muted">{t('qtyShort')}</span>
              <input type="number" inputMode="decimal" min="0" step="any" dir="ltr" value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} /></label>
            <label><span className="muted">{t('lineTotalShort')}</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={l.lineTotal} onChange={(e) => set(l.key, { lineTotal: e.target.value })} /></label>
            <span className={l.match ? 'chip' : 'chip warn'} style={{ alignSelf: 'end' }}>{l.match ? t('matchesItem', { name: l.match.name }) : t('newItemBadge')}</span>
          </div>
        </div>
      ))}
      <label className="field"><span>{t('receiptTotalLabel')}</span>
        <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={total} onChange={(e) => setTotal(e.target.value)} /></label>
      <p className="muted">{t('linesAddUp', { v: formatMoney(sum, currency) })}</p>
      {raw !== null && <pre className="rawtext" dir="auto">{raw}</pre>}
      <div className="row">
        <button className="btn primary" onClick={apply}>{t('applyReceipt')}</button>
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        {rv.result.engine === 'local' && <button className="btn link" onClick={showRaw}>{raw === null ? t('showRawText') : t('hideRawText')}</button>}
      </div>
    </div>
  );
}
