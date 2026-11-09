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
  "slots": ["list.tab", "manage.section", "settings.section", "admin.section"],
  "server": "server/index.js",
  "web": "web.js",
  "i18n": "i18n.json"
}
```

`kind` is `feature` (default) or `language` (data only, planned for 1.3.1). Ids are lowercase letters, digits and dashes.

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
  ctx.events.on('list.deleted', ({ listId }) => { … });   // list.deleted, item.deleted, store.deleted, household.deleted, user.deleted
  ctx.core.listAccess(user, listId); ctx.core.listOpenEntries(listId); ctx.core.householdStores(hid);
  ctx.core.storeAccess(user, storeId); ctx.core.lastPaid({ itemId, storeIds, userId }); ctx.audit(userId, action, target, detail);
}
```

Rules enforced when a module is installed: only `node:` built-ins and relative imports; no path escapes in the zip; size and file-count limits; a valid manifest; a core version it supports.

### Capabilities defined by the core

| Capability | Interface | Used by |
| --- | --- | --- |
| `receipt-reader` | `read({ file, mime, userId, engine }) → { engine, lines, total, … }` (never saves anything) | the receipt queue in `server/src/receipts.js` |
| `price-source` | described by the module; live prices arrive in 1.4.0 | `price-compare` |

## Browser side: `web/index.tsx`

```tsx
import type { Host } from '../../../web/src/host';
export default function register(host: Host) {
  host.slots.add('settings.section', { id: 'x', title: () => host.t('xTitle'), order: 20, collapsible: true, component: MyPanel });
}
```

Slots: `list.tab` (props `{ data, me, reload }`), `manage.section` (same props), `settings.section` (`{ me, onChange }`), `admin.section` (`{ me }`). `visible({ me, data })` can hide an entry; `order` sorts. The host provides React, `api`, `moduleApi`, `t`, `errText`, `timeAgo`, `formatMoney`, `effectiveCurrency`. A module never bundles React: `scripts/build-modules.mjs` points `react` at the app's copy (`globalThis.__SL_HOST__`). Calls to `host.moduleApi('/x')` go to `/api/m/<id>/x`.

## Build, package, install

```bash
node scripts/build-modules.mjs            # modules/<id>/web.js and dist-modules/<id>-<version>.zip
cd web && npx tsc --noEmit -p tsconfig.modules.json   # type-check module sources against the host types
```

Install: **Admin > Modules > Install a module…**, choose the zip, check the name, version and SHA-256, confirm. The module is installed **switched off**. Switch it on, then press **Restart server**. Nothing restarts by itself. Docker (`restart: unless-stopped`) starts the server again.

## Lifecycle and safety

- **Startup:** removals marked earlier are applied; bundled modules are installed if missing (or upgraded when a newer bundled version exists and the installed copy is also a bundled one); enabled modules load in dependency order, each with its own migrations.
- **Quarantine:** a module that throws while loading, or whose migration fails, is stopped and marked "Stopped after an error" with the message; the app starts normally. Fix it, or roll back to the previous version (the last two versions are kept), then switch it on and restart.
- **Disable** blocks the module for everyone at once; routes and timers are removed at the next restart. **Uninstall** takes effect at the next restart; the module's database stays unless "also delete its data" is chosen. A bundled module you remove is not reinstalled behind your back; it appears under "Included with the app, not installed".
- **Dependencies:** a module cannot be switched off or removed while an enabled module depends on it.
- **Security:** an uploaded module's server code runs inside the server with full access to its own data and the process. Only admins can install; each install, enable, disable, uninstall, rollback and restart is in the audit log.
