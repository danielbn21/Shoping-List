import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { t, errText, getLang } from './i18n';
import type { Me } from './types';

type Member = { id: number; name: string; username: string; role: 'owner' | 'member' };
type Invite = { id: number; code: string; maxUses: number | null; uses: number };

export default function HouseholdScreen({ me, hid, onBack, onChanged }: { me: Me; hid: number; onBack: () => void; onChanged: () => void }) {
  const h = me.households.find((x) => x.id === hid);
  const owner = h?.role === 'owner' || me.role === 'admin';
  const [name, setName] = useState(h?.name ?? '');
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [fresh, setFresh] = useState<{ code: string; link: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [username, setUsername] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    try {
      setMembers((await api<{ members: Member[] }>(`/households/${hid}/members`)).members);
      if (owner) setInvites((await api<{ invites: Invite[] }>(`/households/${hid}/invites`)).invites);
    } catch { /* household may be gone */ }
  }, [hid, owner]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!h) onBack(); }, [h, onBack]);
  if (!h) return null;

  // `leaving` is for actions after which this household no longer exists for you, so there is nothing to reload.
  const run = async (fn: () => Promise<unknown>, after?: () => void, leaving = false) => {
    setError(''); setSaved(false);
    try { await fn(); if (!leaving) await load(); onChanged(); after?.(); } catch (e) { setError(errText(e)); }
  };
  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500); } catch { /* ignore */ }
  };

  const rename = (e: FormEvent) => { e.preventDefault(); run(() => api(`/households/${hid}`, { method: 'PATCH', body: { name } }), () => setSaved(true)); };
  const addMember = (e: FormEvent) => { e.preventDefault(); if (username.trim()) run(async () => { await api(`/households/${hid}/members`, { method: 'POST', body: { username: username.trim() } }); setUsername(''); }); };
  const makeInvite = () => run(async () => { setFresh(await api(`/invites`, { method: 'POST', body: { householdId: hid } })); });

  return (
    <div className="stack">
      <div className="listhead">
        <button className="iconbtn" onClick={onBack} aria-label={t('back')} title={t('back')}>{getLang() === 'he' ? '→' : '←'}</button>
        <h1>{h.name}</h1>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {owner && (
        <form className="card stack-sm" onSubmit={rename}>
          <h2>{t('householdNameLabel')}</h2>
          <div className="inline-form">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('householdNameLabel')} required />
            <button className="btn small primary" type="submit">{t('save')}</button>
          </div>
          {saved && <p className="ok" role="status">{t('saved')}</p>}
        </form>
      )}

      <section className="card stack-sm">
        <h2>{t('members')}</h2>
        {members.map((m) => (
          <div className="row between" key={m.id} style={{ flexWrap: 'nowrap' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong>{m.name}</strong> <span className="muted" dir="ltr">@{m.username}</span>
            </div>
            {owner ? (
              <>
                <select value={m.role} aria-label={m.name} onChange={(e) => run(() => api(`/households/${hid}/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } }))}>
                  <option value="owner">{t('roleOwner')}</option>
                  <option value="member">{t('roleMember')}</option>
                </select>
                {m.id !== me.id && (
                  <button className="iconbtn danger" aria-label={t('removeMember')} title={t('removeMember')}
                    onClick={() => { if (confirm(t('confirmRemoveMember', { name: m.name }))) run(() => api(`/households/${hid}/members/${m.id}`, { method: 'DELETE' })); }}>✕</button>
                )}
              </>
            ) : <span className="chip">{m.role === 'owner' ? t('roleOwner') : t('roleMember')}</span>}
          </div>
        ))}
        {owner && (
          <form className="stack-sm" onSubmit={addMember}>
            <p className="muted">{t('addMemberHelp')}</p>
            <div className="inline-form">
              <input type="text" dir="ltr" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('memberUsername')} aria-label={t('memberUsername')} />
              <button className="btn small" type="submit" disabled={!username.trim()}>{t('addMember')}</button>
            </div>
          </form>
        )}
      </section>

      {owner && (
        <section className="card stack-sm">
          <div><h2>{t('inviteSection')}</h2><p className="muted">{t('inviteSectionHelp')}</p></div>
          <div><button className="btn" onClick={makeInvite}>{t('createInvite')}</button></div>
          {fresh && (
            <div className="stack-sm">
              <p className="muted">{t('inviteReady')}</p>
              <div className="code">{fresh.code}</div>
              <div className="row">
                <button className="btn small" onClick={() => copy(fresh.code, 'code')}>{copied === 'code' ? t('copied') : `${t('copy')} ${t('inviteCode')}`}</button>
                <button className="btn small" onClick={() => copy(fresh.link, 'link')}>{copied === 'link' ? t('copied') : `${t('copy')} ${t('inviteLink')}`}</button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="stack-sm">
              <h3>{t('activeInvites')}</h3>
              {invites.map((i) => (
                <div className="row between" key={i.id}>
                  <span className="code" style={{ fontSize: '1rem', padding: '6px 10px' }}>{i.code}</span>
                  <button className="iconbtn danger" aria-label={t('removeMember')} onClick={() => run(() => api(`/invites/${i.id}`, { method: 'DELETE' }))}>✕</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="card stack-sm">
        <h2>{t('exportPurchases')}</h2>
        <div className="row">
          <label className="field grow"><span>{t('dateFrom')}</span><input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field grow"><span>{t('dateTo')}</span><input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div><a className="btn small primary" download href={`/api/households/${hid}/purchases.csv?lang=${getLang()}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`}>{t('exportPurchases')}</a></div>
      </section>

      <section className="card stack-sm">
        <div><button className="btn danger" onClick={() => { if (confirm(t('confirmLeave', { name: h.name }))) run(() => api(`/households/${hid}/leave`, { method: 'POST' }), onBack, true); }}>{t('leaveHousehold')}</button></div>
        {owner && (
          <details>
            <summary style={{ fontWeight: 700, cursor: 'pointer', minHeight: 36 }}>{t('deleteHousehold')}</summary>
            <div className="stack-sm" style={{ marginTop: 8 }}>
              <p className="muted">{t('deleteHouseholdHelp')}</p>
              <input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={t('typeNameToConfirm')} aria-label={t('typeNameToConfirm')} />
              <div><button className="btn danger" disabled={!confirmName.trim()} onClick={() => run(() => api(`/households/${hid}`, { method: 'DELETE', body: { confirmName } }), onBack, true)}>{t('deleteHousehold')}</button></div>
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
