// Barcode scanning. The browser reads the barcode and sends the digits here; this module decides which household item it is:
//   1. a barcode the household has matched before (barcode_items), else
//   2. a name or item the user just confirmed, else
//   3. the product the price files give for it ('barcode-lookup', provided by price-compare when it is on): an existing item with a
//      similar name is offered for confirmation first, otherwise a new item is made from the product name.
// The core then adds or ticks it (ctx.core.scanItem), so the item joins the list's past items like any other way of adding one.
// 1.2.0: a new item gets a category automatically (categories.js); any scan can be edited (name, category) or moved to the right item
// ('Wrong item': the barcode is re-pointed and the wrong scan taken back); a lookup mode for Add a trip; barcodes in the items CSV.
import { suggestCategory } from './categories.js';

export const migrations = [
  `
CREATE TABLE barcode_items (
  household_id INTEGER NOT NULL,
  code TEXT NOT NULL,                 -- digits without leading zeros (spellings of one barcode are one row)
  item_id INTEGER NOT NULL,
  product_name TEXT,                  -- what the product was called when it was matched (for information)
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, code)
);
CREATE INDEX idx_barcode_items_item ON barcode_items(household_id, item_id);
`,
  `ALTER TABLE barcode_items ADD COLUMN manufacturer TEXT;`,   // 1.2.0: what the manufacturer was called when the barcode was matched (for the category of the next product by the same maker)
];

// 8 to 14 digits; the web app also checks the check digit, the server only the shape.
export const canon = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 14 ? d.replace(/^0+/, '') || '0' : null;
};
const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, 100) : '');
const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const FAIL = { not_found: 404, forbidden: 403, invalid_name: 400, item_exists: 409, invalid_category: 400, invalid_action: 400 };

const publicProduct = (p) => p && ({
  name: p.name, manufacturer: p.manufacturer || '', price: p.price, weighted: !!p.weighted, unit: p.unit || '', unitPrice: p.unitPrice ?? null,
  chain: { en: p.chainNameEn, he: p.chainNameHe }, branchName: p.branchName ?? null, via: p.via, priceUpdated: p.priceUpdated ?? null,
});

