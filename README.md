# Shopping list PWA

Self-hosted, multi-user household shopping list. One Docker container serves both the API and the installable web app.

**Version 1.4.4 (core).** Housekeeping: the Hebrew language module is now **1.1.0** (it had gained strings in several releases while still labelled 1.0.0, so an installed copy would not have upgraded) and receipt reading is **1.0.1**. A new check, `server/test/modulelock.test.js` with `modules/versions.lock.json` and `scripts/module-lock.mjs`, fails whenever a module's files change without a new version.

**Version 1.4.3 (core; migration 9).** *Past items are per list:* a list's "Add from past items" shows only the items that list has had, so a new list starts empty and a household with several lists (one per supermarket, say) keeps each list's history apart. The item itself (name, category, note, saved price and its **price-comparison matches**) is still one record per household: adding "Milk" to a second list reuses it, so nothing has to be matched twice. Existing lists keep every item they ever had. *Several at once:* **Select** in Past items shows a checkbox per item; **Select all** (or tick some) and **Remove (n)** takes them out of this list's past items in one step, after one confirmation. Items on the list right now cannot be removed, and removing never touches other lists. *Price estimates in the Shop tab:* each item with a known price shows "≈ ₪12.90" (price x quantity) and the list shows an **estimated total** with how many items are priced. The price is the last one paid at the store chosen in the order selector (or anywhere when "By category" is chosen), from your own receipts, falling back to the price saved on the item. A switch in **Settings > Price estimates** turns it off for you; the admin sets the default in Admin > Server settings, and "Use the default" returns to it.

**Version 1.4.2 (core) with price-compare 1.3.0: Add items autocomplete from the stores.** While you type in *Add items*, a second group "From the stores" lists the products the chosen supermarket branches sell (ranked by words, one row per barcode, with the price or price range and the chains that sell it). Picking one fills in the name, a note (brand and pack size) and, when you already have a similar item, its category; you still set the quantity and press Add. Adding it also records the product as the confirmed match for the item, so the Compare tab prices it at once. Price files contain no category or notes, which is why the category comes from your own similar item. Without the price-comparison module (or with it switched off, or no price data yet) the form works exactly as before. A new capability, `item-catalog`, lets any module offer suggestions the same way (see `docs/MODULES.md`).

**Version 1.4.1 (core) with price-compare 1.2.0.** *Admin > Modules:* every module that has settings gets a **Configure** button next to Switch off, Who can use it, Roll back and Uninstall; the settings open under that module's card. For price comparison this is where the update settings (how often the price files are read, how long a branch list is trusted, when a price counts as old) and the **supermarket portals** (which chains are on, tests, raw files, custom chains) now live; they are no longer in Settings or at the bottom of the screen. *Compare prices tab:* the button is **Compare now** and a status line says what is happening ("Fetching prices… 2 of 3", then "Done. Updated the prices of 2 branches", "already up to date" or which branches could not be read). A coverage line such as "4 of 7 items priced" is **bold red** with a warning sign until every item is priced, and branches that cannot be fully compared open by themselves. *Matching once:* items to match are listed once per chain (not once per branch) in an "Items to match" panel; a match is used by every branch of the chain (by code, or by exact name when a branch uses another code), and a clear match is **carried to the other chains automatically** and labelled "Matched automatically (from …)": the same words (the brand aside), the same brand and pack size, the same weighed or packed form, and no equally good rival; anything less certain is left for you. Change on any line replaces it.

**Version 1.4.0: prices and matching** (price-compare module 1.1.0, core API addition `itemInHousehold`). The Compare prices tab now compares **real shelf prices** for the branches you chose. Each branch's newest `PriceFull` file is read in the background (lazily: the first look after 24 hours, or **Refresh prices**) and merged, so a price stays until a newer one arrives; an item missing from a new file keeps its price and is flagged "old" after 60 days without appearing in a file. Items are matched to products **once, by you**: the app ranks the branch's products by words (Hebrew and English, plurals, prefixes, brands; frozen, pickled, pet food and deposits are not offered unless you ask), you confirm one, and it is remembered per household, item and chain. A barcode confirmed at one chain prices the item at the others automatically; weighed products ask once how much "1" means; "this chain does not sell it" is remembered too. Results show a total per branch, coverage ("18 of 21"), the items still to match, the pack size and unit price when sizes differ, and receipt prices only where no shelf price exists (labelled). Admin > Modules > Price comparison sets how often the portals are read (default 24 h).

