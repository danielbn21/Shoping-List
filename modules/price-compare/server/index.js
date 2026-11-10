import { makeChains } from './chains.js';
import { createHttp } from './portals/http.js';
import { createPortals } from './portals/clients.js';
import { createDirectory } from './portals/directory.js';
import { createPrices } from './prices.js';
import compareRoutes from './compare.js';
import portalRoutes from './portalRoutes.js';

// This module's own database (data/modules/price-compare/data.db). Ids of lists and stores are plain numbers from the core;
// the module cleans up after itself when the core says a list, store or household is gone (see the events below).
export const migrations = [
  `
CREATE TABLE store_chain (            -- which supermarket chain a household store is
  store_id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL
);
CREATE TABLE list_compare_stores (    -- the chains and branches each list compares
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  branch_id TEXT NOT NULL DEFAULT '',
  branch_name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (list_id, chain, branch_id)
);
CREATE TABLE list_compare_cities (
  list_id INTEGER NOT NULL,
  city_key TEXT NOT NULL,
  PRIMARY KEY (list_id, city_key)
);
CREATE TABLE portal_branches (        -- a shared (public) directory of branches read from each chain's Stores file
  chain TEXT NOT NULL,
  store_id TEXT NOT NULL,             -- without leading zeros
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city_key TEXT NOT NULL DEFAULT '',  -- numeric locality code without leading zeros, or the city name when the file gives a name
  zip TEXT NOT NULL DEFAULT '',
  banner TEXT NOT NULL DEFAULT '',
  sub_chain TEXT NOT NULL DEFAULT '',
  store_type TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (chain, store_id)
);
CREATE INDEX idx_portal_branches_city ON portal_branches(city_key);
CREATE TABLE portal_chain_state (
  chain TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  branches_fetched_at INTEGER,
  stores_file TEXT,
  branch_count INTEGER NOT NULL DEFAULT 0,
  last_ok_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);
CREATE TABLE custom_chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  portal_user TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE city_names (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL                -- 'gov' (data.gov.il) or 'seed' (built-in fallback for the biggest cities)
);
CREATE TABLE portal_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`,
  // 2 (1.1.0): branch prices, the confirmed product for each household item and chain
  `
CREATE TABLE branch_prices (          -- the latest known price of every product at every selected branch, merged from the daily files
  chain TEXT NOT NULL,
  store_id TEXT NOT NULL,
  code TEXT NOT NULL,                 -- ItemCode as in the file
  item_type INTEGER NOT NULL DEFAULT 1, -- 1 = barcode, 0 = the chain's own code
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  manufacturer TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,                -- per kilo when the product is weighed
  unit_price REAL,
  unit TEXT NOT NULL DEFAULT '',      -- what unit_price is per: kg, g, l, ml, item, m ('' when the file gives none)
  unit_per REAL NOT NULL DEFAULT 0,   -- ... per this many of them (100 g, 1 l)
  pack_amount REAL,                   -- pack size in g, ml, item or m
  pack_unit TEXT,
  weighted INTEGER NOT NULL DEFAULT 0,
  price_updated TEXT,
  seen_file TEXT NOT NULL,            -- stamp (yyyymmddhhmmss) of the newest file that listed the product
  PRIMARY KEY (chain, store_id, code)
);
CREATE INDEX idx_branch_prices_name ON branch_prices(chain, store_id, name_norm);
CREATE TABLE branch_price_state (
  chain TEXT NOT NULL,
  store_id TEXT NOT NULL,
  file TEXT,
  file_stamp TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,                 -- last time the portal was asked (a newer file or not)
  updated_at INTEGER,                 -- last time prices were merged in
  error TEXT,
  error_at INTEGER,
  PRIMARY KEY (chain, store_id)
);
CREATE TABLE product_map (            -- the household's confirmation: this item is that product at this chain
  household_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  chain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'none')),  -- none = this chain does not sell it
  code TEXT,
  item_type INTEGER,
  name TEXT,
  amount_kg REAL,                     -- weighed products: how much "1" on the list means, in kilos
  confirmed_by INTEGER,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, item_id, chain)
);
CREATE INDEX idx_product_map_item ON product_map(household_id, item_id);
`,
];

