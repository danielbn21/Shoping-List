// Barcode scanning. The browser reads the barcode and sends the digits here; this module decides which household item it is:
//   1. a barcode the household has matched before (barcode_items), else
//   2. a name or item the user just confirmed, else
//   3. the product the price files give for it ('barcode-lookup', provided by price-compare when it is on): an existing item with a
//      similar name is offered for confirmation first, otherwise a new item is made from the product name.
// The core then adds or ticks it (ctx.core.scanItem), so the item joins the list's past items like any other way of adding one.
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
];

// 8 to 14 digits; the web app also checks the check digit, the server only the shape.
export const canon = (raw) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 14 ? d.replace(/^0+/, '') || '0' : null;
};
const clean = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, 100) : '');
const bad = (reply, error, code = 400) => reply.code(code).send({ error });
const FAIL = { not_found: 404, forbidden: 403, invalid_name: 400 };

const publicProduct = (p) => p && ({
  name: p.name, manufacturer: p.manufacturer || '', price: p.price, weighted: !!p.weighted, unit: p.unit || '', unitPrice: p.unitPrice ?? null,
  chain: { en: p.chainNameEn, he: p.chainNameHe }, branchName: p.branchName ?? null, via: p.via, priceUpdated: p.priceUpdated ?? null,
});

export default function register(ctx) {
  const { db, core } = ctx;
  const find = db.prepare('SELECT item_id FROM barcode_items WHERE household_id = ? AND code = ?');
  const remember = db.prepare(`INSERT INTO barcode_items(household_id, code, item_id, product_name, created_by, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(household_id, code) DO UPDATE SET item_id = excluded.item_id, product_name = excluded.product_name, created_by = excluded.created_by, created_at = excluded.created_at`);

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
    const r = core.scanItem({ user: req.user, listId, itemId, name, price, tick });
    if (r.error) return bad(reply, r.error, FAIL[r.error] ?? 400);
    remember.run(hid, code, r.itemId, product?.name ?? name ?? null, req.user.id, Date.now());
    ctx.audit(req.user.id, 'scan', String(listId), { itemId: r.itemId, action: r.action, via });
    return { status: 'done', action: r.action, via, item: { id: r.itemId, name: r.name }, created: r.created, quantity: r.quantity, priceSaved: r.priceSaved, product: publicProduct(product) };
  });

  ctx.events.on('item.deleted', ({ itemId, householdId }) => db.prepare('DELETE FROM barcode_items WHERE household_id = ? AND item_id = ?').run(householdId, itemId));
  ctx.events.on('household.deleted', ({ householdId }) => db.prepare('DELETE FROM barcode_items WHERE household_id = ?').run(householdId));
}
