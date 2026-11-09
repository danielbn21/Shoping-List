import type { Host, ListTabProps, ManageSectionProps } from '../../../web/src/host';
import { setHost, t, effectiveCurrency } from './sdk';
import CompareTab from './CompareTab';
import CompareSettings from './CompareSettings';
import PortalsPanel from './PortalsPanel';
import AdminSettings from './AdminSettings';

// Store prices are Israeli, so the comparison is hidden for people whose currency is not the shekel.
const israeli = ({ me }: { me: any }) => effectiveCurrency(me) === 'ILS';

export default function register(host: Host) {
  setHost(host);
  host.slots.add('list.tab', { id: 'compare', title: () => t('tabCompare'), order: 10, visible: israeli, component: (p: ListTabProps) => <CompareTab data={p.data} reload={p.reload} /> });
  host.slots.add('manage.section', { id: 'compare', title: () => t('tabCompare'), order: 10, visible: israeli, component: (p: ManageSectionProps) => <CompareSettings data={p.data} reload={p.reload} /> });
  host.slots.add('settings.section', { id: 'portals', title: () => t('portalsTitle'), order: 20, collapsible: true, component: () => <PortalsPanel /> });
  host.slots.add('admin.section', { id: 'settings', title: () => t('tabCompare'), component: () => <AdminSettings /> });
}
