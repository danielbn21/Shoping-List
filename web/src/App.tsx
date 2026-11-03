import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { t, setLang, detectLang, type Lang } from './i18n';
import type { Cfg, Me } from './types';
import { AuthScreens, ChangePasswordScreen } from './Auth';
import Home from './Home';
import Settings from './Settings';
import Admin from './Admin';

type State = { kind: 'loading' } | { kind: 'offline' } | { kind: 'ready'; cfg: Cfg; me: Me | null };
type View = 'home' | 'settings' | 'admin';

export default function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [lang, setLangState] = useState<Lang>(detectLang());
  const [view, setView] = useState<View>('home');

  // Set synchronously so every child renders in the right language and direction.
  setLang(lang);

  const load = useCallback(async () => {
    try {
      const cfg = await api<Cfg>('/public-config');
      let me: Me | null = null;
      try {
        me = (await api<{ user: Me }>('/me')).user;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e; // 401 = not signed in
      }
      setState({ kind: 'ready', cfg, me });
    } catch {
      setState({ kind: 'offline' });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const me = state.kind === 'ready' ? state.me : null;
  useEffect(() => { if (me) setLangState(me.language); }, [me?.language]);
  useEffect(() => { localStorage.setItem('sl_lang', lang); }, [lang]);
  useEffect(() => { document.documentElement.dataset.theme = me?.theme ?? 'system'; }, [me?.theme]);
  useEffect(() => { document.title = t('appName'); }, [lang]);

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
    return <AuthScreens cfg={cfg} lang={lang} setLang={setLangState} onDone={load} />;
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
