import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ToolbarProps } from '../../../web/src/host';
import { api, t, errText, getLang, formatMoney, isApiError } from './sdk';
import { makeDecoder, validBarcode } from './decode';

type Product = { name: string; manufacturer: string; price: number; weighted: boolean; chain: { en: string; he: string }; branchName: string | null };
type Done = { status: 'done'; action: 'ticked' | 'more' | 'added_ticked' | 'added' | 'merged'; item: { id: number; name: string }; quantity: number; product: Product | null };
type Confirm = { status: 'confirm'; code: string; product: Product; suggestion: { id: number; name: string } };
type Unknown = { status: 'unknown'; code: string };
type Pending = (Confirm | Unknown) & { code: string };
type LogLine = { id: number; text: string; kind: 'ok' | 'error' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Scan button (Shop and Manage list) and the full-screen scanner it opens.
export default function ScanButton({ data, reload, storeId, mode }: ToolbarProps & { mode: 'shop' | 'manage' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" style={{ minHeight: 48 }} onClick={() => setOpen(true)}>▦ {t('scanButton')}</button>
      {open && <Scanner listId={data.list.id} reload={reload} storeId={storeId} mode={mode} onClose={() => setOpen(false)} />}
    </>
  );
}

function Scanner({ listId, reload, storeId, mode, onClose }: { listId: number; reload: () => Promise<void>; storeId: string; mode: 'shop' | 'manage'; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [typed, setTyped] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false), pendingRef = useRef<Pending | null>(null), recent = useRef(new Map<string, number>()), lineId = useRef(0);
  const latest = useRef({ listId, storeId, mode, reload });
  latest.current = { listId, storeId, mode, reload };
  pendingRef.current = pending;

  const say = (text: string, kind: LogLine['kind'] = 'ok') => setLog((l) => [{ id: ++lineId.current, text, kind }, ...l].slice(0, 5));

  const describe = (r: Done) => {
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
      const r = await api<Done | Confirm | Unknown>(`/lists/${lid}/scan`, { method: 'POST', body: { tick: m === 'shop', storeId: sid || undefined, ...body } });
      if (r.status === 'done') { setPending(null); say(describe(r)); navigator.vibrate?.(40); await rl(); }
      else { setPending(r); setName(r.status === 'confirm' ? r.product.name : ''); navigator.vibrate?.([30, 40, 30]); }
    } catch (e) {
      setPending(null);
      say(isApiError(e, 'forbidden') ? t('scanForbidden') : errText(e), 'error');
    } finally { busyRef.current = false; setBusy(false); }
  };

  const onCode = (code: string) => {
    const now = Date.now(), last = recent.current.get(code) ?? 0;
    if (now - last < 4000) return;           // the same barcode in the next frames is the same scan
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
          if (!busyRef.current && !pendingRef.current && canvas.current) {
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

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const code = typed.replace(/\D/g, '');
    if (!validBarcode(code)) { say(t('err_invalid_code'), 'error'); return; }
    setTyped(''); recent.current.set(code, Date.now()); send({ code });
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={t('scanTitle')} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg, #fff)', display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingTop: 'env(safe-area-inset-top, 0px)' }}>
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
        <p className="muted">{camera === 'off' ? t('scanNoCamera') : t(mode === 'shop' ? 'scanPointShop' : 'scanPointManage')}</p>

        {pending?.status === 'confirm' && (
          <div className="card stack-sm" role="alert">
            <p><strong>{t('scanSeen', { product: pending.product.name })}</strong></p>
            <p>{t('scanConfirmQ', { item: pending.suggestion.name })}</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy} onClick={() => send({ code: pending.code, itemId: pending.suggestion.id })}>{t('scanYes')}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => send({ code: pending.code, name })}>{t('scanNew')}</button>
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

        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-live="polite">
          {log.map((l) => <li key={l.id} className={l.kind === 'ok' ? 'ok' : 'error'} dir="auto">{l.kind === 'ok' ? '✓ ' : ''}{l.text}</li>)}
        </ul>

        <form className="row" onSubmit={submitTyped}>
          <label className="field grow"><span>{t('scanTypeLabel')}</span><input type="text" inputMode="numeric" dir="ltr" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <button type="submit" className="btn" style={{ alignSelf: 'end' }} disabled={busy}>{t('scanLookUp')}</button>
        </form>
      </div>
    </div>
  );
}
