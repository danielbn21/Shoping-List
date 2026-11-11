import { decodeXmlBytes } from './portals/decode.js';
import { headerOf, iterItems } from './portals/xml.js';
import { normalizeUnit, tidyUnit } from './portals/units.js';
import { stampOf } from './portals/clients.js';
import { norm, packOf } from './matching.js';

const HOUR = 3_600_000, DAY = 86_400_000;
const DEPOSIT = /פיקדון|בקבוק חוזר/;
const coded = (code, message) => Object.assign(new Error(message || code), { code });

// 20261107030000 -> a time (the file name's date and time are the freshness; treated as UTC, which is close enough for "prices from 7 Nov")
export const stampToMs = (stamp) => { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

// One PriceFull file -> { header, items }. Rows without a usable price or name, and deposit lines (פיקדון), are left out.
export function parsePriceXml(xml) {
  const header = headerOf(xml);
  const items = [];
  for (const it of iterItems(xml)) {
    const code = (it.itemcode || '').trim(), name = (it.itemname || '').trim(), price = Number(it.itemprice);
    if (!code || !name || !(price > 0) || DEPOSIT.test(name)) continue;
    const unit = normalizeUnit(tidyUnit(it.unitofmeasure));
    const pack = packOf(it.quantity, it.unitqty);
    const unitPrice = Number(it.unitofmeasureprice);
    items.push({
      code, itemType: it.itemtype === '0' ? 0 : 1, name, manufacturer: (it.manufacturename || it.manufacturername || '').replace(/^לא ידוע$/, ''),
      price, unitPrice: unitPrice > 0 ? unitPrice : null, unit: unit && unit.unit !== 'unspecified' ? unit.unit : '', unitPer: unit && unit.unit !== 'unspecified' ? unit.per : 0,
      packAmount: pack?.amount ?? null, packUnit: pack?.unit ?? null, weighted: it.bisweighted === '1' ? 1 : 0, priceUpdated: it.priceupdatetime || null,
    });
  }
  return { header, items };
}

export function createPrices({ db, portals, chains, now = Date.now, delayMs = 400, refreshHours = () => 24, log }) {
  const getState = db.prepare('SELECT * FROM branch_price_state WHERE chain = ? AND store_id = ?');
  const put = db.prepare(`INSERT INTO branch_prices(chain, store_id, code, item_type, name, name_norm, manufacturer, price, unit_price, unit, unit_per, pack_amount, pack_unit, weighted, price_updated, seen_file)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chain, store_id, code) DO UPDATE SET item_type = excluded.item_type, name = excluded.name, name_norm = excluded.name_norm, manufacturer = excluded.manufacturer,
      price = excluded.price, unit_price = excluded.unit_price, unit = excluded.unit, unit_per = excluded.unit_per, pack_amount = excluded.pack_amount, pack_unit = excluded.pack_unit,
      weighted = excluded.weighted, price_updated = excluded.price_updated, seen_file = excluded.seen_file`);

  // Merge, never replace: an item that is not in the new file keeps its price (and its old "seen" stamp, which is how an old price is recognised).
  function ingest(chainId, storeId, file, stamp, items) {
    db.transaction(() => {
      for (const i of items) put.run(chainId, storeId, i.code, i.itemType, i.name, norm(i.name), i.manufacturer, i.price, i.unitPrice, i.unit, i.unitPer, i.packAmount, i.packUnit, i.weighted, i.priceUpdated, stamp);
      db.prepare(`INSERT INTO branch_price_state(chain, store_id, file, file_stamp, items, checked_at, updated_at, error, error_at) VALUES (?,?,?,?,?,?,?,NULL,NULL)
        ON CONFLICT(chain, store_id) DO UPDATE SET file = excluded.file, file_stamp = excluded.file_stamp, items = excluded.items, checked_at = excluded.checked_at, updated_at = excluded.updated_at, error = NULL, error_at = NULL`)
        .run(chainId, storeId, file, stamp, items.length, now(), now());
    })();
  }
  const markChecked = (chainId, storeId) => db.prepare('UPDATE branch_price_state SET checked_at = ?, error = NULL, error_at = NULL WHERE chain = ? AND store_id = ?').run(now(), chainId, storeId);
  const markError = (chainId, storeId, e) => {
    try {
      db.prepare(`INSERT INTO branch_price_state(chain, store_id, error, error_at) VALUES (?,?,?,?)
        ON CONFLICT(chain, store_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`).run(chainId, storeId, String(e?.code || e?.message || e).slice(0, 300), now());
    } catch { /* database closed during a restart */ }
  };

  async function refreshOne(access, chain, storeId) {
    try {
      const list = await access.priceFullList(storeId);
      const newest = list[0];
      if (!newest) throw coded('no_pricefull', 'no PriceFull file is published for this branch (closed today?)');
      const stamp = stampOf(newest.name);
      const st = getState.get(chain.id, storeId);
      if (st?.file_stamp && stamp && st.file_stamp >= stamp) { markChecked(chain.id, storeId); return { ok: true, skipped: 'same_file', file: st.file }; }
      const f = await access.priceFull(storeId, list);
      const parsed = parsePriceXml(decodeXmlBytes(f.bytes));
      if (!parsed.items.length) throw coded('empty_file', 'the PriceFull file has no usable items');
      // A truncated download must not be taken for the branch's whole catalogue.
      if (st?.items > 200 && parsed.items.length < st.items * 0.5) throw coded('incomplete_file', `the file has ${parsed.items.length} items, the last one had ${st.items}`);
      ingest(chain.id, storeId, f.name, stamp || stampOf(f.name), parsed.items);
      return { ok: true, items: parsed.items.length, file: f.name };
    } catch (e) {
      markError(chain.id, storeId, e);
      return { ok: false, error: String(e?.code || e?.message || e) };
    }
  }

  /* ---------- the refresh job ---------- */
  let job = null;
  const status = () => job && { running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, done: job.done, total: job.total, current: job.current, results: job.results };

  const interval = () => Math.max(1, Number(refreshHours()) || 24) * HOUR;
  const due = (chainId, storeId) => {
    const st = getState.get(chainId, storeId);
    if (st?.error_at && now() - st.error_at < HOUR && (!st.checked_at || st.error_at > st.checked_at)) return false; // a failed branch is retried at most hourly
    return !st?.checked_at || now() - st.checked_at > interval();
  };
  // A forced refresh still waits a few minutes between attempts for the same branch: the portals are public and shared.
  const recentlyChecked = (chainId, storeId) => { const st = getState.get(chainId, storeId); return !!st?.checked_at && now() - st.checked_at < 10 * 60_000; };

  function start(branches, { force = false } = {}) {
    if (job?.running) return { started: false, reason: 'running', job: status() };
    const seen = new Set();
    const todo = branches.filter((b) => b.storeId && chains.usable(b.chain)).filter((b) => { const k = `${b.chain}|${b.storeId}`; if (seen.has(k)) return false; seen.add(k); return force ? !recentlyChecked(b.chain, b.storeId) : due(b.chain, b.storeId); });
    if (!todo.length) return { started: false, reason: force ? 'recent' : 'fresh', job: status() };
    job = { running: true, startedAt: now(), done: 0, total: todo.length, current: null, results: [] };
    const me = job;
    (async () => {
      try {
        const byChain = new Map();
        for (const b of todo) { if (!byChain.has(b.chain)) byChain.set(b.chain, []); byChain.get(b.chain).push(b.storeId); }
        for (const [chainId, stores] of byChain) {
          const chain = chains.get(chainId);
          let access = null, openError = null;
          try { access = portals.open(chain); } catch (e) { openError = e; }
          for (const storeId of stores) {
            me.current = { chain: chainId, storeId };
            const r = openError ? (markError(chainId, storeId, openError), { ok: false, error: String(openError.message || openError) }) : await refreshOne(access, chain, storeId);
            me.results.push({ chain: chainId, storeId, ...r });
            me.done++;
            if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
          }
        }
        prune();
      } catch (e) { log?.error?.({ err: e }, 'price refresh failed'); }
      finally { me.running = false; me.current = null; me.finishedAt = now(); }
    })();
    return { started: true, job: status() };
  }

  // Prices of branches no list compares any more are dropped (they are public data and come back when a branch is selected again).
  function prune() {
    try {
      db.prepare('DELETE FROM branch_prices WHERE NOT EXISTS (SELECT 1 FROM list_compare_stores s WHERE s.chain = branch_prices.chain AND s.branch_id = branch_prices.store_id)').run();
      db.prepare('DELETE FROM branch_price_state WHERE NOT EXISTS (SELECT 1 FROM list_compare_stores s WHERE s.chain = branch_price_state.chain AND s.branch_id = branch_price_state.store_id)').run();
    } catch { /* closed */ }
  }

  /* ---------- reading ---------- */
  const priceStmt = db.prepare('SELECT * FROM branch_prices WHERE chain = ? AND store_id = ? AND code = ?');
  const priceAt = (chain, storeId, code) => priceStmt.get(chain, String(storeId), String(code));
  // Distinct products (by code) over several branches of one chain whose normalised name contains any of the stems.
  function candidateRows(chain, storeIds, stems, limit = 3000) {
    if (!storeIds.length || !stems.length) return [];
    const like = stems.map(() => 'name_norm LIKE ?').join(' OR ');
    return db.prepare(`SELECT * FROM branch_prices WHERE chain = ? AND store_id IN (${storeIds.map(() => '?').join(',')}) AND (${like}) GROUP BY code LIMIT ?`)
      .all(chain, ...storeIds.map(String), ...stems.map((s) => `%${s}%`), limit);
  }
  const stateOf = (chain, storeId) => getState.get(chain, String(storeId));
  // The product with exactly this (normalised) name at a branch, when there is exactly one: the same product under another code.
  const nameStmt = db.prepare('SELECT * FROM branch_prices WHERE chain = ? AND store_id = ? AND name_norm = ? LIMIT 2');
  const rowByName = (chain, storeId, nameNorm) => { const r = nameStmt.all(chain, String(storeId), nameNorm); return r.length === 1 ? r[0] : null; };

  return { refreshOne, start, status, due, stateOf, priceAt, rowByName, candidateRows, prune, interval };
}

export const productOf = (r) => r && ({
  code: r.code, itemType: r.item_type, name: r.name, manufacturer: r.manufacturer, price: r.price, unitPrice: r.unit_price, unit: r.unit, unitPer: r.unit_per,
  weighted: !!r.weighted, pack: r.pack_amount ? { amount: r.pack_amount, unit: r.pack_unit } : null, seenFile: r.seen_file, priceUpdated: r.price_updated,
});
export const DEFAULT_OLD_AFTER_DAYS = 60;
export const OLD_AFTER_MS = DEFAULT_OLD_AFTER_DAYS * DAY;