**Version 1.3.1.** *Manage list:* every section is collapsible, the order is chosen in Settings > Manage list layout, and both the order and which sections are open follow you across devices. *Language:* the login screen no longer has a language switch; the app starts in English and the language is chosen only in Settings. **Hebrew is now a language module** (`modules/lang-he`); other languages can be added the same way (see `docs/MODULES.md`). *Content direction:* Hebrew list, item, store, category and household names are right-to-left even in the English interface. Migration 8 adds per-user interface preferences.

**Version 1.3.0: modules.** Receipt reading and price comparison (with the supermarket portals) are now **modules** with their own databases, versions and on/off switches. Admin > Modules installs a module from a zip (after showing its name, version and hash), switches it on or off, chooses who may use it, rolls back and uninstalls; changes take effect when an admin presses **Restart server**. Each user can switch a granted module off for themselves in Settings > Modules. Modules add screens to named slots (a list tab, a Manage section, a Settings section, an Admin section). See `docs/MODULES.md`. The core no longer holds the portal or receipt-reading code, and migration 7 drops the old portal tables, the store-to-chain column and the per-user OCR table (the portal and OCR data now live in `data/modules/<id>/`; settings made in 1.2.1 are not carried over).

**Earlier:** History lines are one row each; correct or delete a line from its ✎ panel. Each list has a **Compare prices** tab: pick supermarket chains in Manage list and see an estimated total and item coverage per chain, based on prices from your own receipts (live chain prices are planned). Since 1.0.0 it also has prices, totals and receipt photos on Finish trip, **List History** (review, correct and restore past trips), receipt scanning (local Tesseract, or your own cloud API key), CSV export of purchases, and CSV backup/restore/move of the item bank. Next: live chain prices (1.3.0), then live sync and offline.

## Run it

```bash
docker compose up -d --build
```

Open `http://<server-ip>:3000` (or `HOST_PORT=3010 docker compose up -d --build` to use another host port). The first visit asks you to create the admin account. Data is stored in `./data/shoplist.db`; back up that folder.

## Nginx Proxy Manager + Cloudflare

PWAs (install, service worker, push) need HTTPS.

1. NPM → Proxy Hosts → Add: your domain, scheme `http`, forward host = the Docker host, port `3000`.
2. Turn on **Websockets Support** (needed from Stage 3, live sync) and **Block Common Exploits**.
3. SSL tab: request a certificate, enable **Force SSL** and **HTTP/2**.
4. In Cloudflare, proxy (orange cloud) is fine. Keep SSL/TLS mode on **Full** or **Full (strict)**.
5. In the app: Admin → Server settings → set **Public address** to your https URL so invite and reset links are correct.

The server trusts `X-Forwarded-*` headers, so cookies are marked `Secure` automatically behind HTTPS.

## Accounts and passwords

- **Registration mode** (Admin → Server settings): invite-only (default), open, or admin-only.
- **Forgot password:** by email if SMTP is configured; otherwise the admin uses **Reset password** on the user to generate a **one-time password** (shown once; the user must choose a new password at next sign-in).
- **Stay signed in:** a revocable session cookie (default 365 days, sliding). Users can sign out devices from Settings.

## Develop

```bash
cd server && npm install && npm test     # API and module tests (core and ../modules/*/test)
node scripts/build-modules.mjs           # after changing a module's browser code
cd server && npm run dev                 # API on :3000, data in ../data
cd web && npm install && npm run dev     # Vite on :5173, proxies /api to :3000
python e2e/make_receipts.py && python e2e/e2e.py   # real-browser test incl. real OCR (see header of e2e.py)
```

API writes (anything not GET) must send the header `X-SL-Client: web` (CSRF defence). The web app does this automatically.

## Project layout

