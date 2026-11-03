import { audit, cleanName } from '../util.js';
import { makeAccess } from '../access.js';
import { addToList } from '../entries.js';
import { normalize, findMatches, isHebrew } from '../match.js';
import { parseCsv, toCsv, unprotect } from '../csv.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default async function itemsCsvRoutes(app) {
  const db = app.db;
  const pre = { preHandler: app.auth() };
  const { listAccess, canEdit } = makeAccess(db);

  // ---- export the item bank (a backup, or a way to carry items to another list or household) ----
  app.get('/api/lists/:id/items.csv', pre, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const hid = acc.list.household_id;
    const he = (req.query.lang || req.user.language) === 'he';
    const onList = new Map(db.prepare("SELECT item_id, quantity FROM list_entries WHERE list_id = ? AND deleted = 0 AND state = 'open'").all(acc.list.id).map((r) => [r.item_id, r.quantity]));
    const rows = db.prepare(`SELECT i.id, i.name, i.default_note, i.price, c.name_en, c.name_he,
        (SELECT COUNT(*) FROM purchase_events p WHERE p.item_id = i.id) AS n, (SELECT MAX(purchased_at) FROM purchase_events p WHERE p.item_id = i.id) AS last
      FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE i.household_id = ? AND i.archived = 0 ORDER BY i.name`).all(hid);
    const out = [['name', 'category', 'default_note', 'price', 'quantity', 'times_purchased', 'last_purchased']];
    for (const r of rows) out.push([r.name, he ? r.name_he : r.name_en, r.default_note, r.price, onList.get(r.id) ?? 0, r.n, r.last ? new Date(r.last).toISOString().slice(0, 10) : null]);
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="items-${new Date().toISOString().slice(0, 10)}.csv"`).send(toCsv(out));
  });

  // ---- import: preview first (apply=false), then apply ----
  app.post('/api/lists/:id/items/import', { ...pre, bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const acc = listAccess(req.user, Number(req.params.id));
    if (!acc) return bad(reply, 'not_found', 404);
    if (!canEdit(acc)) return bad(reply, 'forbidden', 403);
    const b = req.body || {};
    const hid = acc.list.household_id;
    const table = parseCsv(String(b.csv ?? ''));
    if (table.length < 2) return bad(reply, 'csv_empty');
    if (table.length > 5001) return bad(reply, 'csv_too_large');
    const head = table[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const ci = { name: col('name', 'item', 'שם', 'פריט'), category: col('category', 'קטגוריה'), note: col('default_note', 'note', 'הערה'), price: col('price', 'מחיר'), qty: col('quantity', 'qty', 'כמות') };
    if (ci.name < 0) return bad(reply, 'csv_no_name_column');
    const overwrite = !!b.overwrite, mergeSimilar = !!b.mergeSimilar, createCategories = b.createCategories !== false, apply = !!b.apply;

    const bank = db.prepare('SELECT * FROM items WHERE household_id = ?').all(hid);
    const cats = db.prepare('SELECT * FROM categories WHERE household_id = ?').all(hid);
    const catByName = new Map();
    for (const c of cats) { catByName.set(c.name_en.trim().toLowerCase(), c); catByName.set(c.name_he.trim().toLowerCase(), c); }
    const cell = (r, i) => (i >= 0 && r[i] !== undefined ? unprotect(r[i].trim()) : '');
    const planned = new Map(); // normalised name -> row index, so a name repeated in the file is one item
    const rows = [];

    table.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const name = cleanName(cell(r, ci.name)).slice(0, 100);
      const row = { line, name, category: cell(r, ci.category), note: cell(r, ci.note).slice(0, 200), price: null, quantity: 0, action: 'skip', matchedName: null, newCategory: false, warnings: [] };
      rows.push(row);
      if (!name) { row.warnings.push('no_name'); return; }
      const rawPrice = cell(r, ci.price).replace(',', '.');
      if (rawPrice) { const p = Number(rawPrice); if (Number.isFinite(p) && p >= 0 && p < 1e7) row.price = p; else row.warnings.push('bad_price'); }
      const rawQty = cell(r, ci.qty).replace(',', '.');
      if (rawQty) { const q = Number(rawQty); if (Number.isFinite(q) && q >= 0 && q < 10000) row.quantity = q; else row.warnings.push('bad_quantity'); }
      row.norm = normalize(name);
      if (!row.norm) { row.warnings.push('no_name'); return; }
      if (planned.has(row.norm)) { row.action = 'duplicate_in_file'; row.dupOf = planned.get(row.norm); return; }
      let item = bank.find((i) => i.name_norm === row.norm);
      if (!item) {
        const near = findMatches(name, bank.filter((i) => !i.archived), { strictness: 'normal' })[0];
        if (near) { row.similarTo = near.item.name; if (mergeSimilar) item = near.item; }
      }
      if (item) { row.action = 'update'; row.item = item; row.matchedName = item.name; } else row.action = 'create';
      if (row.category) {
        const c = catByName.get(row.category.trim().toLowerCase());
        if (c) row.cat = c; else row.newCategory = true;
      }
      planned.set(row.norm, rows.length - 1);
    });

    const count = (a) => rows.filter((r) => r.action === a).length;
    const summary = {
      create: count('create'), update: count('update'), skip: count('skip'), duplicateInFile: count('duplicate_in_file'),
      similar: rows.filter((r) => r.similarTo && r.action === 'create').length,
      addToList: rows.filter((r) => ['create', 'update'].includes(r.action) && r.quantity > 0).length,
      newCategories: [...new Set(rows.filter((r) => r.newCategory).map((r) => r.category.trim()))].length,
    };

    if (apply) {
      db.transaction(() => {
        const newCats = new Map();
        const catFor = (row) => {
          if (row.cat) return row.cat.id;
          if (!row.newCategory || !createCategories) return null;
          const key = row.category.trim().toLowerCase();
          if (!newCats.has(key)) {
            const next = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM categories WHERE household_id = ?').get(hid).n;
            newCats.set(key, Number(db.prepare('INSERT INTO categories(household_id, name_en, name_he, sort) VALUES (?,?,?,?)').run(hid, row.category.trim().slice(0, 60), row.category.trim().slice(0, 60), next).lastInsertRowid));
          }
          return newCats.get(key);
        };
        for (const row of rows) {
          if (!['create', 'update'].includes(row.action)) continue;
          const catId = catFor(row);
          let item = row.item;
          if (row.action === 'create') {
            const id = Number(db.prepare('INSERT INTO items(household_id, name, name_norm, language, category_id, default_note, price, created_at) VALUES (?,?,?,?,?,?,?,?)')
              .run(hid, row.name, row.norm, isHebrew(row.name) ? 'he' : 'en', catId, row.note || null, row.price, Date.now()).lastInsertRowid);
            item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
            bank.push(item);
          } else {
            // existing items keep what they have unless "overwrite" is on; empty fields are always filled in
            const sets = [], vals = [];
            if (catId && (overwrite || !item.category_id)) { sets.push('category_id = ?'); vals.push(catId); }
            if (row.note && (overwrite || !item.default_note)) { sets.push('default_note = ?'); vals.push(row.note); }
            if (row.price !== null && (overwrite || item.price === null)) { sets.push('price = ?'); vals.push(row.price); }
            if (item.archived) sets.push('archived = 0');
            if (sets.length) db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, item.id);
            item = db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
          }
          if (row.quantity > 0) addToList(db, { listId: acc.list.id, item, quantity: row.quantity, userId: req.user.id });
        }
        audit(db, req.user.id, 'items.imported', String(acc.list.id), summary);
      })();
    }

    return {
      applied: apply, summary,
      rows: rows.slice(0, 300).map((r) => ({ line: r.line, name: r.name, action: r.action, matchedName: r.matchedName, similarTo: r.similarTo ?? null, category: r.category, newCategory: r.newCategory, price: r.price, quantity: r.quantity, warnings: r.warnings })),
    };
  });
}
