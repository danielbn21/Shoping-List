import fs from 'node:fs';
import { runTesseract, cloudOcr, parseReceiptText, PROVIDERS } from './ocr.js';

// This module's own database (data/modules/receipt-ocr/data.db): each user's reading preferences and, encrypted, their own API key.
export const migrations = [
  `CREATE TABLE user_ocr (
     user_id INTEGER PRIMARY KEY,
     engine TEXT NOT NULL DEFAULT 'auto' CHECK (engine IN ('auto','local','cloud')),
     provider TEXT,
     model TEXT,
     api_key_enc TEXT
   );`,
];

export default function register(ctx) {
  const { db } = ctx;
  // ctx.options.run lets tests replace the two engines.
  const run = { tesseract: runTesseract, cloud: cloudOcr, ...(ctx.options.run || {}) };
  const prefs = (userId) => db.prepare('SELECT * FROM user_ocr WHERE user_id = ?').get(userId);

  function engineFor(userId, requested) {
    const o = prefs(userId);
    const key = o?.api_key_enc ? ctx.secrets.decrypt(o.api_key_enc) : null;
    const want = requested ?? o?.engine ?? 'auto';
    if (key && o.provider && (want === 'cloud' || want === 'auto')) return { engine: 'cloud', provider: o.provider, model: o.model, key };
    return { engine: 'local' };
  }

  // The 'receipt-reader' capability: the core hands over a photo, gets back lines and a total. It never saves anything itself.
  ctx.provide('receipt-reader', {
    id: 'receipt-ocr',
    async read({ file, mime, userId, engine }) {
      const cfg = engineFor(userId, engine);
      try {
        if (cfg.engine === 'cloud') {
          return { engine: 'cloud', provider: cfg.provider, ...(await run.cloud({ provider: cfg.provider, apiKey: cfg.key, model: cfg.model, image: fs.readFileSync(file), mime })) };
        }
        const text = await run.tesseract(file);
        return { engine: 'local', text: text.slice(0, 20000), ...parseReceiptText(text) };
      } catch (e) { e.engine = cfg.engine; throw e; }
    },
  });

  const shape = (userId) => { const o = prefs(userId); return { engine: o?.engine ?? 'auto', provider: o?.provider ?? 'anthropic', model: o?.model ?? '', hasKey: !!o?.api_key_enc }; };
  ctx.routes.get('/settings', async (req) => ({ settings: shape(req.user.id), providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])) }));

  // The API key is stored encrypted and never returned.
  ctx.routes.put('/settings', async (req, reply) => {
    const b = req.body || {};
    const cur = prefs(req.user.id);
    const engine = b.engine ?? cur?.engine ?? 'auto';
    if (!['auto', 'local', 'cloud'].includes(engine)) return reply.code(400).send({ error: 'invalid_value' });
    const provider = b.provider ?? cur?.provider ?? 'anthropic';
    if (!PROVIDERS[provider]) return reply.code(400).send({ error: 'invalid_value' });
    const model = String(b.model ?? cur?.model ?? '').trim().slice(0, 80);
    let keyEnc = cur?.api_key_enc ?? null;
    if (b.apiKey !== undefined) {
      const k = String(b.apiKey).trim();
      if (k.length > 400) return reply.code(400).send({ error: 'invalid_value' });
      keyEnc = k ? ctx.secrets.encrypt(k) : null;
    }
    db.prepare(`INSERT INTO user_ocr(user_id, engine, provider, model, api_key_enc) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET engine = excluded.engine, provider = excluded.provider, model = excluded.model, api_key_enc = excluded.api_key_enc`)
      .run(req.user.id, engine, provider, model || null, keyEnc);
    return { settings: shape(req.user.id) };
  });

  ctx.events.on('user.deleted', ({ userId }) => db.prepare('DELETE FROM user_ocr WHERE user_id = ?').run(userId));
}