```
server/src/db.js          full schema (all stages) + migrations via PRAGMA user_version
server/src/util.js        hashing, settings, audit, household/user helpers
server/src/auth.js        sessions, cookie, app.auth() guard
server/src/match.js       EN/HE normalisation + fuzzy matching (the duplicate-prevention engine)
server/src/access.js      who may see/edit a list (owner, editor, shopper)
server/src/routes/        auth.js, admin.js, lists.js (lists, entries, bank, categories), shopping.js (check-off, Finish trip, reorder, stores, list roles), households.js (members, invites, personal ordering), history.js (trips, receipts, OCR settings, purchase CSV), itemsCsv.js (item bank CSV)
server/src/modules/       module system: manifest checks, zip install, loader, events, core read API
server/src/receipts.js    receipt queue (a 'receipt-reader' module does the reading)
modules/receipt-ocr/      Tesseract + cloud engines, receipt text parser (handles Hebrew visual order)
modules/lang-he/          Hebrew interface text (a language module)
modules/price-compare/    supermarket portals, branch directory, compare prices (server + browser code)
scripts/build-modules.mjs compiles the modules' browser code and packs the zips
server/src/secrets.js     encrypts stored API keys (key file: data/secret.key)
server/test/              node:test API tests
web/src/                  React + Vite PWA (i18n.ts holds English and Hebrew text)
```

## Roadmap

1. **Foundation (done):** Docker, schema, auth, admin, PWA shell, EN/HE.
2. **Lists and bank (done):** lists, item bank, categories, duplicate-aware add, EN/HE matching.
3. **Shop and Manage (done):** Shop mode, undo, Finish trip, purchase events, store layouts, drag-and-drop ordering, list roles.
3.1. **Households UI and item editor (this build):** home grouped by household, burger menus, reorder lists and households, member management, one-line past items, item default note and price.
3.2. **Money, receipts and history (this build):** totals and receipt photos on Finish trip, List History tab, restore past trips, receipt OCR (local first, optional cloud key), CSV export of purchases, CSV backup/restore/move of the item bank, per-user currency.
4. *Next:* live sync and an offline queue (including queued photo uploads).

5. Web push and list-full alerts.
6. Themes, list images, analytics, backup/restore, smart suggestions.

## Using the app

Each list has two tabs.

- **Shop** is the passive screen: search, tap a row to tick it off (it moves to *In cart*), **Undo**, and **Finish trip**. Pick a store to see the list in that supermarket's walking order. Finish trip records every ticked item as a purchase and removes it from the list; unticked items stay.
- **Manage list** is the active screen: add items (quantity, category, note; create a category on the spot), add again from past items with a quantity, drag ⠿ to reorder or to drop an item into another category, rename/reorder/delete categories, set store walking orders, choose who is an **Editor** or a **Shopper**, rename or delete the list.

A **Shopper** only sees the Shop tab, so a household member who just walks the aisles never sees the editing controls. The list owner changes roles under *People on this list*.

Every Finish trip is stored as purchase events (item, quantity, store, buyer, time). That history is what the later smart-suggestions feature will use.

### Households

A household owns its lists, item bank, categories, stores and purchase history. From the home screen, the ☰ menus let you manage a household (rename, members and roles, invite links, leave, delete) and reorder lists or households; the order is personal to each user. Add an existing user by exact username, or share an invite link or code. Deleting a household asks you to type its name. Admins can switch off "users can create households" under Server settings.

### Item editor

In *Add from past items*, ✎ edits an item's name, category, **default note** (filled in whenever the item is added) and an optional **price**. The price is copied onto each purchase when a trip is finished, so later price changes never rewrite history.

## Prices, receipts and history

- **Finish trip** can take an optional **total** and a **receipt photo** (camera or gallery; the browser shrinks it first). Skipping both works as before. The trip is saved first, so a failed photo upload never loses it.
- **List History** is the third tab, for everyone on the list (including Shoppers). Open a trip to see its receipt photos and lines; change quantity, unit price or line total; correct the trip total; add or delete photos; and **restore** all or some lines onto the list (quantities merge with what is already there).
- **Receipt scanning:** every photo is read in the background. Each line is matched to what was bought on the trip (or the item bank); you confirm or fix everything on the **review screen** before anything is saved. Lines that are not yet on the trip are added to it, and the price learned becomes the item's "last paid" price.
- **Currency** is a personal setting (Settings). Until chosen it is detected from the timezone, then the browser language. Each trip stores the currency it was recorded in; amounts are not converted.
- Receipt photos live in `data/receipts/` and are deleted with their household. **Back up the whole `data/` folder** (database, photos and `secret.key`).

### Receipt engines

