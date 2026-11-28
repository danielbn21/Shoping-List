import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText } from './i18n';
import { LIST_COLORS, type Me } from './types';
import ScreenHeader from './ScreenHeader';
import Menu from './Menu';
import { flattenGroups } from './menus';
import type { NavGroup } from './SideNav';
import { goBack, replace } from './nav';

// The two "new" screens. Both have the shared header with the arrow, and a Cancel button on the form.
export function CreateHousehold({ onDone, accountGroups }: { onDone: () => void; accountGroups: NavGroup[] }) {
  const onCancel = () => goBack({ k: 'home' });
  const onCreated = onDone;
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try { await api('/households', { method: 'POST', body: { name } }); onCreated(); } catch (err) { setError(errText(err)); }
  }
  return (
    <div className="stack">
    <ScreenHeader title={t('newHouseholdTitle')} onBack={onCancel} backLabel={t('backGeneric')} right={<Menu items={flattenGroups(accountGroups)} />} />
    <form className="card stack" onSubmit={submit}>
      <label className="field"><span>{t('householdNameLabel')}</span>
        <input type="text" dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit">{t('newHouseholdBtn')}</button>
        <button className="btn" type="button" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
    </div>
  );
}

export function CreateList({ me, initialHid, accountGroups }: { me: Me; initialHid: number; accountGroups: NavGroup[] }) {
  const onCancel = () => goBack({ k: 'home' });
  const onCreated = (id: number) => replace({ k: 'list', id });
  const [name, setName] = useState('');
  const [hid, setHid] = useState(initialHid);
  const [vis, setVis] = useState<'household' | 'private'>('household');
  const [color, setColor] = useState('green');
  const [members, setMembers] = useState<{ id: number; name: string }[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (vis !== 'private') return;
    api<{ members: { id: number; name: string }[] }>(`/households/${hid}/members`)
      .then((r) => setMembers(r.members.filter((m) => m.id !== me.id))).catch(() => setMembers([]));
    setPicked([]);
  }, [vis, hid, me.id]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try {
      const r = await api<{ id: number }>('/lists', { method: 'POST', body: { householdId: hid, name, visibility: vis, color, memberIds: picked } });
      onCreated(r.id);
    } catch (err) { setError(errText(err)); }
  }

  return (
    <div className="stack">
    <ScreenHeader title={t('newList')} onBack={onCancel} backLabel={t('backGeneric')} right={<Menu items={flattenGroups(accountGroups)} />} />
    <form className="card stack" onSubmit={submit}>
      <label className="field"><span>{t('listName')}</span>
        <input type="text" dir="auto" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {me.households.length > 1 && (
        <label className="field"><span>{t('household')}</span>
          <select value={hid} onChange={(e) => setHid(Number(e.target.value))}>
            {me.households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select></label>
      )}
      <div className="field"><span>{t('shareWith')}</span>
        <label className="check"><input type="radio" name="vis" checked={vis === 'household'} onChange={() => setVis('household')} />{t('visHousehold')}</label>
        <label className="check"><input type="radio" name="vis" checked={vis === 'private'} onChange={() => setVis('private')} />{t('visPrivate')}</label>
      </div>
      {vis === 'private' && members.length > 0 && (
        <div className="field"><span>{t('pickMembers')}</span>
          {members.map((m) => (
            <label className="check" key={m.id}>
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} /><bdi>{m.name}</bdi>
            </label>
          ))}
        </div>
      )}
      <div className="field"><span>{t('listColor')}</span>
        <div className="swatches">
          {Object.entries(LIST_COLORS).map(([k, hex]) => (
            <button type="button" key={k} className="swatch" aria-label={k} aria-pressed={color === k} style={{ ['--c' as string]: hex }} onClick={() => setColor(k)} />
          ))}
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit">{t('createList')}</button>
        <button className="btn" type="button" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
    </div>
  );
}
