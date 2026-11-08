# Shopping List PWA: Handoff

*State: version 1.2.1 (1.0.0 was the first tagged release; earlier internal builds were numbered Stage 1 to 3.2.1), development paused. Written so a new developer, a fresh chat or Claude Code can continue without the earlier conversation. Keep this file current: update section 3 and section 5 at the end of every working session.*

## 1. What this is

A **self-hosted, multi-user household shopping list PWA** for Android, iPhone, Windows and Mac through the browser. One Docker container on the owner's server, behind **Nginx Proxy Manager and Cloudflare** (HTTPS is required for install, service worker and push). English and Hebrew, full RTL, for both the interface and item names.

**Core idea:** the **item bank** (every item ever added or bought, with its category) is the heart of the app. Lists are views into it. That is what makes duplicate prevention, categories, store ordering, purchase history, prices and future suggestions work.

## 2. Decisions and constraints (do not reopen without the owner)

**Structure and roles**
- A **household** owns the item bank, categories, stores and purchase history. A user can belong to several households. Lists are *whole household* or *private* (chosen members).
- List roles: **Owner**, **Editor** (`contributor`) and **Shopper** (`viewer`: sees only Shop and List history). Invites by link or code (household scope only).
- Registration mode (admin): open, **invite-only (default)**, admin-only. Password reset by email when SMTP is set, otherwise an admin **one-time password** (forced change). Revocable long-lived sessions, "My devices".
- Ordering of lists and households is **personal per user**. Category order and stores are shared by the household. Anything configurable belongs in the admin panel.

**List behaviour**
- Three tabs per list: **Shop** (passive: search, tick with a checkmark, Undo, Finish trip, store picker), **Manage list** (active: add items, add from past items, drag and drop, categories, stores, people, CSV, rename or delete) and **List history**.
- **Duplicate prevention** (English and Hebrew): normalisation (case, plurals, niqqud, final letters, Hebrew article, typos). An exact normalised match is reused silently; a near-miss asks "did you mean...?".
- Quantity defaults to 1. The UI has no "unit" field (the column is kept). "Show who added" is a per-user toggle, off by default.
- **Prices are stored per purchase** (unit price and line total) and never rewritten by later price changes. The item also keeps a "last paid" price. **Currency is a personal setting**, auto-detected from timezone then browser language. Each trip stores the currency it was recorded in. No conversion.
- **List history is open to every user on the list**: view, correct prices and totals, add receipt photos, restore trips.
- **Receipt OCR:** local Tesseract first (English and Hebrew). Cloud (Anthropic, OpenAI or Google) only if a user saves their **own API key** (stored encrypted, never shown). A review screen is mandatory before anything is saved. The admin can switch scanning off.
- **CSV:** item-bank export and import (backup, restore, or move items between lists and households; a quantity column adds items to the current list; preview before applying; fuzzy matching; formula-injection guard). Purchase-history export (UTC timestamps, receipt total once per trip, private-list purchases only for people who can see them).
- Smart suggestions: **groundwork only** (purchase and suggestion events are logged; a seasonal tag column exists).
- Input must not depend on device-specific APIs (typing, dictation, camera through a standard file input).

