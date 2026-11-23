import type { Host, ToolbarProps, TripToolbarProps } from '../../../web/src/host';
import { setHost, t } from './sdk';
import ScanButton from './Scanner';

export default function register(host: Host) {
  setHost(host);
  host.slots.add('shop.toolbar', { id: 'scan-shop', title: () => t('scanTitle'), order: 10, component: (p: ToolbarProps) => <ScanButton {...p} mode="shop" /> });
  host.slots.add('manage.toolbar', { id: 'scan-manage', title: () => t('scanTitle'), order: 10, component: (p: ToolbarProps) => <ScanButton {...p} mode="manage" /> });
  // Add a trip (core 1.8.0): scanning fills a row of the form with the product's name and price; nothing is saved until the trip is.
  host.slots.add('trip.toolbar', { id: 'scan-trip', title: () => t('scanTitle'), order: 10, component: (p: TripToolbarProps) => (
    <ScanButton data={p.data} me={p.me} reload={async () => {}} storeId="" mode="trip" onPick={(x) => p.addRows([{ name: x.name, qty: 1, price: x.price, itemId: x.itemId, categoryId: x.categoryId }])} />) });
}
