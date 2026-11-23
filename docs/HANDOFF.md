# Shopping List PWA: handoff v14 (23 Nov 2026)

For a fresh chat. Replaces all earlier handoffs. Save as `docs/HANDOFF.md`. Give the new chat this file and `shoplist-1_8_2.zip` (the modules are inside it under `modules/`). The code is the source of truth for structure, APIs, schemas and test lists; this file keeps what the code cannot tell you: decisions and their reasons, traps, status, open questions.

## 1. Status

- **Current: 1.8.2** (core 1.8.2, a CSS fix: the ☰ menu items inherited the dark top bar's light text and were unreadable on the white panel in light mode; they now use `var(--text)`. Checked in light and dark at desktop width; `barcode-scan` 1.2.0, `lang-he` 1.3.4, `price-compare` 1.5.1, `receipt-ocr` 1.0.1). Built and tested in the sandbox, **not yet seen on the owner's phone or server**.
- **Verified in the sandbox:** 172 backend tests (156 before, 16 new: `server/test/adminHouseholds.test.js` for 1.8.1 and `modules/barcode-scan/test/scan180.test.js`, `server/test/core180.test.js`); browser suites 15 (`e2e_admin.py`, new in 1.8.1) + 135 (`e2e.py`, 5 new) + 24 (`e2e_scan.py`, 4 new for edit/Wrong item, 3 for Add a trip) + 8 (`e2e_match.py`) + 33 (`e2e_mobile.py`); `tests/test-update.sh` 25; both `tsc` runs clean. One run of `e2e.py` had a timing flake in "Compare now reports what it did" (price-compare, untouched; passed on rerun with a fresh data folder).
- **1.8.1 (Admin → Households), built after 1.8.0:** a Households tab (every household with members, roles, counts; open one to rename, add a user with a role, change a role, remove a user, delete) and a Households section on each user's card (add to, change role, remove). New server parts: `GET /api/admin/households` (rich), `POST /api/admin/households` (create for a chosen owner), `role` accepted when adding a member, `householdList` on `/api/admin/users`. **Everything else already existed:** an admin could always manage any household through `households.js` (`isOwner` lets the admin through). Delete asks for the household name and the warning shows the counts. A test deletes a populated household and checks every table with a `household_id`, every table with a `list_id`, the receipt photo folder and the barcode module's rows are empty, and that a second household is untouched. Not recorded and so not shown: who created a household (no column; only creation date and current owners). Admin who is not a member of a household cannot create a list in it (test setup had to work around this).
- **What 1.8.0 contains:**
  1. Automatic category for scanned items, in `barcode-scan` (`server/categories.js`): the category of the similar household item, else the last one used for the same manufacturer (stored from now on, migration 2), else the most used one among items sharing a word, else a built-in English/Hebrew keyword table, else none. Only the household's own categories are used (never created). The result panel says how it was chosen.
  2. An edit icon on every scan result: name, category, and **Wrong item** (search the household's items or make a new one; the barcode is moved, the wrong scan is reversed, the right item gets the scan).
  3. Add a trip: **Add item** (by hand, as before), **Scan** (`trip.toolbar` slot; lookup only), **Read receipt photo** (reads into the rows, attaches the photo on save). Nothing is saved before **Save trip**.
  4. The items CSV carries barcodes through the new `item-csv-columns` capability; a barcode in the file always wins.
- **Next: nothing agreed.** Ask the owner after real use. Candidates are in section 8.
- **Parked by the owner:** the Shop-tab store selector versus store names showing up as item categories somewhere. The owner will describe it. Change nothing for it until they give the exact place and a screenshot. (They also mentioned a second correction to the mockups and then said to leave it: ask again if it comes up.)

## 2. The owner

Settles a plan before code ("review before pursuing"; mockups first for UI). Dictates, so expect typos. Wants honesty about what is verified. **Ask at most one question per answer.** Likes short bullet summaries and checks details. Wants everything deterministic and local; no cloud AI at runtime except an optional key of their own. English interface first; Hebrew and right-to-left are supported for *content* and as a language module. Runs the app on their own server (Docker behind Nginx Proxy Manager and Cloudflare): **treat the database as real; only append migrations, never edit one.**

## 3. Decisions to keep (the "why")

**Data model**
- A **household** owns the item bank (name, category, default note, saved price), categories, stores, purchase history. **Lists** are whole-household or private. Roles per list: Owner, Editor, Shopper (no Manage tab). Duplicate prevention uses English and Hebrew normalisation: an exact normalised name reuses the item, a near-miss asks "did you mean…".
- **Past items are per list** (`list_items`), but the item record and its price matches are shared by the household. **Every code path that puts an item on a list or records a purchase for it must call `rememberForList`** (`server/src/entries.js`). 1.4.3 broke by missing the CSV import and the receipt review; later writers (trips, `scanItem`) follow the rule. When changing how data is linked, grep every writer. No cross-list repair of past items (decision): re-import the CSV into the intended list.
- Prices are stored per purchase; currency is a personal setting; no conversion. Deleting a trip leaves the item's saved price as it is (owner's decision). Price estimates in Shop: personal switch, admin default.
- Receipt OCR: local Tesseract first, cloud only with the person's own key (stored encrypted); the review screen is mandatory. History is open to everyone on the list.

**Scanning (`barcode-scan`)**
- Scanning an item not on the list while shopping adds it **already ticked**; an item on the list is ticked; an unknown barcode asks for a name once; the scan saves the product's price as the item's saved price (not per-kilo prices); a matched barcode is remembered. A repeated scan of an item already in the cart adds 1 (my choice, not asked).
- A barcode points at the *item*, not its name. **Edit name** renames the household item everywhere (a name another item has is refused, no merging).
- **Edit and Wrong item (1.8.0):** the barcode is remembered per household and points at an *item*. Wrong item sends back what the scan returned (`scan`: item, entry, action, created, previous and saved price); the core's `reverseScan` undoes it only while the entry is still as the scan left it, deletes an item the scan itself created (emits `item.deleted`) and puts the old saved price back. If the entry changed meanwhile, nothing is undone but the barcode still moves. Owner's decision: **reverse the wrong scan**.
- **Categories (1.8.0):** the keyword table lives in `barcode-scan`, not the core (owner's decision). A scan never replaces a category an item already has; the person changes it in the edit panel.
- **CSV (1.8.0):** the core CSV stays generic. Module data goes through `item-csv-columns` (export columns, a preview `plan`, an `apply` after the core transaction). Owner's decision: **always trust the CSV** for barcode links (the preview lists each barcode that moves from another item). Category, note and price already round-tripped.
- **Add a trip (1.8.0):** Scan and Read receipt photo only fill rows; the existing Save trip is the review. `POST /api/lists/:id/receipt-read` reads a photo through `receipt-reader` and saves nothing (temporary file deleted). A trip line may carry `categoryId` for an item it creates.
- Modal dialogs from modules must be drawn with `host.createPortal`: the Scan button sits inside the Add `<form>`, and a dialog inside it submitted that form (page reloaded to Home). React events still bubble through a portal, so the dialog root stops `submit`.

**Matching (`price-compare`)**
- Matching should be automatic; where it is not certain the best candidate is **pre-filled and accepted with one tap**, never applied by itself. A user's own choice always wins. Only an exact name match (one product) is applied by itself (`auto`, via name) and spreads its barcode to other chains.
- English item names find Hebrew products: dictionary first (`lexicon.js`), then an optional AI when the person saved a key; only the names are sent, once each. An English name is never better than a guess.
- All of it lives inside `price-compare`; the core only offers read helpers. **Renaming an item drops its by-name matches** (core event `item.renamed`), otherwise the old product's price sticks.

**Navigation and layout (1.7.x)**
- A list is a slim header (back, name, ☰), the open tab, and **the tabs as a bar at the bottom edge on a phone** (same element is a row of pills at the top above 640px; hides while the on-screen keyboard is up). More than four tabs on a phone: first three plus "More".
- **☰ (`Menu.tsx`)** is a bottom sheet on a phone. In a list: "This list" (List name, People, Stores, each module `manage.section` such as Compare prices, Categories, Backup and move items, red Delete list for the owner) and an account group (Settings, Admin for admins, Sign out). Each entry opens as its own page replacing the tabs, with a back arrow. Home has the same ☰; Settings and Admin keep a slim top bar with it. The old Home/Settings/Admin nav buttons and the "Manage list layout" setting are gone (prefs `manageOrder` and `manageOpen` remain in storage, unused).
- **Manage list** = Add row (one line until you type, then category/quantity/note), a two-button switch **Past items | On the list · n**, then that view. Past-item rows are one line with a **+**; a tap opens quantity, note for this trip, edit, remove.
- Module tabs get a generic icon and their `title()` as label (Compare prices uses a smaller font to fit).

## 4. Traps and rules

- **Version rule (a test enforces it):** changing *any* file a module ships, translations included, needs a version bump in its `manifest.json` and `node scripts/module-lock.mjs`. Installed modules upgrade only to a higher version and browsers cache per version. Never ship changed files under an unchanged version (it broke Hebrew upgrades once).
- A module that needs a newer core says so in `requires.core` (`price-compare` 1.5.1 needs core ≥1.7.1 for `item.renamed`; `barcode-scan` 1.1.0 needs ≥1.7.0 for `createPortal` and `renameItem`).
- **The Compare tab exists only for users whose currency is ILS** (detected from the timezone). Browser tests must use timezone `Asia/Jerusalem`, or the tab is missing and checks that count tabs fail.
- Modules: `docs/MODULES.md`. Two parallel branches both numbered 1.7.0 were merged as 1.7.1 by three-way merge; the only real clash was the rename/by-name interaction above.

- **New in 1.8.0:** `barcode-scan` 1.2.0 needs core ≥1.8.0 (`reverseScan`, `setItemCategory`, `listCategories`, `householdItems`, `categoryId` on `scanItem`, the `item-csv-columns` capability, the `trip.toolbar` slot). A module cannot use a slot the core's `SLOTS` list (`server/src/modules/manifest.js`) does not name.
- Old scan results in the panel keep working: Rename was replaced by the edit icon (`Edit this item`); `e2e_scan.py` was updated for it.

## 5. Working in the sandbox

- Run recipes are in the headers of the `e2e/*.py` scripts and `docs/DEVELOPMENT.md`. Each browser test hard-codes its port and data folder and needs a **fresh data folder each run**: `e2e.py` 3998 `/tmp/e2e-data` (plus `fakePortals.js` on 4999), `e2e_scan.py` 3997 `/tmp/scan-data`, `e2e_admin.py` 3994 `/tmp/admin-data`, `e2e_match.py` 3996 `/tmp/match-data`, `e2e_mobile.py` 3995 `/tmp/mobile-data`. Build first (`npm run build` in `web`, `node scripts/build-modules.mjs`).
- Start a server and its test in **one shell call**, `setsid nohup node … & echo $! > pidfile`, stop with `kill $(cat pidfile)`. Never `pkill -f` (it can kill its own shell); `fuser` is not installed. Long runs: start in the background and poll. `/bin/sh` has no brace expansion; `cut -c` can split Hebrew characters.
- `npm ci` without `--silent`; check that `node_modules` exists afterwards.
- API writes need the header `X-SL-Client: web` (easy to forget when scripting against the API with Playwright's request context).
- `e2e.py` navigation helpers: `menu_go` (burger menu), `to_lists`, `tab`, `manage`, `show`, `entry_names`. A page of the ☰ menu has a back arrow, not a ☰: go back before opening another page.
- `auto-real.test.js` uses trimmed copies of the owner's real price files (fixtures in the repo; the builder script needs private files and was not kept).

## 6. What real data taught us (not in the code)

- Price files carry **no categories and no notes**. `ItemName` is cut at 20 characters at Stop Market and Rami Levy; the longer chain name is in `ManufactureItemDescription` (stored as `branch_prices.description` since 1.7.0).
- On the owner's lists (Stop Market, Rami Levy, Carrefour, Shufersal files of 11 Nov 2026) the right product ranked first for 95% of known items (84% before the description was used). The English dictionary was written with part of that sample in view, so accuracy on unseen lists may be lower: extend `lexicon.js` when real misses show up. About 33 ms per item per chain; a first run for 300 items on four chains takes ~25 s in the background.
- Live portal tests passed for Stop Market and Rami Levy on the owner's server; **Shufersal and Carrefour live output was never seen** (formats come from real fixtures).

## 7. Not verified

A real phone camera (focus, glare, speed on an older iPhone; if slow, swap the JS reader for WebAssembly behind `decode` in `decode.ts`); real barcode coverage per chain in the price files; the keyboard-hides-tab-bar rule and iOS safe area; the "More" overflow with a fifth tab; widths between 641 and 900px; **Hebrew layout of the new edit panel, Wrong item panel and Add a trip buttons on a real device**; a real AI provider call (only a fake provider was tested); very large households.
**1.8.0 specifically:** Excel opening and re-saving the exported barcode column (13-digit numbers may be shown as 7.29E+12 and saved that way; an invalid code on import is ignored; the preview now says how many barcodes move, per row, but it does not list invalid codes); how good the automatic categories are on real products (only a hand-made table and the owner's real price names were considered; extend `categories.js` when misses show up); real receipt photos in Add a trip (tested with the generated English receipt and the real Tesseract only); **1.8.1 specifically:** Hebrew layout of the Admin households screens on a real device; deleting a household on the owner's real server (the cleanup was proven on test data only: take a backup first); a very large household. A barcode scanned in Add a trip for a *new* item is not remembered for that barcode (the item does not exist until the trip is saved); the same product scanned twice in a trip is two rows.

## 8. Open questions and backlog

- **Questions for the owner:** estimates for a store with no receipts (show nothing, as now, or the last price from another store marked less exact?); after real use, which automatic matches were wrong, to tune the matcher.
- **Small ideas:** name a new scanned item from the full description, not the 20-character `ItemName`; List name page can only rename and delete (no colour or visibility change after creation); People count in the menu; remember the Past/On the list choice per list; a short label for module tabs; undo of a scan, torch button, offline scan queue; learn from accepted matches; undo for "Accept all"; merge the same product scanned twice in Add a trip into one row with quantity 2; remember a barcode for an item that a trip creates; FTS index for matching.
- **Backlog:** live sync and offline queue; web push; smart suggestions; list images/themes; per-item store overrides; guest invites; admin backup/restore; usage views; first real Docker build; Victory and Hazi Hinam portals (unknown portal/username).

## 9. Release routine

1. Change a module → bump its version and run `node scripts/module-lock.mjs`. 2. `bash scripts/set-version.sh X.Y.Z`. 3. Run all suites. 4. Update this file (status; decisions only if they changed). README changes only for features worth showing on the GitHub page. 5. Zip as `shoplist-X_Y_Z.zip` without `node_modules`, `dist`, `dist-modules`, `data`, `.git`, built `modules/*/web.js`; module zips come from `build-modules.mjs`. 6. `git commit`, tag `vX.Y.Z`, push (the tag builds the image).

**Release history:** 1.3.0 module system, 1.3.1 Hebrew as a module, 1.4.x prices, matching, per-list past items (migration 9), 1.4.5 past-items linking fix, 1.5.0 trips by hand, 1.6.0 barcode scanning, 1.7.0–1.7.1 automatic matching and scanner rename/Manage fix (merged), 1.7.2 phone layout, 1.7.3 separate Past/On the list buttons, **1.8.0 automatic categories, edit and Wrong item on scan results, Scan and receipt photo in Add a trip, barcodes in the items CSV**, **1.8.1 Admin households and per-user households**.