- **Local (default):** Tesseract inside the container, English and Hebrew. Private and free. Accuracy depends on the photo; flat, well-lit, full-frame receipts work best. Hebrew text is auto-corrected when Tesseract returns it in visual order.
- **Cloud (optional, per user):** in Settings choose a provider (Anthropic, OpenAI or Google), paste your own API key and optionally a model name. The key is encrypted at rest and never shown again. With the engine on *Automatic*, cloud is used only when you have saved a key; choose *Local only* to keep photos on the server. When cloud is used, the receipt photo is sent to that provider.
- The admin can switch scanning off entirely (Server settings).

## CSV

- **Purchase history** (List History, or a household's menu): date and time (UTC), household, list, store, item, category, quantity, unit price, line total, currency, buyer, trip and receipt total (printed once per trip so sums do not double count). Optional date range. Purchases from private lists are only exported to people who can see those lists. UTF-8 with BOM so Excel shows Hebrew.
- **Item bank** (Manage list, *Backup and move items*): export all items with category, default note, price, purchase counts and the quantity currently on this list. Import a file to restore them, or to bring items from another list or household: names are matched with the same fuzzy matcher (no silent duplicates), missing categories are created, a preview shows what will happen, and *Quantity* values are added to this list. Cells that start with `=`, `+`, `-` or `@` are protected against spreadsheet formula injection on export and unprotected on import.

## How duplicate prevention works

Every item name is normalised (case, punctuation, accents, Hebrew niqqud and final letters, English and Hebrew plural endings, the Hebrew article ה). Adding `Tomatoes` when `tomato` exists reuses the same bank item silently. A near-miss such as `Rise` for `Rice` asks the user to confirm. Typo tolerance grows with word length and can be tuned with the `match_strictness` setting (`loose` / `normal` / `strict`, API only for now). Rules live in `server/src/match.js` and are covered by `server/test/match.test.js`; extend them there as you find real-world cases.

## Upgrading

Recommended: **`./update.sh`** (pulls from GitHub, builds first, backs up `data/`, starts the new version, checks it, and rolls back by itself if it fails). Also `./update.sh --tag v3.3.0`, `--rollback` and `--dry-run`. See `docs/HANDOFF.md` section 4. By hand:

1. Replace the project folder with the new zip but keep your `data/` folder.
2. **Keep your port setting:** a new `docker-compose.yml` overwrites the old one, so put your port in a `.env` file next to it (`HOST_PORT=3010`) and it survives upgrades.
3. `docker compose up -d --build` and **read the output**: if the build fails (network, apt, npm), compose keeps the OLD container running and you keep seeing the old version.
4. Settings shows `Version: app X · server Y`. If a device still runs old files, a yellow *Update now* banner appears; it clears the cached app and reloads.

## Run the published image (GitHub container registry)

Pushing a version tag builds, tests and publishes the image, so the server can *pull* it instead of building.

1. **Publish:** `scripts/set-version.sh 1.0.1`, commit, then `git tag -a v1.0.1 -m "v1.0.1" && git push && git push --tags`. Watch the *Release image* run under the repository's **Actions** tab. The image appears under your profile's **Packages** as `ghcr.io/YOUR-USER/YOUR-REPO` (all lowercase) with tags `1.0.1`, `1.0` and `latest`. The run refuses to publish if the tag and the versions in `server/package.json` and `web/package.json` disagree.
2. **Let the server pull it (private repositories):** create a *Personal access token (classic)* with only the `read:packages` scope, then on the server: `echo YOUR_TOKEN | docker login ghcr.io -u YOUR-GITHUB-USER --password-stdin`.
3. **Point the server at it:** in `.env` set `SHOPLIST_IMAGE=ghcr.io/YOUR-USER/YOUR-REPO` and `SHOPLIST_TAG=1.0.1`.
4. **Install or upgrade:** back up `data/` (`cp -a data data-backup-$(date +%F)`), then `docker compose pull && docker compose up -d`. To roll back, set the previous `SHOPLIST_TAG` and run the same two commands (restore the backup too if the newer version had changed the database).

Without those two variables the compose file keeps building from source, so `./update.sh` works as before. The image contains the app only; your data, photos and keys stay in `./data` on the server.

## Troubleshooting

- **`port is already allocated`:** something else uses the host port. Start with `HOST_PORT=3010 docker compose up -d` (or put `HOST_PORT=3010` in a `.env` file next to the compose file).
- **`SQLITE_CANTOPEN`:** the data folder is not writable. The image now fixes ownership on start; if your platform forbids that, run `chown -R 1000:1000 ./data` on the host.