**History and price comparison (decided while planning 1.1)**
- **History lines can be corrected or deleted, but only from the edit panel.** The ✎ button opens quantity, unit price and line total (for bad OCR or missing prices) and a **Delete this line** button that asks for confirmation; there is no delete control on the row itself, so it cannot be hit by accident. (1.1.0 had removed deletion entirely; the owner asked for it back in 1.1.1.) Receipt photos can also be deleted. Restore puts back the **purchased** quantities; the list is then edited in Manage list as usual.
- Each history line is **one row**: tick, name (ellipsis; tap to read it all), quantity, unit price, line total, and a pencil that opens the correction panel.
- **Price comparison:** no schedule and no external AI. The server fetches public retailer price files itself. Each list has a set of chains (and later branches) to compare, chosen in **Manage list > Compare prices** (Editors and Owners), remembered for the list, with as many chains and branches as wanted. The **Compare prices** tab is visible to everyone on the list including Shoppers. It shows an **estimated total and a coverage index** ("18 of 21 items priced") per chain; tapping a row expands the items that chain does not carry, so the user can split the shop. Ranking: most items priced first, then cheapest. No promotions, club prices, travel cost, geolocation or extra chains for now.
- **Refresh policy (for 1.3.0):** lazy daily refresh. The first comparison of the day fetches fresh prices for the **selected chains and branches only**; everyone then uses that cache for the day; a **Refresh prices** button forces an update. Nothing is downloaded on days when nobody asks. The admin sets the cache duration.
- Shown only to users whose currency is the shekel, and only while the admin setting `compare_enabled` is on.

**Technical choices**
- Backend: Node 22, Fastify 4, SQLite (better-sqlite3, WAL), plain JS ES modules, scrypt, nodemailer. API writes need the header `X-SL-Client: web`.
- Frontend: React 18, Vite 5, TypeScript (strict), vite-plugin-pwa, dnd-kit. All text lives in `web/src/i18n.ts`, typed so both languages must match.
- Docker: three-stage build; the final image installs Tesseract (eng, heb). The entrypoint chowns `/data` and then drops to user `node`. `HOST_PORT` sets the host port.
- Design: price-tag brand (deep green, signal yellow), logical CSS for RTL, system fonts (works offline).

## 3. Current status

**Latest build:** 1.2.1 (`server/package.json` and `web/package.json` must always carry the same version; the app compares them and shows an "Update now" banner when a device still runs old files).

| Build | Contents |
|---|---|
| 1 | Docker, full schema, first-run admin, login, registration modes, invites, reset or one-time passwords, devices, admin panel (users, settings, SMTP, audit log), PWA shell, EN/HE |
| 2 | Lists, item bank, categories, duplicate-aware add |
| 3 | Shop mode, Undo, Finish trip, purchase events, stores, drag and drop, list roles |
| 3.1 | Households UI (create, members, invites, reorder), one-line past items, item editor (name, category, default note, price) |
| 3.2 | Total and receipt photo at Finish trip, List history, restore, receipt OCR (local and cloud), CSV import and export, currency |
| 1.0.0 | (internal build 3.2.1) Version stamp in Settings, stale-app banner with clean update, `update.sh`, GitHub image publishing, repo files |
| 1.1.0 | One-row history lines with a correction panel; **Compare prices** tab and per-list chain selection (own receipt prices only; live prices come in 1.2.0); stores can be linked to a chain; admin switch `compare_enabled`; migration 5 |
| 1.1.1 | Delete returns, inside the history line's edit panel with a confirmation |
| 1.2.0 | **Supermarket portals, no prices yet:** portal clients for the three real portal types (Shufersal, the shared publishedprices portal, Carrefour) covering twelve chains (Stop Market first); a shared branch directory read from each chain's Stores file; city, chain and branch pickers in Manage list; admin **Portals** screen (test each chain, save raw files, switch chains off, add a chain by portal username); migration 6 |

**Repository layout**
```
server/src/   db.js (migrations 1-6)  util.js  auth.js  access.js  match.js  ocr.js  csv.js  secrets.js  entries.js  mail.js  chains.js  portals/ (decode xml units http clients cities directory diagnostics)
              routes/  auth  admin  lists  shopping  households  history  itemsCsv  compare  portals
server/test/  node:test suites + fixtures with real Tesseract output
web/src/      App Auth Home HouseholdScreen ListView ShopTab ManageTab HistoryTab CompareTab CompareSettings AdminPortals Settings Admin Menu VersionGuard
              dnd i18n money imaging types util
e2e/          e2e.py (real browser, real OCR)  make_receipts.py  upgrade_rehearsal.py
tests/        test-update.sh (tests update.sh against a fake docker)
docs/         HANDOFF.md (this file)
update.sh  Dockerfile  docker-entrypoint.sh  docker-compose.yml  .env.example  README.md
```
**Data folder `/data` (host `./data`):** `shoplist.db`, `receipts/<household>/*.jpg`, `secret.key`. Back up all of it together; a database restored without its `secret.key` cannot decrypt saved API keys.

