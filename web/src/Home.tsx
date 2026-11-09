import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText } from './i18n';
import { LIST_COLORS, type ListSummary, type Me } from './types';
import ListView from './ListView';
import HouseholdScreen from './HouseholdScreen';
import Menu, { type MenuItem } from './Menu';
import { SortableList } from './dnd';

type InstallEvent = Event & { prompt: () => Promise<void> };
type Sub = { kind: 'home' } | { kind: 'newList'; hid: number } | { kind: 'newHousehold' } | { kind: 'household'; hid: number };

export default function Home({ me, onMeChange }: { me: Me; onMeChange: () => void }) {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);
  const [sub, setSub] = useState<Sub>({ kind: 'home' });
  const [reorderLists, setReorderLists] = useState<number | null>(null); // household whose lists are being reordered
  const [reorderHouseholds, setReorderHouseholds] = useState(false);
  const [installEvt, setInstallEvt] = useState<InstallEvent | null>(null);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);

  const load = useCallback(async () => {
    try { setLists((await api<{ lists: ListSummary[] }>('/lists')).lists); } catch { /* keep what we have */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  // With exactly one list overall, open it straight away.
  useEffect(() => { if (auto && lists && lists.length === 1 && openId === null && sub.kind === 'home') setOpenId(lists[0].id); }, [auto, lists, openId, sub.kind]);

  const home = () => { setSub({ kind: 'home' }); load(); onMeChange(); };

  if (openId !== null) return <ListView listId={openId} me={me} onBack={() => { setOpenId(null); setAuto(false); load(); }} />;
  if (sub.kind === 'newList') return <CreateList me={me} initialHid={sub.hid} onCancel={home} onCreated={(id) => { setSub({ kind: 'home' }); setOpenId(id); }} />;
  if (sub.kind === 'newHousehold') return <CreateHousehold onCancel={() => setSub({ kind: 'home' })} onCreated={home} />;
  if (sub.kind === 'household') return <HouseholdScreen me={me} hid={sub.hid} onBack={home} onChanged={onMeChange} />;
  if (lists === null) return <p className="muted">{t('loading')}</p>;

  const multi = me.households.length > 1;
  const listsOf = (hid: number) => lists.filter((l) => l.householdId === hid);
  const only = me.households[0];

  const reorderIn = async (hid: number, next: ListSummary[]) => {
    setLists((prev) => prev && [...prev.filter((l) => l.householdId !== hid), ...next]);
    try { await api(`/households/${hid}/lists/order`, { method: 'PUT', body: { ids: next.map((l) => l.id) } }); } catch { load(); }
  };
  const reorderHh = async (next: { id: number }[]) => {
    try { await api('/households/order', { method: 'PUT', body: { ids: next.map((h) => h.id) } }); } finally { onMeChange(); }
  };

  const topItems: MenuItem[] = [];
  if (!multi && only) {
    topItems.push({ label: t('manageHousehold'), onClick: () => setSub({ kind: 'household', hid: only.id }) });
    if (listsOf(only.id).length > 1) topItems.push({ label: t('reorderLists'), onClick: () => setReorderLists(only.id) });
  }
  if (me.canCreateHousehold) topItems.push({ label: t('newHouseholdBtn'), onClick: () => setSub({ kind: 'newHousehold' }) });
  if (multi) topItems.push({ label: t('reorderHouseholds'), onClick: () => setReorderHouseholds(true) });

  const card = (l: ListSummary) => (
    <button key={l.id} className="list-card" style={{ ['--c' as string]: LIST_COLORS[l.color] ?? LIST_COLORS.green }} onClick={() => setOpenId(l.id)}>
      <span>
        <strong dir="auto">{l.name}</strong>
        <span className="muted" style={{ display: 'block' }}>{t('itemCount', { n: l.itemCount })}{l.visibility === 'private' ? ` · ${t('visPrivate')}` : ''}</span>
      </span>
    </button>
  );
  const listBlock = (hid: number) => {
    const ls = listsOf(hid);
    if (reorderLists === hid) {
      return (
        <div className="stack-sm">
          <SortableList items={ls} onReorder={(next) => reorderIn(hid, next)} render={(l, handle) => <>{handle}<span className="grow"><strong dir="auto">{l.name}</strong></span></>} />
          <div><button className="btn small primary" onClick={() => setReorderLists(null)}>{t('doneReordering')}</button></div>
        </div>
      );
    }
    if (!ls.length) return <p className="muted">{t('noListsHere')}</p>;
    return <div className="stack-sm">{ls.map(card)}</div>;
  };

  return (
    <div className="stack">
      <div className="row between" style={{ flexWrap: 'nowrap' }}>
        <h1>{t('hello', { name: me.name })}</h1>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          {!multi && only && <button className="btn signal" onClick={() => setSub({ kind: 'newList', hid: only.id })}>{t('newList')}</button>}
          <Menu items={topItems} />
        </div>
      </div>

      {reorderHouseholds && (
        <section className="card stack-sm">
          <h2>{t('reorderHouseholds')}</h2>
          <SortableList items={me.households} onReorder={reorderHh} render={(h, handle) => <>{handle}<span className="grow"><strong dir="auto">{h.name}</strong></span></>} />
          <div><button className="btn small primary" onClick={() => setReorderHouseholds(false)}>{t('doneReordering')}</button></div>
        </section>
      )}

      {!reorderHouseholds && !multi && (
        <>
          {lists.length === 0 && (
            <section className="card stack-sm"><h2>{t('noLists')}</h2><p className="muted">{t('noListsBody')}</p></section>
          )}
          {only && lists.length > 0 && listBlock(only.id)}
        </>
      )}

      {!reorderHouseholds && multi && me.households.map((h) => {
        const items: MenuItem[] = [{ label: t('manageHousehold'), onClick: () => setSub({ kind: 'household', hid: h.id }) }];
        if (listsOf(h.id).length > 1) items.push({ label: t('reorderLists'), onClick: () => setReorderLists(h.id) });
        return (
          <section key={h.id} className="hh stack-sm">
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <h2 dir="auto" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{h.name}</h2>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <button className="btn small signal" onClick={() => setSub({ kind: 'newList', hid: h.id })}>{t('newList')}</button>
                <Menu label={`${t('menu')}: ${h.name}`} items={items} />
              </div>
            </div>
            {listBlock(h.id)}
          </section>
        );
      })}

      {!standalone && (installEvt || isIos) && (
        <section className="card stack-sm">
          <h2>{t('installTitle')}</h2>
          <p className="muted">{t('installBody')}</p>
          {installEvt
            ? <div><button className="btn signal" onClick={() => installEvt.prompt()}>{t('installButton')}</button></div>
            : <p>{t('installIos')}</p>}
        </section>
      )}
    </div>
  );
}

function CreateHousehold({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try { await api('/households', { method: 'POST', body: { name } }); onCreated(); } catch (err) { setError(errText(err)); }
  }
  return (
    <form className="card stack" onSubmit={submit}>
      <h1>{t('newHouseholdTitle')}</h1>
      <label className="field"><span>{t('householdNameLabel')}</span>
        <input type="text" dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit">{t('newHouseholdBtn')}</button>
        <button className="btn" type="button" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  );
}

function CreateList({ me, initialHid, onCancel, onCreated }: { me: Me; initialHid: number; onCancel: () => void; onCreated: (id: number) => void }) {
  const [name, setName] = useState('');
  const [hid, setHid] = useState(initialHid);
  const [vis, setVis] = useState<'household' | 'private'>('household');
  const [color, setColor] = useState('green');
  const [members, setMembers] = useState<{ id: number; name: string }[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (vis !== 'private') return;
    api<{ members: { id: number; name: string }[] }>(`/households/${hid}/members`)
      .then((r) => setMembers(r.members.filter((m) => m.id !== me.id))).catch(() => setMembers([]));
    setPicked([]);
  }, [vis, hid, me.id]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try {
      const r = await api<{ id: number }>('/lists', { method: 'POST', body: { householdId: hid, name, visibility: vis, color, memberIds: picked } });
      onCreated(r.id);
    } catch (err) { setError(errText(err)); }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h1>{t('newList')}</h1>
      <label className="field"><span>{t('listName')}</span>
        <input type="text" dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {me.households.length > 1 && (
        <label className="field"><span>{t('household')}</span>
          <select value={hid} onChange={(e) => setHid(Number(e.target.value))}>
            {me.households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select></label>
      )}
      <div className="field"><span>{t('shareWith')}</span>
        <label className="check"><input type="radio" name="vis" checked={vis === 'household'} onChange={() => setVis('household')} />{t('visHousehold')}</label>
        <label className="check"><input type="radio" name="vis" checked={vis === 'private'} onChange={() => setVis('private')} />{t('visPrivate')}</label>
      </div>
      {vis === 'private' && members.length > 0 && (
        <div className="field"><span>{t('pickMembers')}</span>
          {members.map((m) => (
            <label className="check" key={m.id}>
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} /><bdi>{m.name}</bdi>
            </label>
          ))}
        </div>
      )}
      <div className="field"><span>{t('listColor')}</span>
        <div className="swatches">
          {Object.entries(LIST_COLORS).map(([k, hex]) => (
            <button type="button" key={k} className="swatch" aria-label={k} aria-pressed={color === k} style={{ ['--c' as string]: hex }} onClick={() => setColor(k)} />
          ))}
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit">{t('createList')}</button>
        <button className="btn" type="button" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  );
}
