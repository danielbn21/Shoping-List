# Modules

Since 1.3.0 optional features live in **modules**: receipt reading (`receipt-ocr`) and price comparison with the supermarket portals (`price-compare`) are modules. A module can be developed, fixed and replaced on its own, without re-delivering the whole app.

## What a module may do

- **Add, never overwrite.** A module adds to named *slots* (see below) and may provide a *capability*. It cannot replace or edit core screens.
- **Own data.** Each module has its own SQLite file, `data/modules/<id>/data.db`, with its own schema version. It never runs SQL on the core database; it reads the core through `ctx.core` and cleans up after itself through core events.
- **Own version.** `manifest.json` has the module version and the core versions it works with. Settings shows it.
- **Per user.** The admin decides which users may use a module; each user can switch a granted module on or off for themselves (default on).

## Folder layout (source)

```
modules/<id>/
  manifest.json        required
  server/index.js      server code (plain ES module, imports only node: built-ins and its own files)
  web/index.tsx        browser code (compiled by scripts/build-modules.mjs into web.js)
  i18n.json            { "en": { key: text }, "he": { ... } }; missing keys fall back to English
  test/                tests (not shipped)
```

A shipped module (zip or bundled folder) holds `manifest.json`, `server/`, `web.js`, `i18n.json` (and `web.css` if used). Sources under `web/` and `test/` are left out.

## manifest.json

```json
{
  "id": "price-compare",
  "name": "Price comparison",
  "version": "1.0.0",
  "description": "…",
  "requires": { "core": ">=1.3.0 <2.0.0" },
  "dependsOn": [],
  "provides": ["price-source"],
  "slots": ["list.tab", "manage.section", "settings.section", "admin.section", "shop.toolbar", "manage.toolbar", "trip.toolbar"],
  "server": "server/index.js",
  "web": "web.js",
  "i18n": "i18n.json"
}
```

`kind` is `feature` (default) or `language` (see below). Ids are lowercase letters, digits and dashes.

## Server side: `server/index.js`

```js
export const migrations = [ 'CREATE TABLE …;', 'ALTER TABLE …;' ];   // run in order; the step count is the schema version

export default function register(ctx) {
  ctx.db                                   // this module's own database
  ctx.options                              // test hooks only
  ctx.settings.get(key, fallback) / .set(key, value)
  ctx.filesDir                             // a folder for this module's files
  ctx.secrets.encrypt(text) / .decrypt(text)

  ctx.routes.get('/status', async (req) => ({ … }));                       // served at /api/m/<id>/status, login required,
  ctx.routes.put('/admin/x', { access: 'admin' }, async (req) => ({ … })); // and only while the module is on for that user

  ctx.provide('receipt-reader', { read: async ({ file, mime, userId, engine }) => ({ … }) });   // must be listed in "provides"
  ctx.events.on('list.deleted', ({ listId }) => { … });   // list.deleted, item.deleted, item.renamed (1.7.1: { itemId, householdId }), store.deleted, household.deleted, user.deleted
  ctx.core.listAccess(user, listId); ctx.core.listOpenEntries(listId); ctx.core.householdStores(hid);
  ctx.core.storeAccess(user, storeId); ctx.core.similarItem(householdId, name); ctx.core.itemInHousehold(householdId, itemId); ctx.core.lastPaid({ itemId, storeIds, userId }); ctx.audit(userId, action, target, detail);
  ctx.core.listPastItems(listId);                                    // since 1.7.0: [{ itemId, name }] the list's past items, newest first
  ctx.core.scanItem({ user, listId, itemId, name, price, tick });   // since 1.6.0, the one write: puts an item on the list or ticks it (see below)
  ctx.core.renameItem({ user, listId, itemId, name });             // since 1.7.0: renames a household item ({ itemId, name, previousName } or { error }); Owner/Editor, name unique in the household
  ctx.core.listCategories(householdId); ctx.core.householdItems(householdId, { q, limit }); ctx.core.setItemCategory({ user, listId, itemId, categoryId });   // since 1.8.0
  ctx.core.reverseScan({ user, listId, itemId, entryId, action, created, restorePrice });                                   // since 1.8.0: takes back a scanItem (see below)
  ctx.capability('barcode-lookup', userId);                          // since 1.6.0: another module's capability for this user, or null
}
```

