import { t } from './i18n';
import { useSlots } from './slots';
import { orderSections, setManageOrder, usePrefs } from './prefs';
import type { Me } from './types';

const TITLE: Record<string, () => string> = {
  add: () => t('addItems'), onlist: () => t('onThisList'), past: () => t('fromHistory'), csv: () => t('csvTitle'),
  categories: () => t('categoriesOrder'), stores: () => t('stores'), people: () => t('people'), listsettings: () => t('listNameLabel'),
};

// Settings > Manage list layout: the order of the sections of Manage list, per user (module sections included).
export default function ManageLayout({ me }: { me: Me }) {
  const mods = useSlots('manage.section', { me });
  const saved = usePrefs().manageOrder;
  const title = (id: string) => TITLE[id]?.() ?? mods.find((m) => `${m.moduleId}:${m.id}` === id)?.title() ?? id;
  const order = orderSections(mods.map((m) => `${m.moduleId}:${m.id}`), saved);
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setManageOrder(next);
  };
  return (
    <section className="card stack-sm">
      <div><h2>{t('layoutTitle')}</h2><p className="muted">{t('layoutHelp')}</p></div>
      <ol className="layout-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {order.map((id, i) => (
          <li key={id} className="row between" style={{ gap: 8 }}>
            <span className="grow" dir="auto">{title(id)}</span>
            <button type="button" className="iconbtn" disabled={i === 0} aria-label={t('layoutUp', { name: title(id) })} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="iconbtn" disabled={i === order.length - 1} aria-label={t('layoutDown', { name: title(id) })} onClick={() => move(i, 1)}>↓</button>
          </li>
        ))}
      </ol>
      {saved && <button type="button" className="btn small" onClick={() => setManageOrder(null)}>{t('layoutReset')}</button>}
    </section>
  );
}