**Environment:** `PORT`, `DATA_DIR`, `WEB_DIR`, `OCR_LANGS` (container); `HOST_PORT`, `TZ` (compose, via `.env`).

**Verified:** 66 backend tests (including the three portal protocols against a local fake, `server/test/fakePortals.js`, with trimmed real price files as fixtures); 84 real-browser checks (Chromium, phone viewport, timezone Asia/Jerusalem) including drag and drop, Hebrew RTL, CSV round trips and a photographed receipt read by real Tesseract, one-row history lines in English and Hebrew, deleting a line from its edit panel, the compare flow with the city, chain and branch pickers, and the admin Portals screen; a database upgrade from 1.0.0 (schema 4) to 1.2.0 (schema 6) keeps existing data; `update.sh` (26 checks against a real git remote and a fake docker: update, rollback, failed build, unhealthy start, dirty tree, tags, dry run).

**Not verified:** **any live portal** (the development sandbox cannot reach the retailer portals; the owner ran the Portals test live for Stop Market and Rami Levy, see below), the real Stores files of Shufersal, Rami Levy and Carrefour (only Stop Market's real Stores file was seen), the real data.gov.il city list; the real Docker build and a real container start (no Docker in the development sandbox); touch drag, camera capture and HEIC photos on real phones; OCR on real, crumpled receipts (only generated ones); cloud OCR against the live providers (tested only with a simulated network); the SMTP reset email against a real mail server; `update.sh` against a real Docker.

**Known limits:** lists refresh by polling every 10 s (no live sync); no offline queue; no push notifications; colour themes and list images are stored but have no UI; per-item store overrides, single-list guest invites and smart suggestions are not built; Hebrew stemming is rule based; no admin backup or restore screen.

## 4. Working with GitHub and the server

**Repository:** private. Keep `main` deployable; work on branches and merge through pull requests; use GitHub Issues for the backlog in section 5; tag releases `vX.Y.Z`.

**Never commit:** `data/`, `backups/`, `.env`, `node_modules`, `dist` (all in `.gitignore`). `data/` holds the database, receipt photos and `secret.key`.

**First install on the server**
```
git clone git@github.com:YOUR-USER/shoplist.git && cd shoplist
cp .env.example .env            # set HOST_PORT (and TZ); .env is not in git
docker compose up -d --build
```
Create the admin account in the browser on first visit.

**Upgrade**
```
./update.sh --dry-run           # optional: see the plan
./update.sh                     # newest commit of main
./update.sh --tag v3.3.0        # or an exact release
./update.sh --rollback          # undo the last update (code and data)
```
`update.sh` builds the new version while the old one keeps serving, stops the app, backs up `data/` to `backups/` (keeps the newest 10), starts the new version, checks that it reports the expected version, and **rolls back automatically** if it does not. A failed build leaves the old version running. If you upgrade by hand instead, read the build output: when `docker compose up -d --build` fails, compose keeps the OLD container running.

**Release checklist**
1. Set the version with `scripts/set-version.sh X.Y.Z` (updates both `package.json` files and their lockfiles; they must match).
2. `cd server && npm test`; `cd web && npm run build`; `bash tests/test-update.sh`; run `e2e/make_receipts.py` then `e2e/e2e.py` against a fresh data directory.
3. Update this file (sections 3 and 5) and `README.md`.
4. Commit, tag and push: `git commit -am "Release vX.Y.Z" && git tag -a vX.Y.Z -m "vX.Y.Z" && git push && git push --tags`. The tag triggers `.github/workflows/release-image.yml`, which tests the code and publishes `ghcr.io/<user>/<repo>:X.Y.Z` (see README, "Run the published image").

**Sandbox tips (for assistants):** `/bin/sh` has no brace expansion; background processes die when a tool call ends, so start the server and run the test in one call; `pkill -f` can kill its own shell.

## 5. What is left to do

### 5.1 Requested, not started

**A. History tab: one row per purchased line.** *Done in 1.1.0* (see section 2).

**B. Add a trip that was not made from a list** *(medium)*
In List history, a button such as "Add a trip I made without a list" for shopping done on the spot.
- Flow: choose date and time (default now) and an optional store, then either **scan or attach a receipt** (reuses the existing OCR and review screen) or **type the lines** (item with bank typeahead, quantity, price), plus an optional total and currency. Saving creates a finished trip with purchase lines and any new bank items, and it appears in History flagged as unplanned.
- It counts for prices, CSV export and restore like any other trip.
- Data: a `trips.unplanned` flag (migration 6). API: `POST /api/lists/:id/trips`. Decide whether a whole trip may be deleted (single lines can be).
- To confirm: attach it to the current list (proposed), or to the household as "other purchases"? Should any trip, planned or not, be deletable?

**C. Supermarket price comparison** *(large; phased; scope decided with the owner, see section 2)*

*Done in 1.1.0:* the **Compare prices** tab (everyone on the list), the compare API, admin switch `compare_enabled`, migration 5 (`stores.chain`, `list_compare_stores`). Estimates come from the **last price paid at household stores linked to each chain** (shekel trips only, private lists respected), with coverage and the list of missing items.

*Done in 1.2.0 (portals, no prices):*
- **Portal clients** (`server/src/portals/clients.js`), behaviour ported from the il-supermarket-compare plugin: Shufersal (`FileObject/UpdateCategory?catID=5` Stores, `catID=2&storeId=` PriceFull, links read from the HTML), the shared portal (csrf login with the chain's public username and an empty password, session cookie set on a redirect, `file/json/dir` search, `file/d/<name>` download, branch matched by `-<id padded to 3>-` in the file name), and Carrefour (`const path = '...'` and `"name":"..."` entries in the home page). Only names starting `PriceFull` are ever used; `Price` update files are ignored. Zip archives are not supported (neither is it in the plugin).
- **Deviations from the plugin, on purpose:** the newest file is chosen by the date **and** time in the name (the plugin sorts by time of day only); a failed shared-portal login is detected by the redirect back to /login; sub-chain comes from the parent `SubChain` element; `ManufactureName` is the real tag; Stores files in UTF-16 are decoded by BOM; a chain that writes the city as a **name** (not a code) is mapped to the government code when the name matches, so one city never appears twice in the picker; geocoding is dropped (city picker instead).
- **Registry** `server/src/chains.js`: twelve chains with stable app ids and portal usernames (stop_market first, shufersal, rami_levy, carrefour, osher_ad, yochananof, tiv_taam, keshet_teamim, dor_alon, freshmarket, salach_dabach, politzer); `victory` and `hazi_hinam` are listed as not supported yet; admins can add a chain by portal username (experimental, id `custom_<username>`) and switch any chain on or off.
- **Branch directory** (`directory.js`, migration 6 `portal_branches`): read from each chain's Stores file, replaced per chain, shared by all households. Pharmacies (`BE`) and online/URL entries are dropped; the banner of Shufersal and Carrefour (first word of the store name) is kept; the city is stored as a numeric locality code (or the name when it cannot be mapped). City names come from data.gov.il (resource `5c78e9fa-c2e2-4771-93ff-7f400a12f7ba`, reloaded when older than 30 days) with a small built-in seed of big cities. **Lazy:** the first picker visit starts a background job (one at a time, chains one after another with a short delay); a directory younger than the admin setting `branch_cache_days` (default 7) is reused; a failing chain is retried at most hourly; one failing chain never stops the others.
- **API:** `GET /api/portals/cities`, `GET /api/portals/branches?cities=&chains=` (any signed-in user); `PUT /api/lists/:id/compare/stores` takes `{selection:[{chain, branchId?}], cities?}` (a chosen branch keeps its chain selected; unknown or unsupported choices are refused); the compare result stays **one row per chain** with its chosen branches listed. Admin: `GET/PUT /api/admin/portals`, `POST /api/admin/portals/refresh`, `POST /api/admin/portals/:chain/test` (login, Stores, PriceFull list, dry-run parse; optional `save` keeps the raw files under `/data/portal-samples/`), sample download and delete, custom chains.
- **UI:** Manage list > Compare prices: cities (searchable check list built from the directory, chips), chains (check list, unsupported ones greyed), then one panel per chosen chain with its branches in the chosen cities (grouped by banner, "Select all" per group); **Settings > Supermarket portals** (everyone): per-chain status, Reload branches, Test report; admins also get the on/off switch, "Keep the raw files" with downloads, and add chain by username.
- **Testing without the portals:** `server/test/fakePortals.js` imitates the three protocols and the city list and serves trimmed real price files (`server/test/fixtures/portal/`); it also runs standalone (`node server/test/fakePortals.js <port>`) and the app can be pointed at it with `PORTAL_URL_SHUFERSAL`, `PORTAL_URL_SHARED`, `PORTAL_URL_CARREFOUR` and `PORTAL_CITIES_URL` (the browser test does this; see its header).

*Done in 1.2.1, and what the first live tests showed (Sat 7 Nov 2026, run by the owner on the real portals):*
- **Stop Market:** login, Stores and PriceFull all work. Stores file is plain XML in UTF-16 LE with BOM, 11 branches, 8 cities (numeric codes), 10 with a ZIP; PriceFull of branch 002: 15,254 items, 527 weighted, 15,025 barcodes, 229 internal codes, no duplicates or bad prices; unit spellings include `Unknown` (18) and `לא מנהל יחידת מידה` (2). The shared portal's file listing rows have the fields `DT_RowId, fname, ftime, icon, name, size, time, type, typeLabel, value`; `time` is an ISO UTC string. Stop Market publishes its Stores file daily and keeps three days.
- **Rami Levy:** Stores file (38 KB, UTF-16 LE with BOM) has 99 branches, 54 cities (numeric codes), 56 with a ZIP; ChainName is `רמי לוי שיווק השקמה`. PriceFull files are 0.5 to 1.1 MB, published around 18:00 for many branches; branch 036: 14,506 items, 650 weighted, all barcodes, 4 deposit lines. New unit spellings: `1` (5, ambiguous, still flagged), `לא ידוע`, `100 קילוגרם`, `2 יחידות`, `גרם`, `100 ס"מ`.
- **Bug found by that run (also present in the reference plugin):** the plugin looks for `-<store>-` anywhere in a file name, but every Rami Levy name carries `-001-` as its **sub-chain** segment, so asking for store 1 picked another branch's file (036). Fixed: `storeOfName()` reads the store segment of `PriceFull<chain>-<sub>-<store>-<date>-<time>` and compares it numerically. Tested with a fake that has both branches.
- **Units:** literal spellings added (`גרם`, `100 קילוגרם`, `2 יחידות`, `100 ס"מ`); `Unknown`, `לא ידוע`, `לא מנהל יחידת מידה` count as **no unit given** (reported separately, not as unknown spellings); a bare `1` stays unknown.
- **Portals for everyone:** `GET /api/portals/status`, `POST /api/portals/refresh`, `POST /api/portals/:chain/test` need only a signed-in user. Non-admins are rate limited (a reload per scope every 5 minutes, a test per chain every minute; HTTP 429 `try_later`) and cannot keep raw files; internal portal addresses stay admin-only. Admin-only: `/api/admin/portals` (overview with samples), switching chains, custom chains, sample download and delete.
- **Per-list cities (already so since 1.2.0):** cities, chains and branches are stored **per list** (`list_compare_cities`, `list_compare_stores`), so a list for one city and another for a different city are independent. Editors set them in Manage list > Compare prices or in the Compare prices tab ("Change cities and branches"); Shoppers see the summary.
- **Phones:** a `useNarrow()` media query (640 px) swaps the secondary tabs for `TabMenu`; wide screens keep the full tab row.

**1.3.0 plan (prices and matching), unchanged from the owner's decisions in section 2:**
1. Download and parse `PriceFull` for the selected branches only (Shufersal, Rami Levy, Stop Market and Carrefour formats are verified on real files: UTF-8 with BOM, 17 item fields, identical across chains; unit spellings in `portals/units.js`). Keep the latest file per branch; completeness check against the previous item count; freshness label from the file name.
2. Lazy daily refresh plus a **Refresh prices** button, as a background job with progress (Cloudflare cuts requests near 100 s), shared across households. Tables (migration 7): branch prices (latest file only), fetch log, `product_map` (household, item, chain, code, status). Item B (unplanned trips) moves to migration 8.
3. **Matching without AI:** candidate ranker working on words (names are abbreviated and in different word order), one-time confirmation per household, item and chain; a confirmed barcode (`ItemType 1`) is auto-proposed at other chains; weighted items (`bIsWeighted=1`, price per kg) ask once how much "1" means; internal-code items (`ItemType 0`) are confirmed per chain; exclude deposits, frozen, pickled, pet food by default.
4. Compare rows then show total, coverage, expandable missing items, per-unit price (`UnitOfMeasurePrice`) and "prices from 7 Nov, 05:10"; receipt prices remain a labelled fallback.

### 5.2 Planned earlier, not started
1. **Stage 4: live sync and offline.** Server-sent events or WebSocket updates; an offline queue for ticking and edits, including queued photo uploads. Nginx Proxy Manager needs WebSocket support turned on.
2. **Web push and "list is full" alerts** (per user: item threshold, weekdays, time; iPhone needs the app installed to the home screen).
3. **Smart suggestions** from the logged purchase events (interval based, plus holiday or seasonal such as matzah).
4. **Themes and list images UI** (colour theme column and list image column exist).
5. **Per-item store overrides** (bread sits elsewhere in one store).
6. **Single-list guest invites** (a guest sees only that list).
7. **Admin backup and restore screen**, and data export.
8. **Usage and spending views** (charts from purchase history, budget).

### 5.3 Validation and housekeeping
1. Deploy 1.1.0 and use it on real phones: touch drag and drop, camera capture, HEIC photos, Hebrew screens.
2. OCR on real receipts; try one cloud key from each provider you intend to use.
3. A real SMTP test of the reset email.
4. Run `update.sh` once on the real server (use `--dry-run` first).
5. Create the GitHub repository, push, and add continuous checks (backend tests and web build on each push). Optionally publish a Docker image on each tag so the server pulls instead of building.
6. A native Hebrew speaker should review `i18n.ts`; an accessibility pass.

### 5.4 Open questions
1. Item B: attach an unplanned trip to the current list or the household? May a whole trip be deleted (single lines can be)?
2. 1.3.0: after the owner's live runs of Settings > Supermarket portals: which chains work from the server, what the real Stores files of Shufersal, Rami Levy and Carrefour contain (city as code or name, ZIP filled?), and the raw samples saved by the test; confirm the admin cache duration default (24 h).
3. Order of work. Suggested: real-world feedback on 1.1.0, then **1.3.0 live prices**, then **item B**, then **Stage 4** (live sync and offline).

## 6. How to resume

1. Give the assistant this file and the repository (or `shoplist-1_2_1.zip`).
2. Check the build: `cd server && npm install && npm test` (49 tests); `cd web && npm install && npm run build`; `bash tests/test-update.sh`.
3. Settle section 5.4, then build. Each stage ends with backend tests, an updated `e2e/e2e.py`, an updated README and this file, a version bump, and a tag.
