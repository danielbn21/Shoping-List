import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { t, errText, getLang } from './i18n';
import { LIST_COLORS, type Detail, type Entry, type Me } from './types';
import ShopTab from './ShopTab';
import ManageTab from './ManageTab';
import HistoryTab from './HistoryTab';
import TabMenu from './TabMenu';
import { useNarrow } from './util';
import { useSlots } from './slots';
import { effectiveCurrency } from './money';
import { uploadReceiptPhoto } from './imaging';

export default function ListView({ listId, me, onBack }: { listId: number; me: Me; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [tab, setTab] = useState<string>('shop'); // opens straight into Shop mode
  const [error, setError] = useState('');
  const narrow = useNarrow();
  const moduleTabs = useSlots('list.tab', { me, data: data ?? undefined }); // tabs added by modules (for example Compare prices)

  const load = useCallback(async () => {
    try { setData(await api<Detail>(`/lists/${listId}`)); }
    catch (e) { if (e instanceof ApiError && e.status === 404) onBack(); }
  }, [listId, onBack]);

  useEffect(() => { load(); }, [load]);
  // Until live sync arrives (stage 4), refresh while the list is on screen.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, 10000);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  if (!data) return <p className="muted">{t('loading')}</p>;
  const { list } = data;
  const isEditor = list.role !== 'viewer'; // "Shoppers" (viewer) only get the Shop tab
  const color = LIST_COLORS[list.color] ?? LIST_COLORS.green;
  // Shop and Manage list are always one tap away; the rest sit in a drop-down on phones so the tab row never wraps.
  const secondary = [...moduleTabs.map((m) => ({ id: `${m.moduleId}:${m.id}`, label: m.title() })), { id: 'history', label: t('tabHistory') }];

  // Optimistic check/uncheck so taps feel instant; rolled back if the server refuses.
  const toggle = async (e: Entry, checked: boolean) => {
    const apply = (state: Entry['state'], at: number | null) =>
      setData((d) => d && { ...d, entries: d.entries.map((x) => (x.id === e.id ? { ...x, state, checkedAt: at } : x)) });
    setError('');
    apply(checked ? 'in_cart' : 'open', checked ? Date.now() : null);
    try {
      await api(`/entries/${e.id}/check`, { method: 'POST', body: { checked } });
      load();
    } catch (err) {
      apply(e.state, e.checkedAt);
      setError(errText(err));
    }
  };

  const finish = async (storeId: string, extras: { total: string; photo: File | null }) => {
    const r = await api<{ purchased: number; left: number; tripId: number }>(`/lists/${list.id}/finish`, {
      method: 'POST',
      body: { storeId: storeId ? Number(storeId) : undefined, total: extras.total !== '' ? Number(extras.total) : undefined, currency: effectiveCurrency(me) },
    });
    // The trip is already saved; a failed photo upload must not undo that.
    let receipt: 'none' | 'saved' | 'failed' = 'none';
    if (extras.photo) { try { await uploadReceiptPhoto(r.tripId, extras.photo); receipt = 'saved'; } catch { receipt = 'failed'; } }
    await load();
    return { ...r, receipt };
  };

  return (
    <div className="stack">
      <div className="listhead">
        <button className="iconbtn" onClick={onBack} aria-label={t('back')} title={t('back')}>{getLang() === 'he' ? '→' : '←'}</button>
        <h1 style={{ borderBottom: `5px solid ${color}`, paddingBottom: 4 }}>{list.name}</h1>
      </div>

      <div className="tabs" role="group">
        <button aria-pressed={tab === 'shop'} onClick={() => setTab('shop')}>{t('tabShop')}</button>
        {isEditor && <button aria-pressed={tab === 'manage'} onClick={() => setTab('manage')}>{t('tabManage')}</button>}
        {narrow
          ? <TabMenu items={secondary} current={tab} onPick={(id) => setTab(id)} />
          : secondary.map((i) => <button key={i.id} aria-pressed={tab === i.id} onClick={() => setTab(i.id)}>{i.label}</button>)}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {tab === 'shop' && <ShopTab data={data} me={me} onToggle={toggle} onFinish={finish} />}
      {isEditor && tab === 'manage' && <ManageTab data={data} me={me} reload={load} onDeleted={onBack} />}
      {moduleTabs.map((m) => tab === `${m.moduleId}:${m.id}` && <m.component key={`${m.moduleId}:${m.id}`} data={data} me={me} reload={load} />)}
      {tab === 'history' && <HistoryTab data={data} me={me} reload={load} />}
    </div>
  );
}
