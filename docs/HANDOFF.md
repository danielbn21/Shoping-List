# Shopping List PWA: handoff v8 (18 Nov 2026)

Written for a fresh chat. It replaces `Shopping_List_PWA_handoff_briefing.md`, `…_v2.md` and the long `docs/HANDOFF.md` inside the zip (put this file there as `docs/HANDOFF.md`). **1.4.5, 1.5.0, 1.6.0, 1.6.1 and 1.7.0 are done (sections 5 to 8). Next: the parked store-versus-category issue, then the backlog.** Give the new chat this file and `shoplist-1_7_0.zip`.

---

## 0. Start here

**Give the new chat:** this file and `shoplist-1_7_0.zip` (the code). Optional: the four module zips (`price-compare-1.5.0`, `receipt-ocr-1.0.1`, `lang-he-1.3.0`, `barcode-scan-1.0.1`), which are already inside the project under `modules/`.

**Owner's working style.** Settles a plan before code ("review before pursuing"); dictates, so expect typos; wants honesty about what is verified; **asks answered one question at a time** (ask at most one); likes short descriptive bullet lists; checks details and will catch sloppy ones (see the lessons in section 9). Wants everything deterministic and local, no cloud AI at runtime. English interface first; Hebrew and right-to-left stay supported for *content*.