Rules enforced when a module is installed: only `node:` built-ins and relative imports; no path escapes in the zip; size and file-count limits; a valid manifest; a core version it supports.

### The scan API (since 1.6.0)

`ctx.core.scanItem({ user, listId, itemId?, name?, price?, tick })` is the only way a module changes a list. It goes through the same code as every other way of adding an item (so the item joins the list's past items): give an `itemId` of the list's household, or a `name` (an exact normalised name reuses the household item, otherwise a new item is created). `price`, when given, becomes the item's saved price. With `tick: true` (shopping) an open entry is ticked, an entry already in the cart gets quantity + 1, and an item that is not on the list is added already ticked; with `tick: false` the item is added (or merged into the open entry). Ticking needs any role that can see the list, adding or creating needs Owner or Editor. Returns `{ itemId, name, entryId, action, created, quantity, priceSaved, previousPrice, savedPrice, categoryId }` or `{ error: 'not_found' | 'forbidden' | 'invalid_name' }`. Since 1.8.0 `categoryId` (a category of the household) is given to an item the scan created or to an existing one that has none; a category an item has is never replaced by a scan.

`ctx.core.reverseScan({ user, listId, itemId, entryId, action, created, restorePrice: { from, to } })` takes a scan back using what `scanItem` returned (`action`: `ticked` is un-ticked, `more` and `merged` lose one, `added` and `added_ticked` are removed; an item the scan created and nothing else uses is deleted again and `item.deleted` is emitted; `restorePrice` puts the old saved price back unless it was changed since). It only acts while the entry is still as the scan left it: otherwise `{ reversed: false, reason: 'changed' }`. Returns `{ reversed: true, result, itemRemoved }`.

### Capabilities defined by the core

| Capability | Interface | Used by |
| --- | --- | --- |
| `receipt-reader` | `read({ file, mime, userId, engine }) → { engine, lines, total, … }` (never saves anything) | the receipt queue in `server/src/receipts.js` |
| `item-catalog` | `search({ user, listId, householdId, q, limit }) → [{ name, note?, categoryId?, price?, priceMax?, currency?, perKg?, chains?, ref? }]` and optional `afterAdd({ user, listId, householdId, itemId, ref })` (called after an item picked from a suggestion is added; failures are ignored) | Add items in Manage list (`GET /api/lists/:id/catalog?q=`, Editors and Owners; `catalogRef` in `POST /api/lists/:id/entries`) |
| `item-csv-columns` | `headers: ['barcode']`, `export({ householdId, itemIds }) → { [itemId]: { barcode } }`, `plan({ householdId, links: [{ line, itemId \| null, name, values }] }) → { [line]: { relinks, invalid } }` (preview, writes nothing), `apply({ user, householdId, links: [{ itemId, values }] })`: extra columns of the items CSV (since core 1.8.0); provided by `barcode-scan` (a barcode in the file always wins over an existing link) | `server/src/routes/itemsCsv.js` |
| `barcode-lookup` | `find({ listId, storeId, code }) → { code, name, manufacturer, price, weighted, chain, chainNameEn, chainNameHe, branchId, branchName, via: 'store'\|'list'\|'any', … } \| null`: what a barcode is and costs in the branches the module reads; provided by `price-compare` (since 1.4.0) | `barcode-scan` |
| `price-source` | `chains()` and `priceAt(chain, storeId, code)`; provided by `price-compare` (it reads the portals itself) | `price-compare` |

## Browser side: `web/index.tsx`

```tsx
import type { Host } from '../../../web/src/host';
export default function register(host: Host) {
  // host.createPortal(node, document.body) (since 1.7.0): draw a dialog outside the core's forms and scroll boxes. Events still bubble through a portal in React, so stop `submit` at the dialog's root.
  host.slots.add('settings.section', { id: 'x', title: () => host.t('xTitle'), order: 20, collapsible: true, component: MyPanel });
}
```

Slots: `shop.toolbar` (a small control next to the search box in Shop; props `{ data, me, reload, storeId }`, `storeId` being the store chosen in Shop or `""`) and `manage.toolbar` (in the row of the Add button in Manage list; same props), `trip.toolbar` (since 1.8.0, in Add a trip next to Add item; props `{ data, me, addRows }`, `addRows([{ name, qty?, price?, itemId?, categoryId? }])` fills the form's empty rows first and adds more; nothing is saved until the person saves the trip), `list.tab` (props `{ data, me, reload }`; a tab of the list: the bar at the bottom edge on a phone, with a generic icon and the `title()` as its label, so keep it short), `manage.section` (same props; **since 1.7.2 each one is a page of the list's burger menu**, its `title()` being the menu entry, no longer a card inside Manage list), `settings.section` (`{ me, onChange }`), `admin.section` (`{ me }`). An `admin.section` is the module's **configuration panel**: Admin > Modules shows a **Configure** button on the module's card (only when the module registered one and is enabled) and opens the panel under the card. Put everything an admin configures in it (a module with several `admin.section` entries gets a heading for each). `visible({ me, data })` can hide an entry; `order` sorts. The host provides React, `api`, `moduleApi`, `t`, `errText`, `timeAgo`, `formatMoney`, `effectiveCurrency`. A module never bundles React: `scripts/build-modules.mjs` points `react` at the app's copy (`globalThis.__SL_HOST__`). Calls to `host.moduleApi('/x')` go to `/api/m/<id>/x`.

## Build, package, install

```bash
node scripts/build-modules.mjs            # modules/<id>/web.js and dist-modules/<id>-<version>.zip
cd web && npx tsc --noEmit -p tsconfig.modules.json   # type-check module sources against the host types
```

Install: **Admin > Modules > Install a module…**, choose the zip, check the name, version and SHA-256, confirm. The module is installed **switched off**. Switch it on, then press **Restart server**. Nothing restarts by itself. Docker (`restart: unless-stopped`) starts the server again.

## Language modules (since 1.3.1)

English is built into the core. Every other interface language is a **language module**: data only, no server or browser code.

```json
{
  "id": "lang-he", "name": "Hebrew (עברית)", "kind": "language", "version": "1.0.0",
  "requires": { "core": ">=1.3.1 <2.0.0" },
  "code": "he", "nativeName": "עברית", "dir": "rtl", "locale": "he-IL",
  "strings": "strings.json"
}
```

`strings.json` is one flat map from key to text and covers **core and module keys together** (modules ship English only in their own `i18n.json`; translations live in the language module). A missing key falls back to English, so a translation can be partial and new strings need English text only. `dir` (`ltr` or `rtl`) sets the page direction, `locale` drives number and currency formats (dates read day-month-year for English). The code `en` is reserved.

Language modules are open to every signed-in user while enabled (no grant, no personal switch). Settings > Language lists English plus the enabled language modules; a user whose language module is missing or switched off sees English and keeps their saved choice. Content direction does not depend on the interface language: user text (items, lists, stores, categories, households, notes) uses `dir="auto"`, so Hebrew content is right-to-left in an English interface too.

## Versions: change a module, bump its version

An installed module is only replaced when the bundled (or uploaded) version is **higher**, and browsers cache a module's files by version. So **any change to a module's files needs a new version** in its `manifest.json`, including a translation file. `modules/versions.lock.json` records each module's version and a fingerprint of what it ships; the test `server/test/modulelock.test.js` fails when files changed under an unchanged version. After bumping the version run `node scripts/module-lock.mjs` to record it.

## Lifecycle and safety

- **Startup:** removals marked earlier are applied; bundled modules are installed if missing (or upgraded when a newer bundled version exists and the installed copy is also a bundled one); enabled modules load in dependency order, each with its own migrations.
- **Quarantine:** a module that throws while loading, or whose migration fails, is stopped and marked "Stopped after an error" with the message; the app starts normally. Fix it, or roll back to the previous version (the last two versions are kept), then switch it on and restart.
- **Disable** blocks the module for everyone at once; routes and timers are removed at the next restart. **Uninstall** takes effect at the next restart; the module's database stays unless "also delete its data" is chosen. A bundled module you remove is not reinstalled behind your back; it appears under "Included with the app, not installed".
- **Dependencies:** a module cannot be switched off or removed while an enabled module depends on it.
- **Security:** an uploaded module's server code runs inside the server with full access to its own data and the process. Only admins can install; each install, enable, disable, uninstall, rollback and restart is in the audit log.
