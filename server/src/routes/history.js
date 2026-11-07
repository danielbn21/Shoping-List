import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { audit, cleanName, getSetting, userPayload } from '../util.js';
import { makeAccess } from '../access.js';
import { addToList } from '../entries.js';
import { normalize, findReceiptMatch, isHebrew } from '../match.js';
import { reverseHebrewRuns, PROVIDERS } from '../ocr.js';
import { toCsv } from '../csv.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const round2 = (n) => Math.round(n * 100) / 100;
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e8 ? n : NaN; };

function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

export default async function historyRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { householdRole, listAccess } = makeAccess(db);

  // Anyone who can see a list can view, correct and restore its history (the person at the checkout is often a "shopper").
  function tripAccess(user, tripId) {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ? AND finished_at IS NOT NULL').get(tripId);
    if (!trip) return null;
    if (trip.list_id) { const acc = listAccess(user, trip.list_id); return acc ? { trip, list: acc.list } : null; }
    return householdRole(user.id, trip.household_id) ? { trip, list: null } : null;
  }
  const receiptAccess = (user, id) => {
    const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    const ta = r && tripAccess(user, r.trip_id);
    return ta ? { receipt: r, ...ta } : null;
  };
  const purchaseAccess = (user, id) => {
    const p = db.prepare('SELECT * FROM purchase_events WHERE id = ?').get(id);
    const ta = p && p.trip_id ? tripAccess(user, p.trip_id) : null;
    return ta ? { purchase: p, ...ta } : null;
  };

  // ---------- history list and trip detail ----------
  app.get('/api/lists/:id/history', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const before = Number(req.query.before) || null;
    const rows = db.prepare(`SELECT t.id, t.finished_at, t.total, t.currency, s.name AS store_name, u.name AS shopper_name,
        (SELECT COUNT(*) FROM purchase_events p WHERE p.trip_id = t.id) AS n,
        (SELECT SUM(line_total) FROM purchase_events p WHERE p.trip_id = t.id) AS computed,
        (SELECT COUNT(*) FROM receipts r WHERE r.trip_id = t.id) AS receipts,
        (SELECT id FROM receipts r WHERE r.trip_id = t.id ORDER BY id LIMIT 1) AS first_receipt
      FROM trips t LEFT JOIN stores s ON s.id = t.store_id LEFT JOIN users u ON u.id = t.shopper_id
      WHERE t.list_id = ? AND t.finished_at IS NOT NULL AND (? IS NULL OR t.finished_at < ?)
      ORDER BY t.finished_at DESC LIMIT ?`).all(acc.list.id, before, before, limit + 1);
    return {
      trips: rows.slice(0, limit).map((r) => ({
        id: r.id, finishedAt: r.finished_at, total: r.total, computedTotal: r.computed, currency: r.currency, storeName: r.store_name,
        shopperName: r.shopper_name, itemCount: r.n, receiptCount: r.receipts, firstReceiptId: r.first_receipt,
      })),
      more: rows.length > limit,
    };
  });

  const tripDetail = (ta) => {
    const t = ta.trip;
    const lines = db.prepare(`SELECT p.id, p.item_id, i.name, p.quantity, p.unit, p.unit_price, p.line_total
      FROM purchase_events p JOIN items i ON i.id = p.item_id WHERE p.trip_id = ? ORDER BY p.id`).all(t.id);
    const receipts = db.prepare('SELECT id, ocr_status, ocr_engine, ocr_error, uploaded_at FROM receipts WHERE trip_id = ? ORDER BY id').all(t.id);
    return {
      trip: {
        id: t.id, listId: t.list_id, listName: ta.list?.name ?? null, householdId: t.household_id, storeId: t.store_id,
        storeName: t.store_id ? db.prepare('SELECT name FROM stores WHERE id = ?').get(t.store_id)?.name ?? null : null,
        shopperName: t.shopper_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(t.shopper_id)?.name ?? null : null,
        finishedAt: t.finished_at, total: t.total, currency: t.currency,
      },
      lines: lines.map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, lineTotal: l.line_total })),
      receipts: receipts.map((r) => ({ id: r.id, ocrStatus: r.ocr_status, ocrEngine: r.ocr_engine, ocrError: r.ocr_error, uploadedAt: r.uploaded_at })),
      stores: db.prepare('SELECT id, name FROM stores WHERE household_id = ? ORDER BY id').all(t.household_id),
    };
  };

  app.get('/api/trips/:id', pre, async (req, reply) => {
    const ta = tripAccess(req.user, Number(req.params.id));
    return ta ? tripDetail(ta) : bad(reply, 'not_found', 404);
  });

  app.patch('/api/trips/:id', pre, async (req, reply) => {
    const ta = tripAccess(req.user, Number(req.params.id));
    if (!ta) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    let { total, store_id, currency } = ta.trip;
    if (b.total !== undefined) { total = money(b.total); if (Number.isNaN(total)) return bad(reply, 'invalid_total'); }
    if (b.storeId !== undefined) {
      store_id = b.storeId ? Number(b.storeId) : null;
      if (store_id && !db.prepare('SELECT 1 FROM stores WHERE id = ? AND household_id = ?').get(store_id, ta.trip.household_id)) return bad(reply, 'store_not_found');
    }
    if (b.currency !== undefined) { if (b.currency !== null && !/^[A-Z]{3}$/.test(b.currency)) return bad(reply, 'invalid_value'); currency = b.currency; }
    db.prepare('UPDATE trips SET total = ?, store_id = ?, currency = ? WHERE id = ?').run(total, store_id, currency, ta.trip.id);
    return { ok: true };
  });

  // ---------- correct a purchased line ----------
  app.patch('/api/purchases/:id', pre, async (req, reply) => {
    const pa = purchaseAccess(req.user, Number(req.params.id));
    if (!pa) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    let qty = pa.purchase.quantity, unit = pa.purchase.unit_price, line = pa.purchase.line_total;
    if (b.quantity !== undefined) { qty = Number(b.quantity); if (!(qty > 0 && qty < 10000)) return bad(reply, 'invalid_quantity'); }
    if (b.unitPrice !== undefined) { unit = money(b.unitPrice); if (Number.isNaN(unit)) return bad(reply, 'invalid_price'); line = unit === null ? line : round2(unit * qty); }
    else if (b.quantity !== undefined && unit !== null && b.lineTotal === undefined) line = round2(unit * qty);
    if (b.lineTotal !== undefined) { line = money(b.lineTotal); if (Number.isNaN(line)) return bad(reply, 'invalid_price'); if (line !== null) unit = round2(line / qty); }
    db.prepare('UPDATE purchase_events SET quantity = ?, unit_price = ?, line_total = ? WHERE id = ?').run(qty, unit, line, pa.purchase.id);
    return { ok: true };
  });

  // History is permanent: purchased lines can be corrected but never deleted (only receipt photos can be removed).

  // ---------- restore a past trip into a list ----------
  app.post('/api/trips/:id/restore', pre, async (req, reply) => {
    const ta = tripAccess(req.user, Number(req.params.id));
    if (!ta) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const targetId = Number(b.listId) || ta.trip.list_id;
    const target = targetId && listAccess(req.user, targetId);
    if (!target || target.list.household_id !== ta.trip.household_id) return bad(reply, 'forbidden', 403);
    let lines = db.prepare('SELECT * FROM purchase_events WHERE trip_id = ?').all(ta.trip.id);
    if (Array.isArray(b.purchaseIds)) { const want = new Set(b.purchaseIds.map(Number)); lines = lines.filter((l) => want.has(l.id)); }
    if (!lines.length) return bad(reply, 'nothing_selected');
    let added = 0, merged = 0;
    db.transaction(() => {
      for (const l of lines) {
        const item = db.prepare('SELECT * FROM items WHERE id = ?').get(l.item_id);
        if (!item) continue;
        const r = addToList(db, { listId: target.list.id, item, quantity: l.quantity, userId: req.user.id });
        r.merged ? merged++ : added++;
      }
      audit(db, req.user.id, 'trip.restored', String(ta.trip.id), { to: target.list.id, count: lines.length });
    })();
    return { added, merged, listId: target.list.id };
  });

  // ---------- receipt photos ----------
  app.post('/api/trips/:id/receipts', { ...pre, bodyLimit: 12 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ta = tripAccess(req.user, Number(req.params.id));
    if (!ta) return bad(reply, 'not_found', 404);
    const buf = req.body;
    const kind = Buffer.isBuffer(buf) ? sniff(buf) : null; // trust the bytes, not the header
    if (!kind) return bad(reply, 'invalid_image');
    if (db.prepare('SELECT COUNT(*) c FROM receipts WHERE trip_id = ?').get(ta.trip.id).c >= 10) return bad(reply, 'too_many_receipts');
    const rel = `${ta.trip.household_id}/${crypto.randomUUID()}.${kind.ext}`;
    fs.mkdirSync(path.join(app.dataDir, 'receipts', String(ta.trip.household_id)), { recursive: true });
    fs.writeFileSync(path.join(app.dataDir, 'receipts', rel), buf);
    const id = Number(db.prepare('INSERT INTO receipts(trip_id, household_id, file, mime, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?)')
      .run(ta.trip.id, ta.trip.household_id, rel, kind.mime, req.user.id, Date.now()).lastInsertRowid);
    if (getSetting(db, 'ocr_enabled')) app.ocr.enqueue(id, req.user.id);
    return { id, ocrStatus: getSetting(db, 'ocr_enabled') ? 'pending' : 'none' };
  });

  app.get('/api/receipts/:id/image', pre, async (req, reply) => {
    const ra = receiptAccess(req.user, Number(req.params.id));
    if (!ra) return bad(reply, 'not_found', 404);
    const file = path.join(app.dataDir, 'receipts', ra.receipt.file);
    if (!fs.existsSync(file)) return bad(reply, 'not_found', 404);
    return reply.header('Cache-Control', 'private, max-age=3600').type(ra.receipt.mime).send(fs.createReadStream(file));
  });

  app.delete('/api/receipts/:id', pre, async (req, reply) => {
    const ra = receiptAccess(req.user, Number(req.params.id));
    if (!ra) return bad(reply, 'not_found', 404);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(ra.receipt.id);
    fs.rmSync(path.join(app.dataDir, 'receipts', ra.receipt.file), { force: true });
    return { ok: true };
  });

  app.post('/api/receipts/:id/scan', pre, async (req, reply) => {
    const ra = receiptAccess(req.user, Number(req.params.id));
    if (!ra) return bad(reply, 'not_found', 404);
    if (!getSetting(db, 'ocr_enabled')) return bad(reply, 'ocr_disabled', 403);
    const engine = ['local', 'cloud'].includes((req.body || {}).engine) ? req.body.engine : undefined;
    app.ocr.enqueue(ra.receipt.id, req.user.id, engine);
    return { ocrStatus: 'pending' };
  });

  // The OCR result, with each line matched against what was bought on this trip, then against the item bank.
  app.get('/api/receipts/:id', pre, async (req, reply) => {
    const ra = receiptAccess(req.user, Number(req.params.id));
    if (!ra) return bad(reply, 'not_found', 404);
    const r = ra.receipt;
    const out = { id: r.id, tripId: r.trip_id, ocrStatus: r.ocr_status, ocrEngine: r.ocr_engine, ocrError: r.ocr_error, result: null };
    if (r.ocr_status === 'done' && r.ocr_result) {
      const res = JSON.parse(r.ocr_result);
      const tripLines = db.prepare('SELECT p.id, p.item_id, i.name FROM purchase_events p JOIN items i ON i.id = p.item_id WHERE p.trip_id = ?').all(r.trip_id)
        .map((l) => ({ ...l, name_norm: normalize(l.name) }));
      const bank = db.prepare('SELECT id, name, name_norm FROM items WHERE household_id = ? AND archived = 0').all(r.household_id);
      const claimed = new Set();
      const lines = (res.lines || []).map((l) => {
        const variants = isHebrew(l.name) ? [l.name, reverseHebrewRuns(l.name)] : [l.name];
        for (const v of variants) {
          const tl = findReceiptMatch(v, tripLines.filter((x) => !claimed.has(x.id)));
          if (tl) { claimed.add(tl.id); return { ...l, name: v, match: { purchaseId: tl.id, itemId: tl.item_id, name: tl.name } }; }
          const b = findReceiptMatch(v, bank);
          if (b) return { ...l, name: v, match: { itemId: b.id, name: b.name } };
        }
        return { ...l, match: null };
      });
      out.result = { engine: res.engine, provider: res.provider ?? null, store: res.store ?? null, date: res.date ?? null, currency: res.currency ?? null, total: res.total ?? null, lines, text: req.query.raw ? res.text ?? null : undefined };
    }
    return out;
  });

  // Save the reviewed receipt: update prices of matched lines, add lines that were not on the list, set the total.
  app.post('/api/receipts/:id/apply', pre, async (req, reply) => {
    const ra = receiptAccess(req.user, Number(req.params.id));
    if (!ra) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (lines.length > 300) return bad(reply, 'invalid_value');
    const trip = ra.trip;
    let total = trip.total;
    if (b.total !== undefined) { total = money(b.total); if (Number.isNaN(total)) return bad(reply, 'invalid_total'); }
    let applied = 0;
    try {
      db.transaction(() => {
        for (const l of lines) {
          if (l.include === false) continue;
          const qty = Number(l.quantity) > 0 && Number(l.quantity) < 10000 ? Number(l.quantity) : 1;
          const line = money(l.lineTotal);
          if (Number.isNaN(line)) throw Object.assign(new Error('invalid_price'), { code: 'invalid_price' });
          const unit = line === null ? null : round2(line / qty);
          let itemId = null;
          if (l.purchaseId) {
            const p = db.prepare('SELECT * FROM purchase_events WHERE id = ? AND trip_id = ?').get(Number(l.purchaseId), trip.id);
            if (p) {
              db.prepare('UPDATE purchase_events SET quantity = ?, unit_price = ?, line_total = ? WHERE id = ?').run(qty, unit, line, p.id);
              itemId = p.item_id; applied++;
            }
          }
          if (!itemId) {
            let item = l.itemId ? db.prepare('SELECT * FROM items WHERE id = ? AND household_id = ?').get(Number(l.itemId), trip.household_id) : null;
            if (!item) {
              const name = cleanName(l.name).slice(0, 100), norm = normalize(name);
              if (!norm) continue;
              item = db.prepare('SELECT * FROM items WHERE household_id = ? AND name_norm = ?').get(trip.household_id, norm);
              if (!item) {
                const id = Number(db.prepare('INSERT INTO items(household_id, name, name_norm, language, created_at) VALUES (?,?,?,?,?)')
                  .run(trip.household_id, name, norm, isHebrew(name) ? 'he' : 'en', Date.now()).lastInsertRowid);
                item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
              }
            }
            if (item.archived) db.prepare('UPDATE items SET archived = 0 WHERE id = ?').run(item.id);
            db.prepare(`INSERT INTO purchase_events(household_id, item_id, trip_id, list_id, quantity, unit, store_id, buyer_id, purchased_at, unit_price, line_total)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(trip.household_id, item.id, trip.id, trip.list_id, qty, null, trip.store_id, ra.receipt.uploaded_by ?? req.user.id, trip.finished_at, unit, line);
            itemId = item.id; applied++;
          }
          if (unit !== null) db.prepare('UPDATE items SET price = ? WHERE id = ?').run(unit, itemId); // "last paid"
        }
        db.prepare('UPDATE trips SET total = ? WHERE id = ?').run(total, trip.id);
        audit(db, req.user.id, 'receipt.applied', String(ra.receipt.id), { lines: applied });
      })();
    } catch (e) {
      if (e.code === 'invalid_price') return bad(reply, 'invalid_price');
      throw e;
    }
    return { applied };
  });

  // ---------- CSV export of purchase history (respects private lists) ----------
  app.get('/api/households/:hid/purchases.csv', pre, async (req, reply) => {
    const hid = Number(req.params.hid);
    if (!householdRole(req.user.id, hid)) return bad(reply, 'forbidden', 403);
    const day = (s, plus = 0) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3] + plus) : null; };
    const from = day(req.query.from) ?? 0, to = day(req.query.to, 1) ?? 8.64e15;
    const listId = Number(req.query.listId) || null;
    const he = (req.query.lang || req.user.language) === 'he';
    const rows = db.prepare(`SELECT p.purchased_at, h.name AS household, l.name AS list, s.name AS store, i.name AS item, c.name_en, c.name_he,
        p.quantity, p.unit_price, p.line_total, t.currency, u.name AS buyer, p.trip_id, t.total AS trip_total
      FROM purchase_events p JOIN items i ON i.id = p.item_id JOIN households h ON h.id = p.household_id
      LEFT JOIN lists l ON l.id = p.list_id LEFT JOIN stores s ON s.id = p.store_id LEFT JOIN categories c ON c.id = i.category_id
      LEFT JOIN users u ON u.id = p.buyer_id LEFT JOIN trips t ON t.id = p.trip_id
      WHERE p.household_id = ? AND p.purchased_at >= ? AND p.purchased_at < ?
        AND (p.list_id IS NULL OR l.visibility = 'household' OR p.list_id IN (SELECT list_id FROM list_members WHERE user_id = ?))
        AND (? IS NULL OR p.list_id = ?)
      ORDER BY p.purchased_at, p.id`).all(hid, from, to, req.user.id, listId, listId);
    const seen = new Set();
    const out = [['purchased_at', 'household', 'list', 'store', 'item', 'category', 'quantity', 'unit_price', 'line_total', 'currency', 'buyer', 'trip_id', 'receipt_total']];
    for (const r of rows) {
      const first = r.trip_id && !seen.has(r.trip_id); if (r.trip_id) seen.add(r.trip_id); // receipt total once per trip so sums do not double count
      out.push([new Date(r.purchased_at).toISOString(), r.household, r.list, r.store, r.item, he ? r.name_he : r.name_en, r.quantity, r.unit_price, r.line_total, r.currency, r.buyer, r.trip_id, first ? r.trip_total : null]);
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="purchases-${new Date().toISOString().slice(0, 10)}.csv"`).send(toCsv(out));
  });

  // ---------- my OCR settings (cloud API key is stored encrypted, never returned) ----------
  app.put('/api/me/ocr', pre, async (req, reply) => {
    const b = req.body || {};
    const cur = db.prepare('SELECT * FROM user_ocr WHERE user_id = ?').get(req.user.id);
    const engine = b.engine ?? cur?.engine ?? 'auto';
    if (!['auto', 'local', 'cloud'].includes(engine)) return bad(reply, 'invalid_value');
    const provider = b.provider ?? cur?.provider ?? 'anthropic';
    if (!PROVIDERS[provider]) return bad(reply, 'invalid_value');
    const model = String(b.model ?? cur?.model ?? '').trim().slice(0, 80);
    let keyEnc = cur?.api_key_enc ?? null;
    if (b.apiKey !== undefined) {
      const k = String(b.apiKey).trim();
      if (k.length > 400) return bad(reply, 'invalid_value');
      keyEnc = k ? app.secrets.encrypt(k) : null;
    }
    db.prepare(`INSERT INTO user_ocr(user_id, engine, provider, model, api_key_enc) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET engine = excluded.engine, provider = excluded.provider, model = excluded.model, api_key_enc = excluded.api_key_enc`)
      .run(req.user.id, engine, provider, model || null, keyEnc);
    return { user: userPayload(db, db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) };
  });
}
