import { useState } from 'react';
import { t, errText } from './i18n';
import { catName, fmt } from './util';
import type { Detail, Entry, Me } from './types';

type Props = {
  data: Detail; me: Me;
  onToggle: (e: Entry, checked: boolean) => void;
  onFinish: (storeId: string, extras: { total: string; photo: File | null }) => Promise<{ purchased: number; left: number; receipt: 'none' | 'saved' | 'failed' }>;
};

// The passive screen: search, tick things off, undo, finish. Nothing here edits the list itself.
export default function ShopTab({ data, me, onToggle, onFinish }: Props) {
  const { list, entries, categories, stores, shoppingNow } = data;
  const storeKey = `sl_store_${list.householdId}`;
  const [search, setSearch] = useState('');
  const [storeId, setStoreId] = useState(() => localStorage.getItem(storeKey) ?? '');
  const [confirming, setConfirming] = useState(false);
  const [receiptTotal, setReceiptTotal] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const store = stores.find((s) => String(s.id) === storeId);
  const q = search.trim().toLowerCase();
  const match = (e: Entry) => !q || e.name.toLowerCase().includes(q) || (e.note ?? '').toLowerCase().includes(q);

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
        <span className="name">{e.name}</span>
        {e.note && <span className="muted" style={{ display: 'block' }}>{e.note}</span>}
        {me.showAddedBy && e.addedByName && <span className="muted" style={{ display: 'block' }}>{t('addedBy', { name: e.addedByName })}</span>}
      </span>
      {(e.quantity !== 1 || e.unit) && <span className="qtybadge">×{fmt(e.quantity)}{e.unit ? ` ${e.unit}` : ''}</span>}
    </button>
  );

  return (
    <div className="stack-sm">
      <div className="addrow">
        <input type="search" className="grow" style={{ minHeight: 48 }} value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchList')} aria-label={t('searchList')} />
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

      {entries.length === 0 && <p className="muted">{t('emptyShop')}</p>}
      {entries.length > 0 && q && !groups.length && !shownCart.length && <p className="muted">{t('noMatches', { q: search.trim() })}</p>}
      {open.length === 0 && cart.length > 0 && !q && <p className="muted">{t('allChecked')}</p>}

      {groups.map((g) => (
        <section key={g.key}>
          <div className="section-title"><span>{g.title}</span><span>{g.items.length}</span></div>
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
