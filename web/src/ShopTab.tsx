import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { t, errText } from './i18n';
import { effectiveCurrency, formatMoney } from './money';
import { catName, fmt } from './util';
import type { Detail, Entry, Me } from './types';
import { useSlots } from './slots';

type Props = {
  data: Detail; me: Me; reload: () => Promise<void>;
  onToggle: (e: Entry, checked: boolean) => void;
  onFinish: (storeId: string, extras: { total: string; photo: File | null }) => Promise<{ purchased: number; left: number; receipt: 'none' | 'saved' | 'failed' }>;
};

// The passive screen: search, tick things off, undo, finish. Nothing here edits the list itself.
export default function ShopTab({ data, me, reload, onToggle, onFinish }: Props) {
  const { list, entries, categories, stores, shoppingNow } = data;
  const storeKey = `sl_store_${list.householdId}`;
  const [search, setSearch] = useState('');
  const [storeId, setStoreId] = useState(() => localStorage.getItem(storeKey) ?? '');
  const toolbar = useSlots('shop.toolbar', { me, data }); // controls added by modules (for example scanning a barcode)
  const [confirming, setConfirming] = useState(false);
  const [receiptTotal, setReceiptTotal] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState<{ id: number; name: string }[] | null>(null);

  // Price estimates (when switched on in Settings): the last price paid for each item at the chosen store, or anywhere without one.
  const [est, setEst] = useState<Record<number, { unitPrice: number; source: string }>>({});
  const currency = effectiveCurrency(me);
  const itemSig = entries.map((e) => e.itemId).join();
  useEffect(() => {
    if (!me.estimatesEnabled) { setEst({}); return; }
    let stale = false;
    api<{ prices: Record<number, { unitPrice: number; source: string }> }>(`/lists/${list.id}/estimates?currency=${currency}${storeId ? `&storeId=${storeId}` : ''}`)
      .then((r) => { if (!stale) setEst(r.prices); }).catch(() => { if (!stale) setEst({}); });
    return () => { stale = true; };
  }, [me.estimatesEnabled, list.id, storeId, itemSig, currency]);

  const store = stores.find((s) => String(s.id) === storeId);
  const q = search.trim().toLowerCase();
  const match = (e: Entry) => !q || e.name.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q);

  // Quick add (1.9.2): a search that finds nothing offers to add the words as an item, so someone who remembers one more thing stays in Shop.
  // A Shopper (no Manage access) does not get it. A near-miss ("did you mean ...") is asked here the same way as in Manage.
  const canAdd = list.role !== 'viewer';
  const typed = search.trim();
  const exists = entries.some((e) => e.name.trim().toLowerCase() === typed.toLowerCase());
  useEffect(() => { setSimilar(null); }, [typed]);
  const quickAdd = async (extra: Record<string, unknown>, name: string) => {
    setError('');
    try {
      await api(`/lists/${list.id}/entries`, { method: 'POST', body: { quantity: 1, ...extra } });
      setSearch(''); setSimilar(null); await reload();
      setMsg(t('quickAdded', { name })); setTimeout(() => setMsg(''), 5000);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'similar_items') setSimilar(e.body?.matches ?? []);
      else setError(errText(e));
    }
  };

  const open = entries.filter((e) => e.state === 'open');
  const cart = entries.filter((e) => e.state === 'in_cart');
  const byId = new Map(categories.map((c) => [c.id, c]));
  const orderIds = store
    ? [...store.categoryOrder.filter((id) => byId.has(id)), ...categories.map((c) => c.id).filter((id) => !store.categoryOrder.includes(id))]
    : categories.map((c) => c.id);

  const groups = orderIds
    .map((id) => ({ key: String(id), title: catName(byId.get(id)!), items: open.filter((e) => e.categoryId === id && match(e)) }))
    .filter((g) => g.items.length);
  const other = open.filter((e) => (e.categoryId === null || !byId.has(e.categoryId)) && match(e));
  if (other.length) groups.push({ key: 'other', title: t('uncategorized'), items: other });
  const shownCart = cart.filter(match).sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0));

  const undoLast = () => {
    const last = [...cart].sort((a, b) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0))[0];
    if (last) onToggle(last, false);
  };

  const finish = async () => {
    setError('');
    try {
      const r = await onFinish(storeId, { total: receiptTotal, photo });
      setConfirming(false); setReceiptTotal(''); setPhoto(null);
      setMsg(`${t('tripDone', { n: r.purchased })}${r.receipt === 'saved' ? ' ' + t('receiptSaved') : r.receipt === 'failed' ? ' ' + t('receiptUploadFailed') : ''}`);
      setTimeout(() => setMsg(''), 9000);
    } catch (e) { setConfirming(false); setError(errText(e)); }
  };

  const others = shoppingNow.filter((s) => s.userId !== me.id && s.name);
  const row = (e: Entry, done: boolean) => (
    <button key={e.id} type="button" className={`shop-row${done ? ' done' : ''}`} onClick={() => onToggle(e, !done)}
      aria-label={`${done ? t('putBack') : t('markBought')}: ${e.name}`}>
      <span className="tick" aria-hidden="true" />
      <span className="grow">
        <span className="name" dir="auto">{e.name}</span>
        {e.note && <span className="muted" dir="auto" style={{ display: 'block' }}>{e.note}</span>}
        {me.showAddedBy && e.addedByName && <span className="muted" style={{ display: 'block' }}>{t('addedBy', { name: e.addedByName })}</span>}
      </span>
      {me.estimatesEnabled && est[e.itemId] && <span className="est" dir="ltr" title={t('estimateTitle')}>≈ {formatMoney(est[e.itemId].unitPrice * e.quantity, currency)}</span>}
      {(e.quantity !== 1 || e.unit) && <span className="qtybadge">×{fmt(e.quantity)}{e.unit ? ` ${e.unit}` : ''}</span>}
    </button>
  );

  return (
    <div className="stack-sm">
      <div className="addrow">
        <input type="search" dir="auto" className="grow" style={{ minHeight: 48 }} value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchList')} aria-label={t('searchList')} />
        {toolbar.map((m) => <m.component key={`${m.moduleId}:${m.id}`} data={data} me={me} reload={reload} storeId={storeId} />)}
        {stores.length > 0 && (
          <select aria-label={t('orderBy')} style={{ maxWidth: 190 }} value={storeId}
            onChange={(e) => { setStoreId(e.target.value); localStorage.setItem(storeKey, e.target.value); }}>
            <option value="">{t('orderCategory')}</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {others.map((s) => <p key={s.userId} className="chip warn" style={{ justifySelf: 'start' }}>{t('shoppingNow', { name: s.name! })}</p>)}
      {msg && <p className="ok" role="status">{msg}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {canAdd && typed && !exists && (similar ? (
        <div className="suggest" role="alert">
          <p style={{ fontWeight: 700 }}>{t('didYouMean')}</p>
          {similar.map((m) => <button type="button" className="similar" key={m.id} onClick={() => quickAdd({ itemId: m.id, source: 'typeahead' }, m.name)} dir="auto">{m.name}</button>)}
          <button type="button" className="new" onClick={() => quickAdd({ name: typed, force: true }, typed)}>{t('addAsNew', { name: typed })}</button>
        </div>
      ) : (
        <button type="button" className="quickadd" onClick={() => quickAdd({ name: typed }, typed)}>
          <span aria-hidden="true">＋</span><span className="grow" dir="auto">{t('quickAdd', { name: typed })}</span>
        </button>
      ))}

      {me.estimatesEnabled && entries.length > 0 && Object.keys(est).length > 0 && (() => {
        const on = entries;
        const priced = on.filter((e) => est[e.itemId]);
        const total = priced.reduce((n, e) => n + est[e.itemId].unitPrice * e.quantity, 0);
        return <p className="est-total" role="status">{t('estimateTotal', { total: formatMoney(total, currency) })} <span className="muted" style={{ fontWeight: 400 }}>· {t('estimateCoverage', { priced: priced.length, n: on.length })}</span></p>;
      })()}
      {entries.length === 0 && <p className="muted">{t('emptyShop')}</p>}
      {entries.length > 0 && q && !groups.length && !shownCart.length && !(canAdd && !exists) && <p className="muted">{t('noMatches', { q: search.trim() })}</p>}
      {open.length === 0 && cart.length > 0 && !q && <p className="muted">{t('allChecked')}</p>}

      {groups.map((g) => (
        <section key={g.key}>
          <div className="section-title"><span dir="auto">{g.title}</span><span>{g.items.length}</span></div>
          {g.items.map((e) => row(e, false))}
        </section>
      ))}

      {shownCart.length > 0 && (
        <section>
          <div className="section-title"><span>{t('inCart')}</span><span>{shownCart.length}</span></div>
          {shownCart.map((e) => row(e, true))}
        </section>
      )}

      {(cart.length > 0 || confirming) && (
        <div className="shopbar" role="region" aria-label={t('finishTrip')}>
          {confirming ? (
            <div className="stack-sm grow">
              <strong>{t('finishTitle')}</strong>
              <span className="muted">{t('finishBody', { bought: cart.length, left: open.length })}</span>
              <label className="field"><span>{t('receiptTotalOptional')}</span>
                <input type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" value={receiptTotal} onChange={(e) => setReceiptTotal(e.target.value)} /></label>
              <div className="field"><span>{t('receiptPhotoOptional')}</span>
                <div className="row">
                  <label className="btn small filebtn">{photo ? `✓ ${t('photoReady')}` : t('choosePhoto')}
                    <input type="file" accept="image/*" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} /></label>
                  {photo && <button type="button" className="btn link" onClick={() => setPhoto(null)}>{t('removePhoto')}</button>}
                </div>
              </div>
              <div className="row">
                <button className="btn primary" onClick={finish}>{t('confirmFinish')}</button>
                <button className="btn" onClick={() => setConfirming(false)}>{t('cancel')}</button>
              </div>
            </div>
          ) : (
            <>
              <button className="btn" onClick={undoLast} disabled={!cart.length}>{t('undo')}</button>
              <button className="btn primary grow" onClick={() => setConfirming(true)} disabled={!cart.length}>{t('finishTrip')} ({cart.length})</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
