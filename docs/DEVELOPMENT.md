# Development

## Run locally

```bash
cd server && npm install && npm test      # API and module tests (core and ../modules/*/test)
cd server && npm run dev                  # API on :3000, data in ../data
cd web && npm install && npm run dev      # Vite on :5173, proxies /api to :3000
node scripts/build-modules.mjs            # after changing a module's browser code
python e2e/make_receipts.py && python e2e/e2e.py   # real-browser test incl. real OCR (see the header of e2e.py)
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
server/src/entries.js     putting an item on a list (also records it as one of the list's past items)
server/src/receipts.js    receipt queue (a 'receipt-reader' module does the reading)
server/src/secrets.js     encrypts stored API keys (key file: data/secret.key)
server/src/modules/       module system: manifest checks, zip install, loader, events, core read API
server/src/routes/        auth, admin, lists, shopping, households, history, itemsCsv, modules
server/test/              node:test API tests
modules/receipt-ocr/      Tesseract + cloud receipt reading
modules/price-compare/    supermarket portals, branch directory, price comparison, item suggestions
modules/lang-he/          Hebrew interface text (a language module)
scripts/                  set-version.sh, build-modules.mjs, module-lock.mjs
web/src/                  React + Vite PWA (i18n.ts holds the English text; other languages are modules)
e2e/                      real-browser test with real OCR
```

## Duplicate prevention

Every item name is normalised (case, punctuation, accents, Hebrew niqqud and final letters, English and Hebrew plural endings, the Hebrew article ה). Adding `Tomatoes` when `tomato` exists reuses the same item silently. A near-miss such as `Rise` for `Rice` asks the user to confirm. Typo tolerance grows with word length and can be tuned with the `match_strictness` setting (`loose` / `normal` / `strict`, API only for now). Rules live in `server/src/match.js` and are covered by `server/test/match.test.js`; extend them there as you find real-world cases.

## CSV notes

Purchase history export: date and time (UTC), household, list, store, item, category, quantity, unit price, line total, currency, buyer, trip and receipt total (printed once per trip so sums do not double count); optional date range; purchases from private lists are only exported to people who can see those lists; UTF-8 with BOM so Excel shows Hebrew. Item list export/import: names are matched with the same fuzzy matcher, missing categories are created, a preview shows what will happen, and quantities are added to the list. Cells that start with `=`, `+`, `-` or `@` are protected against spreadsheet formula injection on export and unprotected on import.

## Releases

1. If a module's files changed (a translation file included), bump its version in `modules/<id>/manifest.json` and run `node scripts/module-lock.mjs`; a test fails otherwise.
2. `bash scripts/set-version.sh X.Y.Z` (updates both `package.json` files and lockfiles; they must match).
3. Run the tests, then tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push && git push --tags`. The tag builds, tests and publishes the image (see [Deployment](DEPLOYMENT.md)).

More: [Modules](MODULES.md) explains the module contract; `HANDOFF.md` is the working state for continuing development.
