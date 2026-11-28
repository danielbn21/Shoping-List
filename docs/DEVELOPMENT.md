# Development

## Run locally

```bash
cd server && npm install && npm test      # API and module tests (core and ../modules/*/test)
cd server && npm run dev                  # API on :3000, data in ../data
cd web && npm install && npm run dev      # Vite on :5173, proxies /api to :3000
node scripts/build-modules.mjs            # after changing a module's browser code
python e2e/make_receipts.py && python e2e/e2e.py   # real-browser test incl. real OCR (see the header of e2e.py)
python e2e/make_barcodes.py && python e2e/e2e_scan.py   # barcode scanning with a fake camera (see the header of e2e_scan.py)
python e2e/e2e_match.py                                 # automatic matching in Compare prices (see the header of e2e_match.py)
```

The web app is type-checked with `cd web && npx tsc --noEmit` and, for module sources, `npx tsc --noEmit -p tsconfig.modules.json`.

API writes (anything not GET) must send the header `X-SL-Client: web` (CSRF defence). The web app does this automatically.

## Project layout

```
server/src/db.js          full schema, migrations via PRAGMA user_version (append only)
server/src/util.js        hashing, settings, audit, household/user helpers
server/src/auth.js        sessions, cookie, app.auth() guard
server/src/access.js      who may see/edit a list (owner, editor, shopper)
server/src/match.js       EN/HE normalisation + fuzzy matching (the duplicate-prevention engine)
server/src/entries.js     putting an item on a list; rememberForList() records it as one of the list's past items
server/src/receipts.js    receipt queue (a 'receipt-reader' module does the reading)
server/src/secrets.js     encrypts stored API keys (key file: data/secret.key)
server/src/modules/       module system: manifest checks, zip install, loader, events, core read API
server/src/routes/        auth, admin, lists, shopping, households, history, itemsCsv, modules
server/test/              node:test API tests
modules/receipt-ocr/      Tesseract + cloud receipt reading
modules/price-compare/    supermarket portals, branch directory, price comparison, item suggestions, barcode lookup, automatic matching (matching.js scoring, lexicon.js + translate.js English to Hebrew, suggest.js tiers, guesses.js, ai.js optional translation)
modules/barcode-scan/     scanning barcodes with the camera (bundles ZXing's EAN readers from web/node_modules)
modules/lang-he/          Hebrew interface text (a language module)
scripts/                  set-version.sh, build-modules.mjs, module-lock.mjs
web/src/                  React + Vite PWA (i18n.ts holds the English text; other languages are modules)
e2e/                      real-browser test with real OCR
```

## Past items rule

A list's past items are the rows of `list_items`. Every code path that puts an item on a list, imports it into a list, or records a purchase for it on a list must call `rememberForList()` (`server/src/entries.js`). Today that is `addToList`, the entry insert in `routes/lists.js`, the CSV import, the receipt review, the add-a-trip route (`POST /api/lists/:id/trips`) and `ctx.core.scanItem` (modules). The Add a trip form can fill its rows from a photo through `POST /api/lists/:id/receipt-read` (reads through the `receipt-reader` capability and saves nothing); the trip itself is saved by the add-a-trip route as before. When you add a writer, grep `INSERT INTO items`, `INSERT INTO purchase_events` and `INSERT INTO list_entries`, and cover it in `server/test/pastitems*.test.js`.

## Duplicate prevention

Every item name is normalised (case, punctuation, accents, Hebrew niqqud and final letters, English and Hebrew plural endings, the Hebrew article ה). Adding `Tomatoes` when `tomato` exists reuses the same item silently. A near-miss such as `Rise` for `Rice` asks the user to confirm. Typo tolerance grows with word length and can be tuned with the `match_strictness` setting (`loose` / `normal` / `strict`, API only for now). Rules live in `server/src/match.js` and are covered by `server/test/match.test.js`; extend them there as you find real-world cases.

## CSV notes

Purchase history export: date and time (UTC), household, list, store, item, category, quantity, unit price, line total, currency, buyer, trip and receipt total (printed once per trip so sums do not double count); optional date range; purchases from private lists are only exported to people who can see those lists; UTF-8 with BOM so Excel shows Hebrew. Item list export/import: names are matched with the same fuzzy matcher, missing categories are created, a preview shows what will happen (including how many items become new past items of the list), every created or updated item becomes one of the list's past items whatever its quantity, and only rows with a quantity above 0 are also put on the list. Since 1.8.0 a module that provides `item-csv-columns` adds columns (Barcode scanning: `barcode`, several codes in one cell separated by spaces); the preview lists barcodes that move from another item and the file always wins. Cells that start with `=`, `+`, `-` or `@` are protected against spreadsheet formula injection on export and unprotected on import.

## Releases

1. If a module's files changed (a translation file included), bump its version in `modules/<id>/manifest.json` and run `node scripts/module-lock.mjs`; a test fails otherwise.
2. `bash scripts/set-version.sh X.Y.Z` (updates both `package.json` files and lockfiles; they must match).
3. Run the tests, then tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push && git push --tags`. The tag builds, tests and publishes the image (see [Deployment](DEPLOYMENT.md)).

More: [Modules](MODULES.md) explains the module contract; `HANDOFF.md` is the working state for continuing development, with the release history (section 3) and what is left to do.


## Admin settings, checkpoints and files (1.9.0)

- **Adding an admin setting:** add its default to `SETTING_DEFAULTS` (`server/src/util.js`), its type and range to `FIELDS` (`server/src/config.js`; `group: 'limits'` or `'abuse'` makes it appear in Settings automatically, other groups need a screen), a label `set_<key>` in `web/src/i18n.ts` and in `lang-he`, and use `getSetting(db, key)` where it is enforced. Every value goes through `normalizeValue`, the same check a restore uses.
- **Limits** are enforced in the handlers (`max_image_mb`, `max_module_mb`, `max_csv_mb`, `max_trip_lines`); the parsers' own limits are fixed ceilings (50 MB images, 100 MB modules, 20 MB CSV, 1 MB JSON). **Rate limits** are functions that read the setting on every request, so a change applies at once.
- **Checkpoints** (`config_checkpoints`, migration 10): `app.config.autoBefore(keys, actorId)` before a change (the PUT settings route, a module's declared settings and switching a module on or off do it), `snapshot()`, `plan(data)` (what a restore would do, nothing written), `apply(plan, actorId)` (saves a restore point first). The newest 30 automatic ones are kept. The format is `{ format: 'shoplist-config', formatVersion: 1, appVersion, createdAt, core, modules, omitted }`; a newer `formatVersion` is refused. The SMTP password is never in one and a restore keeps the server's.
- Routes: `/api/admin/config/checkpoints` (GET, POST, DELETE `/:id`), `/export`, `/checkpoints/:id/export`, `/preview`, `/restore` (body `{ checkpointId }` or `{ data }`).

## Browser suites (1.9.2)

Each needs a fresh data dir and its own port: `e2e_nav192.py` 3993 (`DATA_DIR=/tmp/nav-data`), `e2e_admin.py` 3994, `e2e_mobile.py` 3995, `e2e_match.py` 3996, `e2e_scan.py` 3997 (needs `python3 e2e/make_barcodes.py`), `e2e.py` 3998 (needs `e2e/make_receipts.py`, tesseract and the fake portals; see its header). `e2e_nav192.py` is the one to extend when navigation changes: the back arrow on every screen, browser back, refresh, the grouped menu, the remembered page, and the tablet and desktop layouts.