export default function register(ctx) {
  const { db, core } = ctx;
  const find = db.prepare('SELECT item_id, product_name, manufacturer FROM barcode_items WHERE household_id = ? AND code = ?');
  const remember = db.prepare(`INSERT INTO barcode_items(household_id, code, item_id, product_name, manufacturer, created_by, created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(household_id, code) DO UPDATE SET item_id = excluded.item_id, product_name = COALESCE(excluded.product_name, product_name),
      manufacturer = COALESCE(excluded.manufacturer, manufacturer), created_by = excluded.created_by, created_at = excluded.created_at`);

  // The category for a product or a name: see categories.js. -> { categoryId, how } | null
  const categoryFor = (hid, name, manufacturer) => {
    if (!clean(name)) return null;
    const maker = clean(manufacturer);
    return suggestCategory({
      name, similar: core.similarItem(hid, name), categories: core.listCategories(hid), items: core.householdItems(hid, { limit: 5000 }),
      byManufacturer: maker ? db.prepare('SELECT item_id AS itemId FROM barcode_items WHERE household_id = ? AND manufacturer = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 50').all(hid, maker) : [],
    });
  };
  const rate = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  // POST { code, tick, storeId?, itemId?, name? }
  //   -> { status: 'done', action, via, item, created, quantity, priceSaved, product }
  //    | { status: 'confirm', code, product, suggestion: { id, name } }   (resend with itemId, or with name to make a new item)
  //    | { status: 'unknown', code }                                      (resend with name)
  ctx.routes.post('/lists/:id/scan', { config: { rateLimit: { max: 180, timeWindow: '1 minute' } } }, async (req, reply) => {
    const listId = Number(req.params.id);
    const acc = core.listAccess(req.user, listId);
    if (!acc) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const code = canon(b.code);
    if (!code) return bad(reply, 'invalid_code');
    const hid = acc.list.household_id, tick = !!b.tick;
    const storeId = b.storeId && core.storeAccess(req.user, Number(b.storeId)) ? Number(b.storeId) : null;

    const lookup = ctx.capability('barcode-lookup', req.user.id);
    let product = null;
    try { product = lookup?.find({ listId, storeId, code }) ?? null; } catch (e) { ctx.log.warn?.({ err: String(e) }, 'barcode lookup failed'); }

    let mapped = find.get(hid, code);
    if (mapped && !core.itemInHousehold(hid, mapped.item_id)) { db.prepare('DELETE FROM barcode_items WHERE household_id = ? AND code = ?').run(hid, code); mapped = null; }

    let itemId = null, name = null, via;
    if (b.itemId) {
      if (!core.itemInHousehold(hid, Number(b.itemId))) return bad(reply, 'not_found', 404);
      itemId = Number(b.itemId); via = 'chosen';
    } else if (mapped) { itemId = mapped.item_id; via = 'barcode'; }
    else if (clean(b.name)) { name = clean(b.name); via = 'named'; }
    else if (product) {
      const similar = core.similarItem(hid, product.name);
      if (similar) return { status: 'confirm', code, product: publicProduct(product), suggestion: { id: similar.id, name: similar.name } };
      name = product.name; via = 'product';
    } else return { status: 'unknown', code };

    // a per-kilo price is not the price of one item
    const price = product && !product.weighted ? product.price : null;
    const cat = categoryFor(hid, product?.name ?? name, product?.manufacturer);   // given to a new item, or to an existing one that has no category
    const r = core.scanItem({ user: req.user, listId, itemId, name, price, tick, categoryId: cat?.categoryId ?? null });
    if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
    remember.run(hid, code, r.itemId, product?.name ?? name ?? null, clean(product?.manufacturer) || null, req.user.id, Date.now());
    ctx.audit(req.user.id, 'scan', String(listId), { itemId: r.itemId, action: r.action, via });
    return {
      status: 'done', action: r.action, via, item: { id: r.itemId, name: r.name }, created: r.created, quantity: r.quantity, priceSaved: r.priceSaved, product: publicProduct(product),
      code, categoryId: r.categoryId, categoryHow: cat && cat.categoryId === r.categoryId ? cat.how : null,
      scan: { itemId: r.itemId, entryId: r.entryId, action: r.action, created: r.created, previousPrice: r.previousPrice, savedPrice: r.savedPrice },   // what 'Wrong item' sends back to take the scan back
    };
  });

  // POST { itemId, name } -> { ok, item: { id, name } }
  // Renames the item a barcode points to. The barcode stays attached to the item (it points at the item, not at its name), so the next
  // scan lands on the new name. Only items that have a barcode here can be renamed this way; edit rights on the list are needed.
  ctx.routes.post('/lists/:id/scan/rename', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const listId = Number(req.params.id);
    const acc = core.listAccess(req.user, listId);
    if (!acc) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const hid = acc.list.household_id;
    if (!db.prepare('SELECT 1 FROM barcode_items WHERE household_id = ? AND item_id = ?').get(hid, Number(b.itemId))) return bad(reply, 'not_found', 404);
    const r = core.renameItem({ user: req.user, listId, itemId: b.itemId, name: clean(b.name) });
    if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
    ctx.audit(req.user.id, 'scan.rename', String(listId), { itemId: r.itemId, from: r.previousName, to: r.name });
    return { ok: true, item: { id: r.itemId, name: r.name } };
  });


  // Items that have a barcode here may be edited from the scan panel; everyone who can see the list may read the lists below.
  const hasBarcode = (hid, itemId) => !!db.prepare('SELECT 1 FROM barcode_items WHERE household_id = ? AND item_id = ?').get(hid, Number(itemId));

  // POST { itemId, name?, categoryId? (a category id, or null for none) } -> { ok, item: { id, name }, categoryId }
  ctx.routes.post('/lists/:id/scan/edit', rate(60), async (req, reply) => {
    const listId = Number(req.params.id);
    const acc = core.listAccess(req.user, listId);
    if (!acc) return bad(reply, 'not_found', 404);
    const b = req.body || {};
    const hid = acc.list.household_id;
    if (!hasBarcode(hid, b.itemId)) return bad(reply, 'not_found', 404);
    let item = core.itemInHousehold(hid, b.itemId);
    if (!item) return bad(reply, 'not_found', 404);
    if (b.name !== undefined && clean(b.name) !== item.name) {
      const r = core.renameItem({ user: req.user, listId, itemId: item.id, name: clean(b.name) });
      if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
      ctx.audit(req.user.id, 'scan.rename', String(listId), { itemId: r.itemId, from: r.previousName, to: r.name });
      item = { id: r.itemId, name: r.name };
    }
    let categoryId;
    if (b.categoryId !== undefined) {
      const r = core.setItemCategory({ user: req.user, listId, itemId: item.id, categoryId: b.categoryId });
      if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
      ctx.audit(req.user.id, 'scan.category', String(listId), { itemId: item.id, from: r.previousCategoryId, to: r.categoryId });
      categoryId = r.categoryId;
    }
    return { ok: true, item, categoryId };
  });

  // GET ?q= -> { items: [{ id, name, categoryId }] }   the household's items, for choosing the right one ('Wrong item')
  ctx.routes.get('/lists/:id/scan/items', async (req, reply) => {
    const acc = core.listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    return { items: core.householdItems(acc.list.household_id, { q: String(req.query?.q ?? '').slice(0, 60), limit: 8 }) };
  });
  ctx.routes.get('/lists/:id/scan/categories', async (req, reply) => {
    const acc = core.listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    return { categories: core.listCategories(acc.list.household_id) };
  });

  // POST { code, itemId | name, undo: { itemId, entryId, action, created, previousPrice, savedPrice }, tick, storeId? }
  // 'Wrong item': the scan landed on the wrong item. The scan is taken back (un-ticked, one less, or removed; an item the scan made is removed
  // again; a price it saved is put back), the right item (an existing one, or a new one from name) gets the scan instead, and the barcode points at it from now on.
  // Without undo only the barcode is moved. -> the same as a finished scan, plus { from, reversed }
  ctx.routes.post('/lists/:id/scan/repoint', rate(60), async (req, reply) => {
    const listId = Number(req.params.id);
    const acc = core.listAccess(req.user, listId);
    if (!acc) return bad(reply, 'not_found', 404);
    if (!core.canEdit(acc)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const hid = acc.list.household_id;
    const code = canon(b.code);
    if (!code) return bad(reply, 'invalid_code');
    const nm = clean(b.name);
    if (!b.itemId && !(nm && b.undo)) return bad(reply, 'invalid_name');
    if (b.itemId && !core.itemInHousehold(hid, Number(b.itemId))) return bad(reply, 'not_found', 404);
    const row = find.get(hid, code);
    const from = row ? core.itemInHousehold(hid, row.item_id) : null;
    if (b.itemId && row && Number(b.itemId) === row.item_id) return bad(reply, 'same_item');

    let reversed = null;
    if (b.undo) {
      const u = b.undo;
      const rv = core.reverseScan({ user: req.user, listId, itemId: Number(u.itemId), entryId: Number(u.entryId), action: String(u.action), created: !!u.created,
        restorePrice: u.savedPrice !== null && u.savedPrice !== undefined ? { from: u.previousPrice ?? null, to: u.savedPrice } : null });
      if (rv.error) return bad(reply, rv.error, FAIL[rv.error] ?? 400);
      reversed = rv;
    }

    const storeId = b.storeId && core.storeAccess(req.user, Number(b.storeId)) ? Number(b.storeId) : null;
    let product = null;
    try { product = ctx.capability('barcode-lookup', req.user.id)?.find({ listId, storeId, code }) ?? null; } catch (e) { ctx.log.warn?.({ err: String(e) }, 'barcode lookup failed'); }
    let r = null, targetId = b.itemId ? Number(b.itemId) : null;
    if (b.undo) {
      const price = product && !product.weighted ? product.price : null;
      const cat = b.itemId ? categoryFor(hid, product?.name, product?.manufacturer) : categoryFor(hid, nm, product?.manufacturer);
      r = core.scanItem({ user: req.user, listId, itemId: b.itemId ? Number(b.itemId) : null, name: b.itemId ? null : nm, price, tick: !!b.tick, categoryId: cat?.categoryId ?? null });
      if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
      targetId = r.itemId;
    }
    remember.run(hid, code, targetId, row?.product_name ?? product?.name ?? null, row?.manufacturer ?? (clean(product?.manufacturer) || null), req.user.id, Date.now());
    const to = core.itemInHousehold(hid, targetId);
    ctx.audit(req.user.id, 'scan.repoint', String(listId), { code, from: from?.id ?? null, to: targetId, reversed: reversed?.result ?? null });
    return {
      status: 'done', action: r?.action ?? null, via: 'repoint', item: to, created: !!r?.created, quantity: r?.quantity ?? null, priceSaved: !!r?.priceSaved, product: publicProduct(product),
      code, categoryId: r?.categoryId ?? null, categoryHow: null,
      scan: r ? { itemId: r.itemId, entryId: r.entryId, action: r.action, created: r.created, previousPrice: r.previousPrice, savedPrice: r.savedPrice } : null,
      from, reversed,
    };
  });

  // POST { code, itemId?, name? } -> { status: 'found', code, item: { id, name } | null, name, price, categoryId, product }
  //                               | { status: 'confirm', code, product, suggestion } | { status: 'unknown', code }
  // For Add a trip: says what a barcode is and costs and changes nothing on any list (a household item chosen by the person is remembered for the barcode).
  ctx.routes.post('/lists/:id/scan/lookup', rate(180), async (req, reply) => {
    const listId = Number(req.params.id);
    const acc = core.listAccess(req.user, listId);
    if (!acc) return bad(reply, 'not_found', 404);
    if (!core.canEdit(acc)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const code = canon(b.code);
    if (!code) return bad(reply, 'invalid_code');
    const hid = acc.list.household_id;
    let product = null;
    try { product = ctx.capability('barcode-lookup', req.user.id)?.find({ listId, storeId: null, code }) ?? null; } catch (e) { ctx.log.warn?.({ err: String(e) }, 'barcode lookup failed'); }
    const price = product && !product.weighted ? product.price : null;
    const found = (item, name) => ({ status: 'found', code, item, name, price, categoryId: item ? null : (categoryFor(hid, name, product?.manufacturer)?.categoryId ?? null), product: publicProduct(product) });

    let mapped = find.get(hid, code);
    if (mapped && !core.itemInHousehold(hid, mapped.item_id)) { db.prepare('DELETE FROM barcode_items WHERE household_id = ? AND code = ?').run(hid, code); mapped = null; }
    if (b.itemId) {
      const it = core.itemInHousehold(hid, Number(b.itemId));
      if (!it) return bad(reply, 'not_found', 404);
      remember.run(hid, code, it.id, product?.name ?? null, clean(product?.manufacturer) || null, req.user.id, Date.now());
      return found(it, it.name);
    }
    if (mapped) { const it = core.itemInHousehold(hid, mapped.item_id); return found(it, it.name); }
    if (clean(b.name)) return found(null, clean(b.name));
    if (product) {
      const similar = core.similarItem(hid, product.name);
      if (similar) return { status: 'confirm', code, product: publicProduct(product), suggestion: { id: similar.id, name: similar.name } };
      return found(null, product.name);
    }
    return { status: 'unknown', code };
  });

  // 'item-csv-columns' (core 1.8.0): the items CSV gets a barcode column. A restore, or a move to another household, brings the barcode links back.
  // Several barcodes of one item go in one cell, separated by spaces. A barcode in the file always wins: it is moved to the item on its row.
  const codesOf = (v) => { const ok = [], invalid = []; for (const part of String(v ?? '').split(/[\s;,]+/).filter(Boolean)) { const c = canon(part); if (c) ok.push(c); else invalid.push(part); } return { ok: [...new Set(ok)], invalid }; };
  ctx.provide('item-csv-columns', {
    id: 'barcode-scan',
    headers: ['barcode'],
    export({ householdId, itemIds }) {
      const want = new Set((itemIds || []).map(Number)), out = {};
      for (const r of db.prepare('SELECT item_id, code FROM barcode_items WHERE household_id = ? ORDER BY created_at, code').all(Number(householdId))) {
        if (!want.has(r.item_id)) continue;
        (out[r.item_id] ??= { barcode: [] }).barcode.push(r.code);
      }
      for (const v of Object.values(out)) v.barcode = v.barcode.join(' ');
      return out;
    },
    plan({ householdId, links }) {
      const out = {};
      for (const l of links) {
        const { ok, invalid } = codesOf(l.values?.barcode);
        const relinks = [];
        for (const code of ok) {
          const ex = find.get(householdId, code);
          if (ex && (l.itemId === null || ex.item_id !== l.itemId)) relinks.push({ code, fromName: core.itemInHousehold(householdId, ex.item_id)?.name ?? null });
        }
        out[l.line] = { relinks, invalid };
      }
      return out;
    },
    apply({ user, householdId, links }) {
      let n = 0;
      for (const l of links) {
        if (!core.itemInHousehold(householdId, l.itemId)) continue;
        for (const code of codesOf(l.values?.barcode).ok) { remember.run(householdId, code, l.itemId, null, null, user.id, Date.now()); n++; }
      }
      return { applied: n };
    },
  });

  ctx.events.on('item.deleted', ({ itemId, householdId }) => db.prepare('DELETE FROM barcode_items WHERE household_id = ? AND item_id = ?').run(householdId, itemId));
  ctx.events.on('household.deleted', ({ householdId }) => db.prepare('DELETE FROM barcode_items WHERE household_id = ?').run(householdId));
}
