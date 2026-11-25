import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ToolbarProps } from '../../../web/src/host';
import { api, t, errText, getLang, formatMoney, isApiError, createPortal } from './sdk';
import { makeDecoder, validBarcode } from './decode';

type Product = { name: string; manufacturer: string; price: number; weighted: boolean; chain: { en: string; he: string }; branchName: string | null };
type ScanInfo = { itemId: number; entryId: number; action: 'ticked' | 'more' | 'added_ticked' | 'added' | 'merged'; created: boolean; previousPrice: number | null; savedPrice: number | null };
type Done = { status: 'done'; action: ScanInfo['action']; item: { id: number; name: string }; created: boolean; quantity: number; product: Product | null; code: string; categoryId: number | null; categoryHow: string | null; scan: ScanInfo | null; from?: { id: number; name: string } | null };
type Found = { status: 'found'; code: string; item: { id: number; name: string } | null; name: string; price: number | null; categoryId: number | null; product: Product | null };
type Last = { item: { id: number; name: string }; code: string; categoryId: number | null; how: string | null; scan: ScanInfo | null; quantity: number };
type Cat = { id: number; nameEn: string; nameHe: string };
type Mode = 'shop' | 'manage' | 'trip';
export type TripPick = { name: string; price: number | null; itemId: number | null; categoryId: number | null };
type Confirm = { status: 'confirm'; code: string; product: Product; suggestion: { id: number; name: string } };
type Unknown = { status: 'unknown'; code: string };
type Pending = (Confirm | Unknown) & { code: string };
type LogLine = { id: number; text: string; kind: 'ok' | 'error' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Scan button (Shop and Manage list) and the full-screen scanner it opens.
export default function ScanButton({ data, reload, storeId, mode, onPick }: ToolbarProps & { mode: Mode; onPick?: (p: TripPick) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={mode === 'trip' ? 'btn small' : 'btn'} style={mode === 'trip' ? { whiteSpace: 'nowrap' } : { minHeight: mode === 'shop' ? 48 : 46, whiteSpace: 'nowrap' }} onClick={() => setOpen(true)}>▦ {t('scanButton')}</button>
      {open && <Scanner listId={data.list.id} canEdit={data.list.role !== 'viewer'} reload={reload} storeId={storeId} mode={mode} onPick={onPick} onClose={() => setOpen(false)} />}
    </>
  );
}

function Scanner({ listId, canEdit, reload, storeId, mode, onPick, onClose }: { listId: number; canEdit: boolean; reload: () => Promise<void>; storeId: string; mode: Mode; onPick?: (p: TripPick) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [typed, setTyped] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Last | null>(null);                            // the last scan, whose item can be edited or moved ('Wrong item')
  const [panel, setPanel] = useState<null | 'edit' | 'wrong'>(null);
  const [draft, setDraft] = useState('');                                          // the name while it is being edited
  const [catDraft, setCatDraft] = useState('');                                    // the category while it is being edited ('' = none)
  const [cats, setCats] = useState<Cat[]>([]);
  const [q, setQ] = useState('');                                                  // 'Wrong item': what is searched for
  const [found, setFound] = useState<{ id: number; name: string }[]>([]);
  const [pick, setPick] = useState<number | 'new' | null>(null);
  const busyRef = useRef(false), pendingRef = useRef<Pending | null>(null), editingRef = useRef(false), recent = useRef(new Map<string, number>()), lineId = useRef(0);
  const repeatMs = useRef(4000);   // how long the same barcode is ignored: the admin's setting (1.3.0)
  useEffect(() => { api<{ repeatSeconds: number }>('/config').then((r) => { repeatMs.current = r.repeatSeconds * 1000; }).catch(() => { /* the default stays */ }); }, []);
  const latest = useRef({ listId, storeId, mode, reload });
  latest.current = { listId, storeId, mode, reload };
  pendingRef.current = pending;
  editingRef.current = panel !== null;      // the camera waits while the item is being edited

  const say = (text: string, kind: LogLine['kind'] = 'ok') => setLog((l) => [{ id: ++lineId.current, text, kind }, ...l].slice(0, 5));

  const describe = (r: Pick<Done, 'action' | 'item' | 'quantity' | 'product'>) => {
    const name = r.item.name;
    let s = r.action === 'ticked' ? t('scanTicked', { name }) : r.action === 'added_ticked' ? t('scanAddedTicked', { name })
      : r.action === 'more' ? t('scanMore', { name, n: r.quantity }) : r.action === 'merged' ? t('scanMerged', { name, n: r.quantity }) : t('scanAdded', { name });
    const p = r.product;
    if (p) s += ` · ${p.weighted ? t('scanWeighted') : t('scanPrice', { price: formatMoney(p.price, 'ILS'), chain: getLang() === 'he' ? p.chain.he : p.chain.en })}`;
    return s;
  };

  // One scan (or one answer to a question) goes to the server; the answer is either done, a question, or an error.
  const send = async (body: Record<string, unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const { listId: lid, storeId: sid, mode: m, reload: rl } = latest.current;
      if (m === 'trip') {   // Add a trip: only look the product up; the list is not touched
        const r = await api<Found | Confirm | Unknown>(`/lists/${lid}/scan/lookup`, { method: 'POST', body });
        if (r.status === 'found') {
          setPending(null);
          onPick?.({ name: r.item?.name ?? r.name, price: r.price, itemId: r.item?.id ?? null, categoryId: r.categoryId });
          say(t('scanTripRow', { name: r.item?.name ?? r.name }) + (r.price !== null ? ` · ${formatMoney(r.price, 'ILS')}` : '')); navigator.vibrate?.(40);
        } else { setPending(r); setName(r.status === 'confirm' ? r.product.name : ''); navigator.vibrate?.([30, 40, 30]); }
        return;
      }
      const r = await api<Done | Confirm | Unknown>(`/lists/${lid}/scan`, { method: 'POST', body: { tick: m === 'shop', storeId: sid || undefined, ...body } });
      if (r.status === 'done') { setPending(null); setLast({ item: r.item, code: r.code, categoryId: r.categoryId, how: r.categoryHow, scan: r.scan, quantity: r.quantity }); setPanel(null); say(describe(r)); navigator.vibrate?.(40); await rl(); }
      else { setPending(r); setName(r.status === 'confirm' ? r.product.name : ''); navigator.vibrate?.([30, 40, 30]); }
    } catch (e) {
      setPending(null);
      say(isApiError(e, 'forbidden') ? t('scanForbidden') : errText(e), 'error');
    } finally { busyRef.current = false; setBusy(false); }
  };

  const onCode = (code: string) => {
    const now = Date.now(), last = recent.current.get(code) ?? 0;
    if (now - last < repeatMs.current) return;           // the same barcode in the next frames is the same scan
    recent.current.set(code, now);
    send({ code });
  };

  useEffect(() => {
    let stopped = false, stream: MediaStream | null = null;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera api');
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (stopped) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        const v = video.current!;
        v.srcObject = stream; await v.play();
        setCamera('on');
        const decoder = await makeDecoder();
        while (!stopped) {
          if (!busyRef.current && !pendingRef.current && !editingRef.current && canvas.current) {
            const code = await decoder.decode(v, canvas.current);
            if (code && validBarcode(code) && !stopped) onCode(code);
          }
          await sleep(decoder.kind === 'native' ? 150 : 220);
        }
      } catch { if (!stopped) setCamera('off'); }
    })();
    return () => { stopped = true; stream?.getTracks().forEach((tr) => tr.stop()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const catName = (id: number | null) => { const c = cats.find((x) => x.id === id); return c ? (getLang() === 'he' ? c.nameHe : c.nameEn) : ''; };
  const loadCats = async () => { if (cats.length) return; try { setCats((await api<{ categories: Cat[] }>(`/lists/${listId}/scan/categories`)).categories); } catch { /* the select just stays empty */ } };
  useEffect(() => { if (last) loadCats(); /* so the category can be shown by name */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.item.id]);

  const startEdit = () => { if (!last) return; setDraft(last.item.name); setCatDraft(last.categoryId ? String(last.categoryId) : ''); setPanel('edit'); };
  const startWrong = () => { setQ(''); setPick(null); setFound([]); setPanel('wrong'); };

  // 'Wrong item': look for the household's items as the person types.
  useEffect(() => {
    if (panel !== 'wrong') return;
    let live = true;
    const id = setTimeout(async () => {
      try { const r = await api<{ items: { id: number; name: string }[] }>(`/lists/${listId}/scan/items?q=${encodeURIComponent(q)}`); if (live) setFound(r.items.filter((i) => i.id !== last?.item.id)); } catch { /* offline */ }
    }, 200);
    return () => { live = false; clearTimeout(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, panel]);

  // Saves the name and the category of the item the last scan landed on. The barcode points at the item, so it keeps pointing at it under the new name.
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    const nm = draft.trim();
    if (!last || !nm || busyRef.current) return;
    const body: Record<string, unknown> = { itemId: last.item.id };
    if (nm !== last.item.name) body.name = nm;
    const cid = catDraft ? Number(catDraft) : null;
    if (cid !== last.categoryId) body.categoryId = cid;
    if (Object.keys(body).length === 1) { setPanel(null); return; }
    busyRef.current = true; setBusy(true);
    try {
      const r = await api<{ item: { id: number; name: string }; categoryId?: number | null }>(`/lists/${listId}/scan/edit`, { method: 'POST', body });
      if (body.name) say(t('scanRenamed', { from: last.item.name, to: r.item.name }));
      if ('categoryId' in body) say(t('scanCategorySet', { name: r.item.name, category: cid ? catName(cid) : t('scanNoCategory') }));
      setLast({ ...last, item: r.item, categoryId: 'categoryId' in body ? cid : last.categoryId, how: 'categoryId' in body ? null : last.how }); setPanel(null);
      await latest.current.reload();
    } catch (err) { say(errText(err), 'error'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  // What the person is about to undo, in words.
  const undoText = () => {
    const sc = last?.scan; if (!sc || !last) return '';
    const name = last.item.name;
    return sc.action === 'ticked' ? t('scanUndoTicked', { name }) : sc.action === 'more' ? t('scanUndoMore', { name, n: Math.max(1, last.quantity - 1) })
      : sc.action === 'merged' ? t('scanUndoMerged', { name }) : sc.created ? t('scanUndoCreated', { name }) : t('scanUndoRemoved', { name });
  };

  // 'Move barcode': the barcode goes to the right item, the wrong scan is taken back and the right item gets the scan.
  const move = async () => {
    if (!last || pick === null || busyRef.current) return;
    const typedName = q.trim();
    if (pick === 'new' && !typedName) return;
    busyRef.current = true; setBusy(true);
    try {
      const { storeId: sid, mode: m } = latest.current;
      const r = await api<Done>(`/lists/${listId}/scan/repoint`, { method: 'POST', body: { code: last.code, ...(pick === 'new' ? { name: typedName } : { itemId: pick }), tick: m === 'shop', storeId: sid || undefined, undo: last.scan ?? undefined } });
      say(t('scanMoved', { from: last.item.name, to: r.item.name }));
      setLast({ item: r.item, code: r.code, categoryId: r.categoryId, how: r.categoryHow, scan: r.scan, quantity: r.quantity ?? 1 }); setPanel(null);
      await latest.current.reload();
    } catch (err) { say(errText(err), 'error'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const code = typed.replace(/\D/g, '');
    if (!validBarcode(code)) { say(t('err_invalid_code'), 'error'); return; }
    setTyped(''); recent.current.set(code, Date.now()); send({ code });
  };

  // Drawn in <body> and not where the button is: in Manage list that is inside the Add form, and the scanner's own buttons submitted it
  // (the page reloaded to Home). The submit also stops here, as React events still travel up through a portal.
  return createPortal(
    <div role="dialog" aria-modal="true" onSubmit={(e) => e.stopPropagation()} aria-label={t('scanTitle')} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--paper)', color: 'var(--text)', display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div className="row between" style={{ padding: '10px 14px' }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{t('scanTitle')}</h2>
        <button type="button" className="btn primary" onClick={onClose}>{t('scanClose')}</button>
      </div>

      <div style={{ position: 'relative', background: '#000', minHeight: 200, maxHeight: '42vh', overflow: 'hidden', display: camera === 'off' ? 'none' : 'block' }}>
        <video ref={video} playsInline muted style={{ width: '100%', maxHeight: '42vh', objectFit: 'cover', display: 'block' }} />
        <div aria-hidden="true" style={{ position: 'absolute', left: '8%', right: '8%', top: '30%', bottom: '30%', border: '3px solid rgba(255,255,255,.85)', borderRadius: 12, boxShadow: '0 0 0 9999px rgba(0,0,0,.25)' }} />
      </div>
      <canvas ref={canvas} hidden />

      <div className="stack-sm" style={{ padding: '12px 14px' }}>
        <p className="muted">{camera === 'off' ? t('scanNoCamera') : t(mode === 'shop' ? 'scanPointShop' : mode === 'trip' ? 'scanPointTrip' : 'scanPointManage')}</p>

        {pending?.status === 'confirm' && (
          <div className="card stack-sm" role="alert">
            <p><strong>{t('scanSeen', { product: pending.product.name })}</strong></p>
            <p>{t('scanConfirmQ', { item: pending.suggestion.name })}</p>
            <label className="field"><span>{t('scanNewNameHint')}</span><input type="text" dir="auto" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy} onClick={() => send({ code: pending.code, itemId: pending.suggestion.id })}>{t('scanYes')}</button>
              <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => send({ code: pending.code, name })}>{t('scanNew')}</button>
              <button type="button" className="btn" onClick={() => setPending(null)}>{t('scanCancel')}</button>
            </div>
          </div>
        )}

        {pending?.status === 'unknown' && (
          <form className="card stack-sm" role="alert" onSubmit={(e) => { e.preventDefault(); if (name.trim()) send({ code: pending.code, name }); }}>
            <p>{t('scanUnknown')}</p>
            <label className="field"><span>{t('scanNameLabel')}</span><input type="text" dir="auto" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{t('scanAdd')}</button>
              <button type="button" className="btn" onClick={() => setPending(null)}>{t('scanCancel')}</button>
            </div>
          </form>
        )}

        {last && !pending && mode !== 'trip' && (panel === null ? (
          <div className="card row between" data-testid="scan-last">
            <div style={{ minWidth: 0 }}>
              <strong dir="auto">{last.item.name}</strong>
              <div className="muted" style={{ fontSize: '.85rem' }}>{last.categoryId ? catName(last.categoryId) : t('scanNoCategory')}{last.how ? ` · ${t(`scanHow_${last.how}`)}` : ''}</div>
            </div>
            {canEdit && <button type="button" className="iconbtn" aria-label={t('scanEdit')} title={t('scanEdit')} style={{ minWidth: 44, minHeight: 44 }} onClick={startEdit}>✎</button>}
          </div>
        ) : panel === 'edit' ? (
          <form className="card stack-sm" onSubmit={saveEdit} data-testid="scan-edit">
            <label className="field"><span>{t('scanNameLabel')}</span><input type="text" dir="auto" autoFocus maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
            <label className="field"><span>{t('scanCategoryLabel')}</span>
              <select value={catDraft} onChange={(e) => setCatDraft(e.target.value)}><option value="">{t('scanNoCategory')}</option>{cats.map((c) => <option key={c.id} value={c.id}>{getLang() === 'he' ? c.nameHe : c.nameEn}</option>)}</select></label>
            {last.how && String(last.categoryId ?? '') === catDraft && <p className="muted">{t(`scanHowNote_${last.how}`)}</p>}
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || !draft.trim()}>{t('scanSave')}</button>
              <button type="button" className="btn" disabled={busy} onClick={startWrong}>⇄ {t('scanWrongItem')}</button>
              <button type="button" className="btn" onClick={() => setPanel(null)}>{t('scanCancel')}</button>
            </div>
          </form>
        ) : (
          <form className="card stack-sm" data-testid="scan-wrong" onSubmit={(e) => { e.preventDefault(); move(); }}>
            <p>{t('scanMoveFrom', { name: last.item.name })}</p>
            <label className="field"><span>{t('scanSearchItems')}</span><input type="text" dir="auto" autoFocus maxLength={100} value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} /></label>
            <div className="stack-sm">
              {found.map((i) => (
                <label key={i.id} className="row" style={{ gap: 8, minHeight: 40 }}><input type="radio" name="scan-pick" checked={pick === i.id} onChange={() => setPick(i.id)} /><span dir="auto">{i.name}</span></label>
              ))}
              {q.trim() && !found.some((i) => i.name.toLowerCase() === q.trim().toLowerCase()) && (
                <label className="row" style={{ gap: 8, minHeight: 40 }}><input type="radio" name="scan-pick" checked={pick === 'new'} onChange={() => setPick('new')} /><span dir="auto">＋ {t('scanNewItemNamed', { name: q.trim() })}</span></label>
              )}
            </div>
            {last.scan && <p className="muted">{undoText()}</p>}
            <div className="row">
              <button type="submit" className="btn primary" disabled={busy || pick === null}>{t('scanMoveBarcode')}</button>
              <button type="button" className="btn" onClick={startEdit}>{t('scanBack')}</button>
            </div>
          </form>
        ))}

        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-live="polite">
          {log.map((l) => <li key={l.id} className={l.kind === 'ok' ? 'ok' : 'error'} dir="auto">{l.kind === 'ok' ? '✓ ' : ''}{l.text}</li>)}
        </ul>

        <form className="row" onSubmit={submitTyped}>
          <label className="field grow"><span>{t('scanTypeLabel')}</span><input type="text" inputMode="numeric" dir="ltr" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <button type="submit" className="btn" style={{ alignSelf: 'end' }} disabled={busy}>{t('scanLookUp')}</button>
        </form>
      </div>
    </div>,
    document.body,
  );
}
