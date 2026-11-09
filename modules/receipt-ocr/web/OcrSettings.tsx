import { useEffect, useState, type FormEvent } from 'react';
import { api, t, errText } from './sdk';

type Prefs = { engine: 'auto' | 'local' | 'cloud'; provider: 'anthropic' | 'openai' | 'gemini'; model: string; hasKey: boolean };

// Settings > Receipt reading: which engine reads receipt photos, and the user's own cloud key (stored encrypted, never shown again).
export default function OcrSettings({ onChange }: { onChange: () => void }) {
  const [cur, setCur] = useState<Prefs | null>(null);
  const [engine, setEngine] = useState<Prefs['engine']>('auto');
  const [provider, setProvider] = useState<Prefs['provider']>('anthropic');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const defaults: Record<string, string> = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o', gemini: 'gemini-2.0-flash' };

  const apply = (p: Prefs) => { setCur(p); setEngine(p.engine); setProvider(p.provider); setModel(p.model); };
  useEffect(() => { api<{ settings: Prefs }>('/settings').then((r) => apply(r.settings)).catch((e) => setError(errText(e))); }, []);

  const save = async (e: FormEvent, extra: Record<string, unknown> = {}) => {
    e.preventDefault(); setError(''); setMsg('');
    try {
      const r = await api<{ settings: Prefs }>('/settings', { method: 'PUT', body: { engine, provider, model, ...(key ? { apiKey: key } : {}), ...extra } });
      apply(r.settings); setKey(''); onChange(); setMsg(t('saved'));
    } catch (err) { setError(errText(err)); }
  };

  return (
    <form className="card stack" onSubmit={save}>
      <div><h2>{t('ocrTitle')}</h2><p className="muted">{t('ocrHelp')}</p></div>
      <label className="field"><span>{t('ocrEngine')}</span>
        <select value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}>
          <option value="auto">{t('ocrAuto')}</option>
          <option value="local">{t('ocrLocal')}</option>
          <option value="cloud">{t('ocrCloud')}</option>
        </select></label>
      <label className="field"><span>{t('ocrProvider')}</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Google (Gemini)</option>
        </select></label>
      <label className="field"><span>{t('ocrModel')}</span>
        <input type="text" dir="ltr" autoCapitalize="none" autoCorrect="off" value={model} placeholder={defaults[provider]} onChange={(e) => setModel(e.target.value)} /></label>
      <label className="field"><span>{t('ocrKey')}</span>
        <input type="password" dir="ltr" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={cur?.hasKey ? '••••••••' : ''} />
        {cur?.hasKey && <span className="muted" style={{ fontWeight: 400 }}>{t('ocrKeySaved')}</span>}</label>
      <div className="row">
        <button className="btn primary" type="submit">{t('save')}</button>
        {cur?.hasKey && <button className="btn danger" type="button" onClick={(e) => save(e as unknown as FormEvent, { apiKey: '' })}>{t('ocrRemoveKey')}</button>}
        {msg && <span className="ok" role="status">{msg}</span>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </form>
  );
}
