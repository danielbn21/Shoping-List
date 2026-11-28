import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { t } from './i18n';
import { LIST_COLORS, type ListSummary, type Me } from './types';
import Menu from './Menu';
import ScreenHeader from './ScreenHeader';
import type { NavEntry, NavGroup } from './SideNav';
import { flattenGroups } from './menus';
import { go, replace, consumeStartup } from './nav';
import { openModeOf } from './prefs';
import { SortableList } from './dnd';

type InstallEvent = Event & { prompt: () => Promise<void> };

// Home: the lists of every household. accountGroups (Me, Server) come from App and join the menu.
export default function Home({ me, onMeChange, accountGroups }: { me: Me; onMeChange: () => void; accountGroups: NavGroup[] }) {
  const [lists, setLists] = useState<ListSummary[] | null>(null);
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
  // When the app opens: the last list the person was on (if they chose "where I left off"), else a lone list straight away. Once per sign-in:
  // coming back to Home with the arrow never jumps forward again.
  useEffect(() => {
    if (!lists || !consumeStartup()) return;
    const last = me.prefs.last?.list;
    if (openModeOf(me.prefs) === 'last' && last !== undefined && lists.some((l) => l.id === last)) replace({ k: 'list', id: last });
    else if (lists.length === 1) replace({ k: 'list', id: lists[0].id });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists]);

  if (lists === null) return <p className="muted">{t('loading')}</p>;

  const multi = me.households.length > 1;
  const listsOf = (hid: number) => lists.filter((l) => l.householdId === hid);
  const only = me.households[0];
  const hhItems = (hid: number): NavEntry[] => [
    { id: `members${hid}`, label: t('membersInvites'), onClick: () => go({ k: 'household', hid, part: 'members' }) },
    { id: `export${hid}`, label: t('exportPurchasesRow'), onClick: () => go({ k: 'household', hid, part: 'export' }) },
    ...(listsOf(hid).length > 1 ? [{ id: `reorder${hid}`, label: t('reorderLists'), onClick: () => setReorderLists(hid) }] : []),
  ];

  const reorderIn = async (hid: number, next: ListSummary[]) => {
    setLists((prev) => prev && [...prev.filter((l) => l.householdId !== hid), ...next]);
    try { await api(`/households/${hid}/lists/order`, { method: 'PUT', body: { ids: next.map((l) => l.id) } }); } catch { load(); }
  };
  const reorderHh = async (next: { id: number }[]) => {
    try { await api('/households/order', { method: 'PUT', body: { ids: next.map((h) => h.id) } }); } finally { onMeChange(); }
  };

  // Menu: Household (a single household's pages here; several households each have their own menu below), Me, Server.
  const hhGroup: NavGroup[] = [];
  if (!multi && only) hhGroup.push({ id: 'household', heading: t('menuGroupHousehold', { name: only.name }), items: hhItems(only.id) });
  const more: NavGroup = { id: 'more', items: [] };
  if (me.canCreateHousehold) more.items.push({ id: 'newhh', label: t('newHouseholdBtn'), onClick: () => go({ k: 'newHousehold' }) });
  if (multi) more.items.push({ id: 'orderhh', label: t('reorderHouseholds'), onClick: () => setReorderHouseholds(true) });
  if (!multi && more.items.length && hhGroup.length) hhGroup[0].items.push(...more.items); else if (more.items.length) hhGroup.push(more);

  const card = (l: ListSummary) => (
    <button key={l.id} className="list-card" style={{ ['--c' as string]: LIST_COLORS[l.color] ?? LIST_COLORS.green }} onClick={() => go({ k: 'list', id: l.id })}>
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
      <ScreenHeader brand title={t('hello', { name: me.name })}
        right={<div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
          {!multi && only && <button className="btn signal" onClick={() => go({ k: 'newList', hid: only.id })}>{t('newList')}</button>}
          <Menu items={flattenGroups([...hhGroup, ...accountGroups])} />
        </div>} />

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
        const items = flattenGroups([{ id: 'hh', items: hhItems(h.id) }]);
        return (
          <section key={h.id} className="hh stack-sm">
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <h2 dir="auto" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{h.name}</h2>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <button className="btn small signal" onClick={() => go({ k: 'newList', hid: h.id })}>{t('newList')}</button>
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
