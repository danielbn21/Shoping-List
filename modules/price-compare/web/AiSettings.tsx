import { useEffect, useState, type FormEvent } from 'react';
import { api, t, errText } from './sdk';

type Cfg = { provider: 'anthropic' | 'openai' | 'gemini'; hasKey: boolean };

// Settings > English item names: an optional AI key. With one, English item names the built-in dictionary cannot translate are sent to that
// provider (only the names) so they can be found among Hebrew product names. The key is stored encrypted and never shown again.
export default function AiSettings() {
  const [cur, setCur] = useState<Cfg | null>(null);
  const [provider, setProvider] = useState<Cfg['provider']>('anthropic');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api<{ settings: Cfg }>('/ai/settings').then((r) => { setCur(r.settings); setProvider(r.settings.provider); }).catch((e) => setError(errText(e))); }, []);

  const save = async (e: FormEvent, extra: Record<string, unknown> = {}) => {
    e.preventDefault(); setError(''); setMsg('');
    try {
      const r = await api<{ settings: Cfg }>('/ai/settings', { method: 'PUT', body: { provider, ...(key ? { apiKey: key } : {}), ...extra } });
      setCur(r.settings); setKey(''); setMsg(t('saved'));
    } catch (err) { setError(errText(err)); }
  };

  return (
    <form className="card stack" onSubmit={save}>
      <div><h2>{t('aiTitle')}</h2><p className="muted">{t('aiHelp')}</p></div>
      <label className="field"><span>{t('aiProvider')}</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as Cfg['provider'])}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Google (Gemini)</option>
        </select></label>
      <label className="field"><span>{t('aiKey')}</span>
        <input type="password" dir="ltr" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={cur?.hasKey ? '••••••••' : ''} />
        {cur?.hasKey && <span className="muted" style={{ fontWeight: 400 }}>{t('aiKeySaved')}</span>}</label>
      <div className="row">
        <button className="btn primary" type="submit">{t('save')}</button>
        {cur?.hasKey && <button className="btn danger" type="button" onClick={(e) => save(e as unknown as FormEvent, { apiKey: '' })}>{t('aiRemoveKey')}</button>}
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