**Verified at 1.7.0 (sandbox):** 150 backend tests, 134 + 14 + 8 browser checks (the second script is the fake-camera barcode test, the third the automatic-matching test) (Playwright, real Tesseract), `tests/test-update.sh` 25 checks, database upgrades 1.2.1→current. **Never verified:** a real Docker build (the image's module-build stage was only simulated by hand), the live retailer portals (the sandbox cannot reach them), matching quality on the owner's real item names, real phones.

**Commands** (repo root; run `npm ci` without `--silent` and check that `node_modules` exists):
```
cd server && npm ci && npm test                       # 112 tests; includes ../modules/*/test
cd web && npm ci && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.modules.json && npm run build
node scripts/build-modules.mjs                        # compiles each module's browser code -> modules/<id>/web.js, zips -> dist-modules/
bash tests/test-update.sh
python3 e2e/make_receipts.py                          # once; needs tesseract + playwright chromium
bash run_e2e.sh                                       # the script below
```
`run_e2e.sh` (start the server and the test in ONE shell call; background processes die when a tool call ends; never `pkill -f`, it can kill its own shell):
```
cd <repo>
kill $(pgrep -f '^node server/src/index.js') 2>/dev/null; kill $(pgrep -f '^node modules/price-compare/test/fakePortals') 2>/dev/null; sleep 1
rm -rf /tmp/e2e-data /tmp/shots; mkdir -p /tmp/shots
(node modules/price-compare/test/fakePortals.js 4999 > /tmp/fake.log 2>&1 &); sleep 1
(DATA_DIR=/tmp/e2e-data WEB_DIR=web/dist PORT=3998 PORTAL_URL_SHUFERSAL=http://127.0.0.1:4999/shufersal PORTAL_URL_SHARED=http://127.0.0.1:4999/shared PORTAL_URL_CARREFOUR=http://127.0.0.1:4999/carrefour PORTAL_CITIES_URL=http://127.0.0.1:4999/gov/datastore_search node server/src/index.js > /tmp/server.log 2>&1 &); sleep 3
timeout 280 python3 e2e/e2e.py > /tmp/e2e.out 2>&1; echo exit $?; grep -c "^PASS" /tmp/e2e.out; grep "^FAIL " /tmp/e2e.out
```
Other sandbox tips: `/bin/sh` has no brace expansion; Hebrew in tool output needs ASCII-safe printing (`cut -c` can split multibyte characters).

---

## 1. What the app is

Self-hosted, multi-user household shopping list PWA, one Docker container behind Nginx Proxy Manager and Cloudflare. Node 22 + Fastify 4 + SQLite (better-sqlite3, WAL), plain JS ES modules on the server; React 18 + Vite 5 + strict TypeScript + dnd-kit + vite-plugin-pwa on the web; Tesseract in the image. API writes need header `X-SL-Client: web`. `restart: unless-stopped` in `docker-compose.yml`; `update.sh` updates with backup and automatic rollback.

**Model.** A **household** owns the **item bank** (items with name, category, default note, saved price), categories, stores and purchase history. **Lists** (whole-household or private) hold entries. Roles per list: Owner, Editor (`contributor`), Shopper (`viewer`: sees Shop and History only). Per list three tabs: **Shop** (tick, Finish trip, store/order selector, price estimates), **Manage list** (collapsible, user-ordered sections: Add items, On this list, Add from past items, CSV, Categories, Stores, module sections, People, List settings), **List history** (trips, corrections, receipt photos, restore). Duplicate prevention (English and Hebrew normalisation): exact normalised name reuses the household item, a near-miss asks "did you mean…". Prices are stored per purchase (`purchase_events.unit_price`, `line_total`, per-trip `currency`); currency is a personal setting; no conversion.

**Past items are per list (1.4.3):** table `list_items(list_id, item_id, added_at)`; `GET /api/households/:hid/items?listId=` returns only that list's items; removal is `POST /api/lists/:id/past-items/remove`. The *item record* (category, note, price, and the price-comparison matches in the price-compare module) stays shared by the household, so nothing is matched twice. **Every code path that puts an item on a list or records a purchase for it must also insert into `list_items` (see section 5).**

**Other decisions to keep.** English UI default; language chosen only in Settings; Hebrew is a language module. Receipt OCR: local Tesseract first, cloud only with the user's own key (stored encrypted); review screen is mandatory. History is open to everyone on the list. Admin settings in `util.js` `SETTING_DEFAULTS`. Price estimates in the Shop tab: user pref `showEstimates` (null = follow the admin default `estimates_default`, default on). Until real deployment the owner allowed wiping the database; **once other users are on it, treat the database as real: only append migrations (currently 1–9), never edit one.**

---

## 2. Architecture: core + modules (1.3.0 onward)

Optional features are **modules** under `modules/<id>/` (each with `manifest.json`, `server/`, `web/` sources, `i18n.json` or `strings.json`, `test/`). Installed in `data/modules/<id>/<version>/`, each with its **own SQLite** (`data/modules/<id>/data.db`, own schema version). Bundled modules (in the image at `/app/modules`) auto-install enabled on first start and **upgrade only when the bundled version is higher**. Admin > Modules: install a zip (shows name, version, SHA-256, installs disabled), switch on/off, **Configure** (a module's `admin.section` panel), who may use it (admin grants, user switches themselves), roll back, uninstall, **Restart server** (the only restart trigger). A module that fails to load is quarantined; the app still starts.

| Module (version) | Does |
| --- | --- |
| `price-compare` 1.3.0 | portals of 12 Israeli chains, branch directory, daily price files merged per branch/item, product matching, Compare tab, Add-items catalog (`item-catalog`), `price-source`. Own tables: `branch_prices`, `branch_price_state`, `product_map`, `store_chain`, `list_compare_*`, portal tables |
| `receipt-ocr` 1.0.1 | capability `receipt-reader` (Tesseract / own cloud key); the core keeps the queue and the review screen |
| `lang-he` 1.1.0 | `kind: language`: data only, `strings.json` covers core and module keys; English is built in |

**Contract (details in `docs/MODULES.md`).** Server entry `export const migrations = [...]; export default function register(ctx)`; imports only `node:` built-ins and own files. `ctx`: `db`, `settings`, `routes` (served at `/api/m/<id>/…`, login + module access enforced), `events.on(...)` (`list.deleted`, `item.deleted`, `store.deleted`, `household.deleted`, `user.deleted`), `provide(capability, impl)`, `core` read API (`listAccess`, `canEdit`, `listOpenEntries`, `householdStores`, `storeAccess`, `lastPaid`, `itemInHousehold`, `similarItem`, `audit`), `filesDir`, `secrets`. Browser code is compiled ahead of time (`scripts/build-modules.mjs`, React supplied by the app as `globalThis.__SL_HOST__`) and registers into slots `list.tab`, `manage.section`, `settings.section`, `admin.section`. Capabilities: `receipt-reader`, `price-source`, `item-catalog`.

**Version rule (enforced by a test).** Changing *any* file a module ships, a translation file included, requires bumping its version in `manifest.json` and running `node scripts/module-lock.mjs`; `server/test/modulelock.test.js` fails otherwise (`modules/versions.lock.json`). Reason: installed copies upgrade only on a higher version and browsers cache module files per version.

**Repo layout.** `server/src/` (db.js migrations; util.js; entries.js `addToList`; receipts.js; modules/ loader; routes/ auth admin lists shopping households history itemsCsv modules), `server/test/` (node:test; fixtures incl. `sample-module`), `modules/*`, `scripts/` (set-version.sh, build-modules.mjs, module-lock.mjs, module-hash.mjs), `web/src/` (App, Home, ListView, ShopTab, ManageTab, HistoryTab, Settings, Admin, ModulesAdmin, ModulesUser, ManageLayout, Section, i18n.ts English dictionary, slots/host/modules/prefs), `e2e/`, `tests/test-update.sh`, `docs/MODULES.md`, `docs/DEPLOYMENT.md`, `docs/DEVELOPMENT.md`, `update.sh`, Dockerfile, docker-compose.yml.

---

## 3. Releases so far (only what matters now)

1.0–1.2: households, lists, history with corrections, OCR, CSV, portals directory. **1.3.0** module system. **1.3.1** collapsible/orderable Manage sections, language only in Settings, Hebrew as a module, `dir="auto"` for content. **1.4.0** prices and matching. **1.4.1** Configure per module, **Compare now** with progress status, red coverage, items to match once per chain, automatic matching at other chains. **1.4.2** Add-items autocomplete "From the stores". **1.4.3** per-list past items (migration 9), multi-select removal, price estimates with per-user switch and admin default. **1.4.4** module version housekeeping and the version guard. **1.4.5** past-items linking fix: CSV import links every created/updated item to the list it is imported into (any quantity), receipt review links items to the trip's list, helper `rememberForList`. **1.7.0** automatic matching in price-compare 1.5.0 (see section 8), core adds `ctx.core.listPastItems`, `lang-he` 1.3.0. **1.6.1** two layout fixes to the scanner (Scan button in the Add button's row in Manage list; the scanner takes the app's light/dark colours: `var(--paper)`/`var(--text)`), `barcode-scan` 1.0.1. **1.6.0** barcode scanning: core adds `ctx.core.scanItem`, `ctx.capability`, slots `shop.toolbar` and `manage.toolbar`; new module `barcode-scan` 1.0.0; `price-compare` 1.4.0 provides `barcode-lookup` (migration 4, index on `code`); `lang-he` 1.2.0. **1.5.0** trips by hand (add, edit date and store, delete), import preview count, `lang-he` 1.1.1; also fixed: a trip's store edit now moves its purchase lines too.

---

## 4. The bug found in 1.4.3 (reported by the owner on 11 Nov 2026)

**Symptoms.** After upgrading, a list's "Add from past items" was empty; importing the CSV export of the past items did not bring them back.

**Cause (reproduced on a fresh database).** In 1.4.3 a list's past items became "items linked in `list_items`". Items get linked only when an entry is created (`addToList` in `server/src/entries.js`, and the insert in `POST /api/lists/:id/entries` in `routes/lists.js`). Two gaps:
1. **CSV import** (`routes/itemsCsv.js`, near line 121): `if (row.quantity > 0) addToList(...)`. The export lists the whole household bank with `quantity` 0 for everything not on the list, so an import of that file creates/updates the household items but never links them to the list. In the reproduction: import of 3 rows with quantity 0 → bank has 3 items, `list_items` has 0 rows, past items `[]`; the preview summary even says `addToList: 0`.
2. **Migration 9** backfilled `list_items` only from `list_entries` and `purchase_events`. Items that existed in the household bank without any entry or purchase on any list (typically imported with quantity 0 before) got no link, so they vanished from every list.
3. **Same gap, found while investigating:** `routes/history.js` (receipt review "apply", near line 256) creates or reuses items and inserts `purchase_events` for `trip.list_id` without linking them to that list.

No data was lost: the items, categories, notes, prices and matches are all still in the household bank.

---

## 5. DONE: version 1.4.5 (core only)

Implemented as decided: `rememberForList(db, listId, itemId, at)` in `server/src/entries.js` (rule documented there) is used by `addToList`, the entry insert in `routes/lists.js`, CSV import (every `create`/`update` row, entry only when quantity > 0) and receipt-review apply (when `trip.list_id` is set). No migration; migration 9 unchanged; no cross-list repair (re-import the CSV into the intended list). Tests: `server/test/pastitems145.test.js` (7; they fail on 1.4.4). E2E: a quantity-0 "Sesame" row must appear under past items, not on the list. **Rule for 1.5.0:** every path that creates a purchase must link its item to its list.

**Documentation split (owner's request, same release):** `README.md` is now a short GitHub page (features, quick start, using the app, links); `docs/DEPLOYMENT.md` (run, HTTPS, accounts, modules and restarts, receipt privacy, upgrading, published image, troubleshooting), `docs/DEVELOPMENT.md` (run locally, layout, past-items rule, duplicate prevention, CSV notes, releases) and `docs/MODULES.md`. The per-version notes and the old roadmap are not in the README any more: section 3 is the release history. **1.5.0 decision:** deleting a trip leaves the items' saved price as it is.\n\n

(The import preview count that was moved out of 1.4.5 shipped in 1.5.0.)

---

## 6. DONE: version 1.5.0 (core; lang-he 1.1.1; no migration)

Implemented in `server/src/routes/history.js` and `web/src/HistoryTab.tsx`:
- `POST /api/lists/:id/trips` (Owner/Editor): store, `at` (ms or date string, not before 2000, not more than a day ahead), total, currency, lines (`name` or `itemId`, `quantity`, `unitPrice` or `lineTotal`; max 200). A trip needs a total or at least one line (`empty_trip`). Names follow the receipt-apply rules (exact normalised name reuses the household item, otherwise a new item; no "did you mean"). Every item goes through `rememberForList`. The item's saved price is set from the line only when no newer priced purchase exists. Audit `trip.added`. UI: "Add a trip" form at the top of List history (date, store, total, rows, optional receipt photo uploaded afterwards through the existing route).
- `PATCH /api/trips/:id` now also takes `finishedAt`, and **a store or date change updates the trip's purchase lines too** (before 1.5.0 only the trip row changed, so estimates, "last paid" and the CSV kept the old store). Same permission as before (anyone who can see the list). UI: "Edit date and store" in the trip.
- `DELETE /api/trips/:id` (Owner/Editor; for a trip whose list was deleted, the household owner): deletes the purchase lines explicitly, the receipt rows and files, then the trip; items are not restored to the list and stay past items; audit `trip.deleted`. The saved item price is deliberately left as it is (owner's decision), so estimates fall back to it. UI: "Delete this trip" with a confirmation naming the lines and photos.
- CSV import preview: `summary.pastItems` and the line "N will be added to this list's past items." (`csvPast`).
- Strings: English in `web/src/i18n.ts`, Hebrew in `modules/lang-he/strings.json` (module 1.1.1, lock refreshed). New error codes: `invalid_date`, `empty_trip`, `too_many_lines`.
- Tests: `server/test/trips.test.js` (6), a preview test in `pastitems145.test.js`; e2e covers the preview line, add, edit date and delete. Not covered by e2e: the Hebrew layout of the new form and a store edit in the browser.

**Parked by the owner:** the Shop-tab store selector ("By category" or a store) versus store names appearing as item categories somewhere; the owner will describe it after testing. Do not change anything for it until they do; ask for the exact place and a screenshot.

**Open questions for the owner.**
1. Estimates: for a store with no receipts, show nothing (current) or the last price from another store marked as less exact?
2. After they try it on the real portals: which automatic matches or suggestions were wrong (names), to tune the matcher.

**Later backlog.** Live sync and offline queue; web push; smart suggestions; list images/themes UI; per-item store overrides; guest invites; admin backup/restore; usage views; real-phone validation; first real Docker build; Victory and Hazi Hinam portals (unknown portal/username).

---

## 7. DONE: version 1.6.0 (core 1.6.0, barcode-scan 1.0.0, price-compare 1.4.0, lang-he 1.2.0)

Owner's decisions: scanning while shopping an item **not on the list** adds it **already ticked**; an item on the list is ticked; an unknown barcode asks for a name once; the scan also saves the product's price as the item's saved price; a barcode matched once is remembered.

- **Core:** `ctx.core.scanItem({ user, listId, itemId|name, price, tick })` in `server/src/modules/coreApi.js` (the one write a module may do; goes through `addToList`/`checkEntry`, so the item joins the list's past items; ticking needs any list role, adding or creating needs Owner/Editor). `checkEntry` was extracted into `entries.js` and is used by `POST /api/entries/:id/check` too. `ctx.capability(name, userId)` lets one module use another's capability. Slots `shop.toolbar` (next to the Shop search box; props include `storeId`) and `manage.toolbar` (in the Add button's row). The ShopTab now gets `reload`.
- **price-compare 1.4.0:** capability `barcode-lookup` (`server/barcode.js`): barcode spellings (with or without leading zeros, UPC-A/EAN-13/GTIN-14), never a chain's own code (`item_type 0`), price from the household store's chain, else the list's chosen branches, else any branch read (lowest price in the group); weighted products are flagged. Migration 4 adds an index on `branch_prices(code)`.
- **barcode-scan 1.0.0:** `POST /api/m/barcode-scan/lists/:id/scan` (`{ code, tick, storeId?, itemId?, name? }` answers `done`, `confirm` or `unknown`). Order: remembered barcode (`barcode_items`) -> chosen item or typed name -> product from the price files (a similar existing item is offered for confirmation, otherwise a new item is made from the product name). Per-kilo prices are not saved as item prices. Works without price-compare (asks for a name). Web: Scan button in Shop (ticks) and Manage list (adds); full-screen scanner with camera, typed-number fallback and check-digit validation. Decoder: the browser's `BarcodeDetector` when it supports EAN (Chrome on Android), else ZXing's EAN-13/EAN-8 readers in JavaScript (imported from their own files, 52 KB; `@zxing/library` is a web devDependency and `scripts/build-modules.mjs` resolves it through `nodePaths`). A repeated scan of an item already in the cart adds 1 to its quantity (my decision, not asked).
- **Tests:** `modules/barcode-scan/test/scan.test.js` (10), `modules/price-compare/test/barcode.test.js` (5), `e2e/e2e_scan.py` (11 checks, fake camera through `e2e/make_barcodes.py`). The existing price-compare upgrade test now expects schema version 4.
- **Not verified:** a real phone camera (focus, glare, curved packaging, scanning speed on an older iPhone); real barcode coverage of the chains' price files (run the portal test and look at the barcode and short-code counts per chain); Hebrew layout of the scanner. If scanning is slow on iPhone, swap the JavaScript reader for a WebAssembly one behind the same `decode` function in `decode.ts`. Ideas not built: undo of a scan, torch button, offline queue, taking the item category from the product.

## 8. DONE: version 1.7.0 (price-compare 1.5.0, core 1.7.0, lang-he 1.3.0)

Owner's decisions: matching should be automatic; where it is not very certain the best candidate is **pre-filled and accepted with one tap** (never applied by itself); English item names must find their Hebrew products: **a dictionary first, then an AI when the person has saved a key**; all of it **contained in price-compare** (the only core change is the read function `ctx.core.listPastItems`).

**What was found on the owner's real files (Stop Market, Rami Levy, Carrefour, Shufersal of 11 Nov 2026; two lists of 320 items, the Hebrew one and the same list typed in English, row i = row i):**
- Price files carry the chain's longer name in `ManufactureItemDescription` (Stop Market: 14,146 of 15,266 products; `ItemName` is cut at 20 characters at Stop Market and Rami Levy). The module ignored it. It is now stored (`branch_prices.description`, `desc_norm`; migration 5) and used for matching; `branch_price_state.desc_ok` makes every file already read be read once more.
- Ranking the right product first for the 164 items whose right product is known at Stop Market (the household's own Hebrew item name and saved price): **84% before, 95% now** (155/164; 100% within the suggestion plus its alternatives).

**Tiers** (`server/suggest.js`, run by `guesses.js` from the compare route a little at a time, 1.2 s budget per request, results kept in `match_guess`, made again weekly or when the item name changes):
- **exact**: the item's name equals a product's name or full description, one product only -> applied as `product_map` status `auto`, `auto_via = 'name'` (the screen says "Matched by name"). On the real data 62 of 62 were right. An exact match also spreads its barcode to the other chains (like a user's own choice), in the same request.
- **likely**: the item's name is the start of one product's description, or one product clearly beats the rest -> pre-filled. Real data: 70 of 72 right.
- **guess**: the best of what fits (score at least 0.7) with 5 alternatives -> pre-filled. Real data: 23 of 29 right, 6 more among the alternatives.
- Nothing close: kept as "looked, nothing".
- A match at another chain starts from the product already right there (full text, brand, pack size): same brand and pack raise the score, a different pack lowers it (`rank(..., { source })`). Cross-chain by name alone stays a guess; the barcode is what carries exact matches.
- One tap: `POST /api/m/price-compare/lists/:id/matches/accept { chain, itemIds? }` confirms the kept suggestions (never over a user's own choice; Owner/Editor only). UI: a chip (Likely / Guess), Accept, Change, Accept all N per chain, progress line while guesses are made, AI status line.
- Result on the real data: accepting the suggestions at Stop Market prices 262 of the 308 Hebrew-list items there, and the barcodes then price 142 at Rami Levy, 94 at Carrefour and 75 at Shufersal (before this work: 5 of 159 matched by themselves at Rami Levy). Items are matched ahead of time for the list's **past items** too (up to 500).

**English** (`server/lexicon.js` ~900 entries, `server/translate.js`): phrases and words, plurals, "A or B" / "A / B" alternatives, brands (Osem = אסם), noise words dropped, unknown words reported. On the 164 verifiable items 143 translate completely; the household's actual product is the suggestion for 33% and among the alternatives for another 29% (62% in all); nothing is suggested for 14 (8.5%). An English name is never better than a guess (many English names are generic: "Milk"). **Caveat:** the dictionary was written with part of this sample in view, so accuracy on an unseen list may be lower; extend `lexicon.js` when real misses show up (the `unknown` list of `translateQuery` says which words).
- **Optional AI** (`server/ai.js`, own table `ai_settings`, a person's own key, encrypted with `ctx.secrets`, never returned; providers Anthropic `claude-haiku-5-5`, OpenAI `gpt-4o-mini`, Gemini `gemini-2.0-flash`; request shapes copied from receipt-ocr): in the compare request, English names the dictionary cannot fully translate are put to the requesting person's AI in the background, in batches of 25, **only the names**, once each; answers are kept in `translations` for everybody and win over the dictionary for that exact name. No key: nothing is sent. Errors are reported (`ai.error`) and not retried for ten minutes. UI: Settings section "English item names (optional AI)".

**Tests:** `modules/price-compare/test/auto-real.test.js` (real data trimmed to ~450 KB in `test/fixtures/real/`: thresholds on accuracy and on prices per chain; ~25 s), `auto-rules.test.js` (8: translation, exact and prefix rules, exact + barcode, accept and its permissions, English search, descriptions, AI with a fake provider and key privacy, the one-time re-read after upgrade), `e2e/e2e_match.py` (8 checks). The upgrade test in `prices.test.js` now expects schema version 5 and drops what migration 5 adds from its simulated 1.1.0 database. Fixture builder was a throwaway script (it needs the private files).

**Performance:** about 33 ms per item per chain (18 ms database search, 15 ms ranking); the first run for 308 items on four chains takes about 25 s in the background (the screen shows "Looking for matches… N left"). Ideas: an FTS index instead of `LIKE %stem%`; fewer candidates by requiring two stems.

**Not verified:** a real AI provider call (no key in the sandbox; only a fake provider); the other chains' real files for descriptions (Rami Levy has 460 products whose description differs from the name, Shufersal 113, Carrefour none in the samples); the Hebrew layout of the new screen parts; very large households (hundreds of past items on many chains); accuracy of the English dictionary on lists other than this one. Ideas not built: learn from the user's accepted choices, take the item category from the product, pack-size-aware guesses for generic names, undo for "Accept all".

## 9. Release routine and lessons

1. Change a module → bump its version, `node scripts/module-lock.mjs` (the test enforces it). 2. `bash scripts/set-version.sh X.Y.Z`. 3. Run all suites (section 0). 4. Update this file (section 3 release history, section 5). The README is short and only changes when a feature the owner would show on the GitHub page changes; details live in `docs/DEPLOYMENT.md` and `docs/DEVELOPMENT.md`. 5. Zip as `shoplist-X_Y_Z.zip` excluding `node_modules`, `dist`, `dist-modules`, `data`, `.git` and the built `modules/*/web.js`/`web.css`; build the module zips with `node scripts/build-modules.mjs`. 6. Git: `git commit`, tag `vX.Y.Z`, push (the tag triggers the image workflow; see README).

**Lessons from this project.** Never ship changed files under an unchanged version (module or project): it broke Hebrew upgrades once and is why the lock test exists. When changing how data is linked, grep every writer of that data, not just the obvious one (1.4.3 missed the CSV import and the receipt review). Test the import/export round trip, not just the happy path with quantities.

---

## 10. Reference: portals and file formats (for price-compare work)

**Portals (12 chains, 3 client types).** Shufersal: `https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=<n>&storeId=<id>` (`catID=5` Stores, `catID=2` PriceFull links). Shared portal `https://url.publishedprices.co.il`: login with a per-chain username and empty password (csrf token from `/login`), `POST /file/json/dir`, download `/file/d/<fname>` (usernames: RamiLevi, osherad, yohananof, TivTaam, Keshet, doralon, freshmarket, SalachD, Stop_Market, politzer). Carrefour `https://prices.carrefour.co.il` (path from the page). Chain ids in `modules/price-compare/server/chains.js` (`victory` and `hazi_hinam` listed as not supported). Env overrides for tests: `PORTAL_URL_SHUFERSAL|SHARED|CARREFOUR`, `PORTAL_CITIES_URL`. Branch cities from data.gov.il resource `5c78e9fa-c2e2-4771-93ff-7f400a12f7ba`.

**Files.** `PriceFull<ChainID13>-<SubChain3>-<Store3>-<yyyymmdd>-<hhmmss>.gz` is the full catalogue (`Price…` is an unreliable update file: ignore); gzip, UTF-8 with BOM. `Stores…xml` is UTF-16 LE with BOM. Item fields: `PriceUpdateTime, ItemCode, ItemType (1 barcode, 0 chain code), ItemName, ManufactureName, ManufactureCountry, ManufactureItemDescription, UnitQty, Quantity, UnitOfMeasure, bIsWeighted, QtyInPackage, ItemPrice, UnitOfMeasurePrice, AllowDiscount, ItemStatus`. Weighted items: `ItemPrice` is per kg. **No category and no notes in price files.** Pack size = `Quantity` + `UnitQty` ("500 גרם"). The timestamp in the file name is the freshness. Live tests of Stop Market and Rami Levy passed on the owner's server (11 and 99 branches); Shufersal and Carrefour live output was never seen (formats known from real fixtures in `modules/price-compare/test/fixtures/portal`).

**Price-compare behaviour in one paragraph.** A branch's newest PriceFull is read lazily (first look after the admin interval, default 24 h; or **Compare now**; a branch checked in the last 10 minutes is left alone; failed branches retry at most hourly) and **merged** (a price stays until a newer one arrives; unseen items keep their price and are flagged old after an admin-set number of days, default 60; files with under half the previous item count are refused). Matching is per household, item and chain (`product_map`: `confirmed`, `none`, `auto`): same barcode at another chain applies automatically; a clear match (same words ignoring brand, same brand and pack size, same weighed/packed form, no equally good rival) is carried to other chains as `auto`, labelled "Matched automatically (from …)"; the user's own choice always wins. Other branches of a chain use the same product by code, else by exact name. Receipt prices only fill gaps and are labelled.
