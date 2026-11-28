import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { t, setLang } from './i18n';
import type { Cfg, Me } from './types';
import { AuthScreens, ChangePasswordScreen } from './Auth';
import Home from './Home';
import Settings from './Settings';
import Admin from './Admin';
import ListView from './ListView';
import HouseholdScreen from './HouseholdScreen';
import { CreateHousehold, CreateList } from './Create';
import { syncModules } from './modules';
import { initPrefs } from './prefs';
import type { NavGroup } from './SideNav';
import { go, goBack, parentOf, replace, resetStartup, useRoute } from './nav';

type State = { kind: 'loading' } | { kind: 'offline' } | { kind: 'ready'; cfg: Cfg; me: Me | null };

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [, setLangTick] = useState(0); // redraw when a language module has been loaded or removed
  const route = useRoute();

  // English until the user is known; then the user's language (English too if its module is missing or switched off).
  // Set synchronously so every child renders in the right language and direction.
  const me0 = state.kind === 'ready' ? state.me : null;
  setLang(me0?.language ?? 'en');

  const load = useCallback(async () => {
    try {
      const cfg = await api<Cfg>('/public-config');
      let me: Me | null = null;
      try {
        me = (await api<{ user: Me }>('/me')).user;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e; // 401 = not signed in
      }
      // Language modules are loaded before the first screen, so a Hebrew user never sees an English flash.
      if (me) await syncModules(me.modules);
      setState({ kind: 'ready', cfg, me });
    } catch {
      setState({ kind: 'offline' });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const me = state.kind === 'ready' ? state.me : null;
  useEffect(() => { document.documentElement.dataset.theme = me?.theme ?? 'system'; }, [me?.theme]);
  useEffect(() => { initPrefs(me?.prefs); }, [me?.prefs]);
  useEffect(() => { document.title = t('appName'); }, [me?.language, me?.modules]);
  // Modules the user may use and has switched on add their screens here; one that is switched off is taken away again.
  useEffect(() => { syncModules(me?.modules ?? []).then(() => setLangTick((n) => n + 1)); }, [me?.modules]);

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    resetStartup(); replace({ k: 'home' });
    await load();
  };

  // Esc does what the arrow does (not while typing, nor while a menu or dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || route.k === 'home') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (document.querySelector('.menu-panel, [role="dialog"]')) return;
      e.preventDefault();
      history.length > 1 ? goBack(parentOf(route)) : replace({ k: 'home' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route]);

  if (state.kind === 'loading') return <div className="auth"><p className="muted">{t('loading')}</p></div>;

  if (state.kind === 'offline') {
    return (
      <div className="auth">
        <div className="auth-box">
          <h1>{t('offlineTitle')}</h1>
          <p className="muted">{t('offlineBody')}</p>
          <button className="btn primary" onClick={() => { setState({ kind: 'loading' }); load(); }}>{t('retry')}</button>
        </div>
      </div>
    );
  }

  const { cfg } = state;
  if (!me) {
    return <AuthScreens cfg={cfg} onDone={load} />;
  }
  if (me.mustChangePassword) {
    return <ChangePasswordScreen cfg={cfg} forced onDone={load} onLogout={logout} />;
  }

  // The groups every menu ends with: Me (Settings, Sign out) and, for admins, Server (Administration). The first two groups of a menu
  // (This list, Household) belong to the screen that shows it.
  const accountGroups: NavGroup[] = [
    { id: 'me', heading: t('menuGroupMe'), items: [
      { id: 'settings', label: t('navSettings'), onClick: () => go({ k: 'settings' }) },
      { id: 'signout', label: t('signOut'), onClick: logout },
    ] },
    ...(me.role === 'admin' ? [{ id: 'server', heading: t('menuGroupServer'), items: [{ id: 'admin', label: t('navAdmin'), onClick: () => go({ k: 'admin' }) }] }] : []),
  ];

  // Pages that use the width of a tablet or desktop (a sidebar, two columns) get a wider column.
  const wide = route.k === 'settings' || route.k === 'admin' || (route.k === 'list' && (!!route.page || route.tab === 'manage'));
  const screen = (() => {
    switch (route.k) {
      case 'list': return <ListView key={route.id} listId={route.id} tab={route.tab} page={route.page} me={me} accountGroups={accountGroups} />;
      case 'newList': return <CreateList me={me} initialHid={route.hid} accountGroups={accountGroups} />;
      case 'newHousehold': return <CreateHousehold onDone={() => { load(); replace({ k: 'home' }); }} accountGroups={accountGroups} />;
      case 'household': return <HouseholdScreen me={me} hid={route.hid} part={route.part} accountGroups={accountGroups} onChanged={load} />;
      case 'settings': return <Settings me={me} cfg={cfg} onChange={load} accountGroups={accountGroups} section={route.section} />;
      case 'admin': return me.role === 'admin' ? <Admin me={me} route={route} accountGroups={accountGroups} /> : null;
      default: return <Home me={me} onMeChange={load} accountGroups={accountGroups} />;
    }
  })();

  return (
    <div className="shell">
      <main className={wide ? 'wide' : undefined}>{screen}</main>
    </div>
  );
}
