import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { t, errText, getLang, isRtl } from './i18n';
import { LIST_COLORS, type Detail, type Entry, type Me } from './types';
import ShopTab from './ShopTab';
import ManageTab from './ManageTab';
import HistoryTab from './HistoryTab';
import TabMenu from './TabMenu';
import Menu, { type MenuItem } from './Menu';
import { useListPages } from './ListPages';
import { useNarrow } from './util';
import { useSlots } from './slots';
import { effectiveCurrency } from './money';
import { uploadReceiptPhoto } from './imaging';

const ic = (d: ReactNode) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
const ICONS = {
  shop: ic(<><path d="M3 4h2l2.2 10h9.6L19 7H6.2" /><circle cx="9" cy="19" r="1.6" /><circle cx="17" cy="19" r="1.6" /></>),
  manage: ic(<><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>),
  module: ic(<path d="M5 20V10M12 20V4M19 20v-7" />),
  history: ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  more: ic(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>),
};

// A list: a slim header (back, name, burger menu), the screen of the open tab and, on a phone, the tabs as a bar at the bottom edge.
export default function ListView({ listId, me, onBack, accountItems }: { listId: number; me: Me; onBack: () => void; accountItems: MenuItem[] }) {
  const [data, setData] = useState<Detail | null>(null);
  const [tab, setTab] = useState<string>('shop'); // opens straight into Shop mode
  const [error, setError] = useState('');
  const [page, setPage] = useState<string | null>(null); // a page of the burger menu (name, people, stores ...) shown instead of the tabs
  const narrow = useNarrow();
  const moduleTabs = useSlots('list.tab', { me, data: data ?? undefined }); // tabs added by modules (for example Compare prices)

  const load = useCallback(async () => {
    try { setData(await api<Detail>(`/lists/${listId}`)); }
    catch (e) { if (e instanceof ApiError && e.status === 404) onBack(); }
  }, [listId, onBack]);

  useEffect(() => { load(); }, [load]);
  const pages = useListPages(data, me, load, onBack);
  // The tab bar steps aside while the on-screen keyboard is up (the visual viewport shrinks); wide screens and desktops never trigger it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => document.documentElement.classList.toggle('kbd', vv.height < window.innerHeight * 0.75);
    vv.addEventListener('resize', check);
    return () => { vv.removeEventListener('resize', check); document.documentElement.classList.remove('kbd'); };
  }, []);
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
  type Tab = { id: string; label: string; short?: string; icon: ReactNode };
  const tabs: Tab[] = [
    { id: 'shop', label: t('tabShop'), icon: ICONS.shop },
    ...(isEditor ? [{ id: 'manage', label: t('tabManage'), short: t('tabManageShort'), icon: ICONS.manage }] : []),
    ...moduleTabs.map((m) => ({ id: `${m.moduleId}:${m.id}`, label: m.title(), icon: ICONS.module })),
    { id: 'history', label: t('tabHistory'), short: t('tabHistoryShort'), icon: ICONS.history },
  ];
  // Four tabs fit the bar on a phone; with more, the first three stay and the rest go into "More".
  const spill = narrow && tabs.length > 4;
  const inline = spill ? tabs.slice(0, 3) : tabs;
  const more = spill ? tabs.slice(3) : [];
  const currentPage = page ? pages.find((p) => p.id === page) : undefined;
  // Deleting a list asks first; the owner can also do it from the List name page.
  const deleteList = async () => {
    if (!confirm(t('confirmDeleteList', { name: list.name }))) return;
    try { await api(`/lists/${list.id}`, { method: 'DELETE' }); onBack(); } catch (e) { setError(errText(e)); }
  };
  const menuItems: MenuItem[] = [
    ...(pages.length ? [{ heading: t('menuThisList', { name: list.name }) } as MenuItem, ...pages.map((p): MenuItem => ({ label: p.title, hint: p.hint, count: p.count, onClick: () => setPage(p.id) }))] : []),
    ...(list.role === 'owner' ? [{ label: t('deleteList'), danger: true, onClick: deleteList } as MenuItem] : []),
    ...(accountItems.length ? [{ heading: me.name } as MenuItem, ...accountItems] : []),
  ];

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
        <button className="iconbtn" onClick={currentPage ? () => setPage(null) : onBack} aria-label={currentPage ? t('backTo', { name: list.name }) : t('back')} title={currentPage ? t('backTo', { name: list.name }) : t('back')}>{isRtl() ? '→' : '←'}</button>
        {currentPage
          ? <div className="grow"><h1 dir="auto">{currentPage.title}</h1><span className="muted" dir="auto">{list.name}</span></div>
          : <h1 dir="auto" style={{ borderBottom: `5px solid ${color}`, paddingBottom: 4 }}>{list.name}</h1>}
        {!currentPage && <Menu items={menuItems} />}
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {currentPage ? <div className="stack-sm" key={currentPage.id}>{currentPage.node}</div> : (
        <>
          {tab === 'shop' && <ShopTab data={data} me={me} reload={load} onToggle={toggle} onFinish={finish} />}
          {isEditor && tab === 'manage' && <ManageTab data={data} me={me} reload={load} />}
          {moduleTabs.map((m) => tab === `${m.moduleId}:${m.id}` && <m.component key={`${m.moduleId}:${m.id}`} data={data} me={me} reload={load} />)}
          {tab === 'history' && <HistoryTab data={data} me={me} reload={load} />}

          <nav className="tabs" aria-label={t('tabsLabel')}>
            {inline.map((i) => (
              <button key={i.id} aria-pressed={tab === i.id} aria-label={i.label} onClick={() => setTab(i.id)}>
                <span className="ico">{i.icon}</span>
                <span className="lbl-full" aria-hidden="true">{i.label}</span>
                <span className="lbl-short" aria-hidden="true">{i.short ?? i.label}</span>
              </button>
            ))}
            {more.length > 0 && <TabMenu items={more.map((i) => ({ id: i.id, label: i.label }))} current={tab} onPick={(id) => setTab(id)} />}
          </nav>
        </>
      )}
    </div>
  );
}
