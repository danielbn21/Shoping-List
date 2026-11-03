import { useEffect, useState } from 'react';
import { t } from './i18n';

// The installed app keeps its files in a service-worker cache. If the server was upgraded but this device still runs the old
// files, say so, and offer a clean update (drop the cache and reload).
export async function cleanReload() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* best effort */ }
  window.location.reload();
}

export default function VersionGuard() {
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    const check = async () => {
      try { const r = await fetch('/api/health', { cache: 'no-store' }); const j = await r.json(); setServer(j.version ?? null); } catch { /* offline */ }
    };
    check();
    const vis = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);
  if (!server || server === __APP_VERSION__) return null;
  return (
    <div className="stale" role="alert">
      <span>{t('updateAvailable', { web: __APP_VERSION__, server })}</span>
      <button className="btn small signal" onClick={cleanReload}>{t('updateNow')}</button>
    </div>
  );
}
