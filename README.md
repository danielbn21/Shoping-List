# Shopping list PWA

Self-hosted, multi-user household shopping list. One Docker container serves both the API and the installable web app.

**Status: Stage 3.2.** Everything from 3.1, plus prices, totals and receipt photos on Finish trip, **List History** (review, correct and restore past trips), receipt scanning (local Tesseract, or your own cloud API key), CSV export of purchases, and CSV backup/restore/move of the item bank. Next: live sync and offline.

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
cd server && npm install && npm test     # API tests
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
server/src/ocr.js         Tesseract + cloud engines, receipt text parser (handles Hebrew visual order)
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

1. Replace the project folder with the new zip but keep your `data/` folder.
2. **Keep your port setting:** a new `docker-compose.yml` overwrites the old one, so put your port in a `.env` file next to it (`HOST_PORT=3010`) and it survives upgrades.
3. `docker compose up -d --build` and **read the output**: if the build fails (network, apt, npm), compose keeps the OLD container running and you keep seeing the old version.
4. Settings shows `Version: app X · server Y`. If a device still runs old files, a yellow *Update now* banner appears; it clears the cached app and reloads.

## Troubleshooting

- **`port is already allocated`:** something else uses the host port. Start with `HOST_PORT=3010 docker compose up -d` (or put `HOST_PORT=3010` in a `.env` file next to the compose file).
- **`SQLITE_CANTOPEN`:** the data folder is not writable. The image now fixes ownership on start; if your platform forbids that, run `chown -R 1000:1000 ./data` on the host.
