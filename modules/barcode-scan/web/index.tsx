import type { Host, ToolbarProps } from '../../../web/src/host';
import { setHost, t } from './sdk';
import ScanButton from './Scanner';

export default function register(host: Host) {
  setHost(host);
  host.slots.add('shop.toolbar', { id: 'scan-shop', title: () => t('scanTitle'), order: 10, component: (p: ToolbarProps) => <ScanButton {...p} mode="shop" /> });
  host.slots.add('manage.toolbar', { id: 'scan-manage', title: () => t('scanTitle'), order: 10, component: (p: ToolbarProps) => <ScanButton {...p} mode="manage" /> });
}
