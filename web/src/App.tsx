import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { t, setLang } from './i18n';
import type { Cfg, Me } from './types';
import { AuthScreens, ChangePasswordScreen } from './Auth';
import Home from './Home';
import Settings from './Settings';
import Admin from './Admin';
import { syncModules } from './modules';
import { initPrefs } from './prefs';

type State = { kind: 'loading' } | { kind: 'offline' } | { kind: 'ready'; cfg: Cfg; me: Me | null };
type View = 'home' | 'settings' | 'admin';

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [, setLangTick] = useState(0); // redraw when a language module has been loaded or removed
  const [view, setView] = useState<View>('home');

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
    setView('home');
    await load();
  };

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

  const current: View = view === 'admin' && me.role !== 'admin' ? 'home' : view;
  const navBtn = (v: View, label: string) => (
    <button aria-current={current === v ? 'page' : undefined} onClick={() => setView(v)}>{label}</button>
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><img src="/icon-192.png" alt="" />{t('appName')}</div>
        <nav className="nav" aria-label="Main">
          {navBtn('home', t('navHome'))}
          {navBtn('settings', t('navSettings'))}
          {me.role === 'admin' && navBtn('admin', t('navAdmin'))}
        </nav>
      </header>
      <main>
        {current === 'home' && <Home me={me} onMeChange={load} />}
        {current === 'settings' && <Settings me={me} cfg={cfg} onChange={load} onLogout={logout} />}
        {current === 'admin' && <Admin me={me} />}
      </main>
    </div>
  );
}
