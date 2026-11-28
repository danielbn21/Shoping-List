import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { t, errText } from './i18n';
import { LIST_COLORS, type Detail, type Entry, type Me } from './types';
import ShopTab from './ShopTab';
import ManageTab from './ManageTab';
import HistoryTab from './HistoryTab';
import Menu from './Menu';
import ScreenHeader from './ScreenHeader';
import SideLayout, { type NavGroup } from './SideNav';
import { flattenGroups } from './menus';
import { useListPages } from './ListPages';
import { useMedia } from './util';
import { useSlots } from './slots';
import { effectiveCurrency } from './money';
import { uploadReceiptPhoto } from './imaging';
import { go, goBack, replace, type Route } from './nav';
import { getPrefs, openModeOf, rememberPlace } from './prefs';

const ic = (d: ReactNode) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
const ICONS = {
  shop: ic(<><path d="M3 4h2l2.2 10h9.6L19 7H6.2" /><circle cx="9" cy="19" r="1.6" /><circle cx="17" cy="19" r="1.6" /></>),
  manage: ic(<><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>),
  module: ic(<path d="M5 20V10M12 20V4M19 20v-7" />),
  history: ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
};

// A list: the shared header (back arrow, name, menu), the screen of the open tab and, on a phone, the tabs as a bar at the bottom edge.
// The route says which tab or menu page is open, so the back gesture, the arrow and a refresh all work (1.9.2).
export default function ListView({ listId, tab: routeTab, page: routePage, me, accountGroups }: { listId: number; tab?: string; page?: string; me: Me; accountGroups: NavGroup[] }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const sideBySide = useMedia('(min-width: 768px)');
  const moduleTabs = useSlots('list.tab', { me, data: data ?? undefined }); // tabs added by modules (for example Compare prices)
  const home = () => replace({ k: 'home' });

  const load = useCallback(async () => {
    try { setData(await api<Detail>(`/lists/${listId}`)); }
    catch (e) { if (e instanceof ApiError && e.status === 404) replace({ k: 'home' }); }
  }, [listId]);

  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => { rememberPlace(listId); }, [listId]);
  // One module tab fits the bar next to Shop, Manage and History; a module's others open from the menu.
  const tabModule = moduleTabs[0];
  const extraTabs = moduleTabs.slice(1);
  const pages = useListPages(data, me, load, home, extraTabs);
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

  const isEditor = data ? data.list.role !== 'viewer' : false; // "Shoppers" (viewer) only get the Shop tab (and History)
  const tabModuleId = tabModule ? `${tabModule.moduleId}:${tabModule.id}` : null;
  type Tab = { id: string; label: string; short?: string; icon: ReactNode };
  const tabs: Tab[] = [
    { id: 'shop', label: t('tabShop'), icon: ICONS.shop },
    ...(isEditor ? [{ id: 'manage', label: t('tabManage'), short: t('tabManageShort'), icon: ICONS.manage }] : []),
    ...(tabModule ? [{ id: tabModuleId!, label: tabModule.title(), icon: ICONS.module }] : []),
    { id: 'history', label: t('tabHistory'), short: t('tabHistoryShort'), icon: ICONS.history },
  ];
  const tabIds = tabs.map((x) => x.id);

  // Which tab a list opens on when the address does not say: a trip in progress (something ticked) always Shop; otherwise the person's own
  // setting: where they left off on this list (the default), always Shop, or always Manage.
  const needsTab = !!data && !routeTab && !routePage;
  useEffect(() => {
    if (!data || !needsTab) return;
    const inCart = data.entries.some((e) => e.state === 'in_cart');
    const prefs = getPrefs();
    const mode = openModeOf(prefs);
    let pick = 'shop';
    if (!inCart) {
      if (mode === 'manage' && isEditor) pick = 'manage';
      else if (mode === 'last') { const last = prefs.last?.tabs?.[String(listId)]; if (last && tabIds.includes(last)) pick = last; }
    }
    replace({ k: 'list', id: listId, tab: pick });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, needsTab, listId]);
  // A menu page this person cannot open (a Shopper typing the address, a module switched off) goes back to the list.
  const currentPage = routePage ? pages.find((p) => p.id === routePage) : undefined;
  useEffect(() => { if (data && routePage && !currentPage && (pages.length || !isEditor)) replace({ k: 'list', id: listId }); }, [data, routePage, currentPage, pages.length, isEditor, listId]);

  if (!data) return <p className="muted">{t('loading')}</p>;
  const { list } = data;
  const color = LIST_COLORS[list.color] ?? LIST_COLORS.green;
  const tab = routeTab && tabIds.includes(routeTab) ? routeTab : 'shop';
  const hhName = me.households.find((h) => h.id === list.householdId)?.name ?? '';
  const openPage = (id: string) => go({ k: 'list', id: listId, page: id });
  const toEntry = (p: { id: string; title: string; hint?: string; count?: number }) => ({ id: p.id, label: p.title, hint: p.hint, count: p.count, onClick: () => openPage(p.id) });
  const groups: NavGroup[] = [
    { id: 'list', heading: t('menuThisList', { name: list.name }), items: pages.filter((p) => p.group === 'list').map(toEntry) },
    { id: 'household', heading: t('menuGroupHousehold', { name: hhName }), items: pages.filter((p) => p.group === 'household').map(toEntry) },
    ...accountGroups,
  ];
  const listRoute: Route = { k: 'list', id: listId };
  const pickTab = (id: string) => { replace({ k: 'list', id: listId, tab: id }); rememberPlace(listId, id); };

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

  const menu = <Menu items={flattenGroups(groups, currentPage?.id)} />;
  const pageBody = currentPage && (
    sideBySide
      ? <SideLayout groups={groups} current={currentPage.id} label={t('menu')}><div className="stack-sm" key={currentPage.id}>{currentPage.node}</div></SideLayout>
      : <div className="stack-sm" key={currentPage.id}>{currentPage.node}</div>
  );

  return (
    <div className="stack">
      {currentPage
        ? <ScreenHeader title={currentPage.title} scope={t('scopeList', { name: list.name })} onBack={() => goBack(listRoute)} backLabel={t('backTo', { name: list.name })}
            crumbs={[{ label: t('navHome'), onClick: () => go({ k: 'home' }) }, { label: list.name, onClick: () => go(listRoute) }, { label: currentPage.title }]} right={menu} />
        : <ScreenHeader title={list.name} color={color} onBack={() => goBack({ k: 'home' })} crumbs={[{ label: t('navHome'), onClick: () => go({ k: 'home' }) }, { label: list.name }]} right={menu} />}

      {error && <p className="error" role="alert">{error}</p>}

      {currentPage ? pageBody : needsTab ? <p className="muted">{t('loading')}</p> : (
        <>
          {tab === 'shop' && <ShopTab data={data} me={me} reload={load} onToggle={toggle} onFinish={finish} />}
          {isEditor && tab === 'manage' && <ManageTab data={data} me={me} reload={load} />}
          {tabModule && tab === tabModuleId && <tabModule.component key={tabModuleId} data={data} me={me} reload={load} />}
          {tab === 'history' && <HistoryTab data={data} me={me} reload={load} />}

          <nav className="tabs" aria-label={t('tabsLabel')}>
            {tabs.map((i) => (
              <button key={i.id} aria-pressed={tab === i.id} aria-label={i.label} onClick={() => pickTab(i.id)}>
                <span className="ico">{i.icon}</span>
                <span className="lbl-full" aria-hidden="true">{i.label}</span>
                <span className="lbl-short" aria-hidden="true">{i.short ?? i.label}</span>
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
