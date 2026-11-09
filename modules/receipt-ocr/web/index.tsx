import type { Host, SettingsSectionProps } from '../../../web/src/host';
import { setHost, t } from './sdk';
import OcrSettings from './OcrSettings';

export default function register(host: Host) {
  setHost(host);
  host.slots.add('settings.section', { id: 'ocr', title: () => t('ocrTitle'), order: 10, component: (p: SettingsSectionProps) => <OcrSettings onChange={p.onChange} /> });
}
