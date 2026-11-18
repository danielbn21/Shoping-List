import { HEBREW, phraseKey } from './translate.js';

// Optional: when a person has saved their own AI key (Settings), English item names the dictionary cannot translate are sent to that
// provider, ONLY the item names, in one request per batch. The Hebrew search words that come back are kept in `translations`, so each English
// phrase is asked about once, for everybody. Without a key nothing is sent anywhere and the dictionary alone is used.

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-haiku-5-5' },
  openai: { label: 'OpenAI', model: 'gpt-4o-mini' },
  gemini: { label: 'Google (Gemini)', model: 'gemini-2.0-flash' },
};

const PROMPT = (phrases) => `Shopping list items typed in English must be found among the products of Israeli supermarkets, whose names are in Hebrew.
For every item give the Hebrew words a supermarket price file would use for that kind of product: the product type first, 1 to 4 words, without sizes, without
quantities and without a brand unless the item names one (write a brand the way Israelis do, for example Osem as אסם). If the item lists alternatives, give each alternative
separated by " | ". If an item is not a product (a note or a question), answer an empty string. Items that are already Hebrew are returned unchanged.
Reply with ONLY a JSON object, no prose: {"items":[{"en":"<the item exactly as given>","he":"<Hebrew words>"}]}
Items:
${JSON.stringify(phrases)}`;

function extractJson(text) {
  const s = String(text).replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('ai_bad_response');
  return JSON.parse(s.slice(a, b + 1));
}

// -> Map(en phrase as given -> Hebrew words), only for answers that are Hebrew and of a sensible length.
export async function translatePhrases({ provider, apiKey, model, phrases, fetchImpl = fetch, timeoutMs = 45000 }) {
  const m = model || PROVIDERS[provider]?.model;
  let url, headers, body, pick;
  const prompt = PROMPT(phrases);
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
    body = { model: m, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] };
    pick = (d) => d.content?.find((c) => c.type === 'text')?.text;
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    body = { model: m, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] };
    pick = (d) => d.choices?.[0]?.message?.content;
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
    headers = { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
    body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } };
    pick = (d) => d.candidates?.[0]?.content?.parts?.[0]?.text;
  } else throw new Error('unknown_provider');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`ai_http_${res.status}`);                      // never echo the response: it may quote the key
    const text = pick(await res.json());
    if (!text) throw new Error('ai_bad_response');
    const out = new Map();
    for (const it of Array.isArray(extractJson(text).items) ? extractJson(text).items : []) {
      const en = String(it?.en ?? ''), he = String(it?.he ?? '').trim().replace(/\s+/g, ' ');
      if (en && he && he.length <= 80 && HEBREW.test(he)) out.set(en, he);
    }
    return out;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('ai_timeout');
    throw e;
  } finally { clearTimeout(timer); }
}

export function createAi({ db, secrets, options = {}, now = Date.now }) {
  const run = { translate: translatePhrases, ...(options.ai || {}) };
  const RETRY_AFTER = 3_600_000, BATCH = 25, MAX_PER_ROUND = 150;
  const getCfg = db.prepare('SELECT * FROM ai_settings WHERE user_id = ?');
  const putXlat = db.prepare("INSERT INTO translations(en, he, source, made_at) VALUES (?,?,'ai',?) ON CONFLICT(en) DO UPDATE SET he = excluded.he, made_at = excluded.made_at");
  const hasXlat = db.prepare('SELECT 1 FROM translations WHERE en = ?');
  const inflight = new Set(), errors = new Map(), skipUntil = new Map();

  const keyOf = (userId) => { const c = getCfg.get(userId); if (!c) return null; try { return { provider: c.provider, key: secrets.decrypt(c.key_enc) }; } catch { return null; } };

  const settings = (userId) => { const c = getCfg.get(userId); return { provider: c?.provider ?? 'anthropic', hasKey: !!c }; };
  function save(userId, { provider, apiKey }) {
    const cur = getCfg.get(userId);
    const p = provider ?? cur?.provider ?? 'anthropic';
    if (!PROVIDERS[p]) return { error: 'invalid_value' };
    let enc = cur?.key_enc ?? null;
    if (apiKey !== undefined) {
      const k = String(apiKey).trim();
      if (k.length > 400) return { error: 'invalid_value' };
      enc = k ? secrets.encrypt(k) : null;
    }
    if (!enc) { db.prepare('DELETE FROM ai_settings WHERE user_id = ?').run(userId); errors.delete(userId); return { settings: settings(userId) }; }
    db.prepare('INSERT INTO ai_settings(user_id, provider, key_enc, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, key_enc = excluded.key_enc, updated_at = excluded.updated_at')
      .run(userId, p, enc, now());
    errors.delete(userId);
    return { settings: settings(userId) };
  }

  // phrases: normalised English item names the dictionary could not fully translate. Starts a background request when the person has a key.
  // -> { enabled, pending, running, error }
  function ensure(userId, phrases) {
    const cfg = keyOf(userId);
    if (!cfg) return { enabled: false, pending: 0, running: false, error: null };
    const t = now();
    const todo = [...new Set(phrases)].filter((p) => p && !hasXlat.get(p) && !((skipUntil.get(p) ?? 0) > t)).slice(0, MAX_PER_ROUND);
    if (todo.length && !inflight.has(userId)) {
      inflight.add(userId);
      (async () => {
        try {
          for (let i = 0; i < todo.length; i += BATCH) {
            const batch = todo.slice(i, i + BATCH);
            const got = await run.translate({ provider: cfg.provider, apiKey: cfg.key, phrases: batch });
            for (const p of batch) {
              const he = got.get(p);
              if (he) putXlat.run(p, he, now()); else skipUntil.set(p, now() + RETRY_AFTER);          // not understood: not asked again for a while
            }
          }
          errors.delete(userId);
        } catch (e) { errors.set(userId, String(e?.message || e).slice(0, 80)); for (const p of todo) skipUntil.set(p, now() + 600_000); }
        finally { inflight.delete(userId); }
      })();
    }
    return { enabled: true, pending: todo.length, running: inflight.has(userId), error: errors.get(userId) ?? null };
  }

  return { settings, save, ensure, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])), forget: (userId) => db.prepare('DELETE FROM ai_settings WHERE user_id = ?').run(userId) };
}
