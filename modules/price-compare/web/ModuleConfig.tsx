import { t } from './sdk';
import AdminSettings from './AdminSettings';
import PortalsPanel from './PortalsPanel';

// Everything an admin configures for this module, in one place: Admin > Modules > Price comparison > Configure.
export default function ModuleConfig() {
  return (
    <div className="stack">
      <section className="card stack-sm"><h3 style={{ margin: 0 }}>{t('configUpdates')}</h3><AdminSettings /></section>
      <section className="stack-sm"><h3 style={{ margin: 0 }}>{t('portalsTitle')}</h3><PortalsPanel /></section>
    </div>
  );
}
