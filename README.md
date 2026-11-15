# Shopping List

A self-hosted, multi-user shopping list for households. Share lists with the people you live with, tick things off in the shop, record what you paid, and see where your list is cheapest. It runs as a single Docker container and installs on a phone like an app (a PWA), so your lists and receipts stay on your own server.

## Features

**Lists for the whole household**
- Households own their lists, item history, categories and stores; people join by username or an invite link.
- Each list has roles: **Owner**, **Editor** (changes the list) and **Shopper** (just sees the list and ticks things off in the shop).
- Private lists for one person, or lists shared with the household. Lists and households can be reordered, and the order is personal to each user.

**Shopping**
- **Shop** mode: search, tap to move an item to the cart, undo, and **Finish trip**. Pick a store to see the list in that supermarket's walking order.
- **Manage list** mode: add items with quantity, category and note; drag to reorder or to drop an item into another category; every section can be collapsed and reordered in Settings.
- **Past items** are kept per list, so a list for one supermarket never fills up with items from another. Items from a CSV import or a receipt join the list they were added to. Tick several and remove them in one go. The item itself is shared by the household, so details and price matches are never entered twice.
- Typing an item name suggests your own past items and, when price comparison is on, products from the supermarkets you compare.
- **Duplicate prevention** in English and Hebrew: "Tomatoes" reuses "tomato", and a near-miss such as "Rise" for "Rice" asks you first.

**Prices, receipts and history**
- Finish a trip with an optional total and a **receipt photo**. Receipts are read in the background (local OCR in the container, English and Hebrew; an optional cloud engine with your own API key) and you review every line before anything is saved.
- **List history** shows every trip: correct quantities, prices and totals, add or remove photos, and restore items to the list. You can also **add a trip by hand** (a shop you did not run through the Shop tab), change a trip's date or store, or delete a whole trip with its photos.
- **Price estimates** in the Shop tab show what each item cost last time and an estimated total, from your own receipts. Each user can switch this off in Settings; the admin sets the default.
- **CSV** export of purchases, and backup, restore or move of the item list between lists and households. Every item you import becomes one of that list's past items, so you can pick it right away.

**Price comparison (module)**
- Compare your list across the branches of twelve Israeli supermarket chains, using the price files the chains publish. Choose cities and branches, see a total and how many items are priced for each branch, and see which items still need matching.
- You match a product to an item once. Matches are shared by every branch of a chain, and clear matches are carried to other chains automatically, with a label you can change.
- Receipts fill in prices the chains do not publish, and are marked as such.

**Modules, languages and accessibility**
- Receipt reading, price comparison and extra interface languages are **modules**: install a zip in Admin, switch it on or off, choose who may use it, roll back or uninstall.
- English interface, with **Hebrew** as an installable language and right-to-left support for lists, items and household names.
- Installable on a phone or desktop; currency is a personal setting.

## Quick start

You need Docker with Compose.

```bash
git clone <this repository> && cd <this repository>
docker compose up -d --build
```

Open `http://<server-ip>:3000`. The first visit asks you to create the admin account. Everything (database, receipt photos, keys) lives in `./data`; back that folder up.

A phone can only install the app over HTTPS, so put it behind a reverse proxy. See [Deployment](docs/DEPLOYMENT.md) for HTTPS with Nginx Proxy Manager and Cloudflare, upgrades, the published image and troubleshooting.

## Using the app

1. **Create a household** (or join one with an invite link) and **create a list**.
2. **Add items** in *Manage list*. Add categories as you go, and add stores if you want the Shop tab to follow a supermarket's walking order.
3. **Shop**: tick items off in the *Shop* tab. Everyone on the list sees the changes. Tap **Finish trip** when you are done, optionally with the total and a receipt photo.
4. **Check the history** in *List history*: correct a line, fix the total, add a trip you forgot to record, or restore items for next week.
5. **Compare prices** (if the module is on): in the *Compare prices* tab choose where you shop, press **Compare now**, and match any items it lists. Then see which branch is cheapest for this list.

Admins manage users, registration (invite-only by default, open or admin-only), email for password resets, the public address and modules under **Admin**. Without email, an admin can generate a one-time password for a user who forgot theirs.

## Documentation

- [Deployment](docs/DEPLOYMENT.md): running, HTTPS and reverse proxy, accounts, upgrading, publishing the image, troubleshooting.
- [Development](docs/DEVELOPMENT.md): running locally, tests, project layout, releases.
- [Modules](docs/MODULES.md): how modules, capabilities and language packs work, and how to write one.

## Built with

Node.js and Fastify, SQLite, React and Vite (a PWA), Tesseract for receipt OCR, all in one Docker image.