export default function register(ctx) {
  const { db } = ctx;
  const env = process.env, o = ctx.options; // o: tests (and PORTAL_URL_* variables) can point the portal clients at other servers
  const http = createHttp({ fetchImpl: o.fetch });
  const baseUrls = {
    ...(env.PORTAL_URL_SHUFERSAL && { shufersal: env.PORTAL_URL_SHUFERSAL }), ...(env.PORTAL_URL_SHARED && { shared: env.PORTAL_URL_SHARED }),
    ...(env.PORTAL_URL_CARREFOUR && { carrefour: env.PORTAL_URL_CARREFOUR }), ...o.baseUrls,
  };
  const portals = createPortals({ http, baseUrls });
  const dir = createDirectory({
    db, portals, http, citiesUrl: o.citiesUrl ?? env.PORTAL_CITIES_URL, delayMs: o.delayMs ?? 400,
    cacheDays: () => ctx.settings.get('branch_cache_days', 7),
  });
  const chains = makeChains(db);
  const prices = createPrices({ db, portals, chains, delayMs: o.priceDelayMs ?? o.delayMs ?? 400, refreshHours: () => ctx.settings.get('price_refresh_hours', 24), log: ctx.log });

  o.expose?.({ dir, chains, portals, prices }); // tests only
  compareRoutes(ctx, { chains, dir, prices });
  portalRoutes(ctx, { chains, dir, portals });

  // Admin setting of this module (shown in the admin section of the web app).
  const adminSettings = () => ({ branchCacheDays: ctx.settings.get('branch_cache_days', 7), priceRefreshHours: ctx.settings.get('price_refresh_hours', 24) });
  ctx.routes.get('/admin/settings', { access: 'admin' }, async () => adminSettings());
  ctx.routes.put('/admin/settings', { access: 'admin' }, async (req, reply) => {
    const b = req.body || {};
    if (b.branchCacheDays !== undefined) {
      const n = Number(b.branchCacheDays);
      if (!Number.isInteger(n) || n < 1 || n > 90) return reply.code(400).send({ error: 'invalid_value' });
      ctx.settings.set('branch_cache_days', n); ctx.audit(req.user.id, 'settings', `branch_cache_days=${n}`);
    }
    // How often the portals are read again (a price itself never expires: it stays until a newer one arrives).
    if (b.priceRefreshHours !== undefined) {
      const n = Number(b.priceRefreshHours);
      if (!Number.isInteger(n) || n < 1 || n > 168) return reply.code(400).send({ error: 'invalid_value' });
      ctx.settings.set('price_refresh_hours', n); ctx.audit(req.user.id, 'settings', `price_refresh_hours=${n}`);
    }
    return adminSettings();
  });

  // The 'price-source' capability: for now it only describes what this module can read. Live branch prices arrive in 1.4.0.
  ctx.provide('price-source', { id: 'price-compare', chains: () => chains.all().filter((c) => c.supported && c.enabled).map((c) => c.id), priceAt: (chain, storeId, code) => prices.priceAt(chain, storeId, code) });

  // Cleanup when the core removes things this module keeps notes about.
  const dropLists = (ids) => { const a = db.prepare('DELETE FROM list_compare_stores WHERE list_id = ?'), b = db.prepare('DELETE FROM list_compare_cities WHERE list_id = ?'); for (const id of ids) { a.run(id); b.run(id); } };
  ctx.events.on('list.deleted', ({ listId }) => dropLists([listId]));
  ctx.events.on('item.deleted', ({ itemId, householdId }) => db.prepare('DELETE FROM product_map WHERE household_id = ? AND item_id = ?').run(householdId, itemId));
  ctx.events.on('store.deleted', ({ storeId }) => db.prepare('DELETE FROM store_chain WHERE store_id = ?').run(storeId));
  ctx.events.on('household.deleted', ({ householdId, listIds = [], storeIds = [] }) => { dropLists(listIds); db.prepare('DELETE FROM product_map WHERE household_id = ?').run(householdId); const d = db.prepare('DELETE FROM store_chain WHERE store_id = ?'); for (const id of storeIds) d.run(id); });
}
