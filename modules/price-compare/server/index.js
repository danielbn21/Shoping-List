import { makeChains } from './chains.js';
import { createHttp } from './portals/http.js';
import { createPortals } from './portals/clients.js';
import { createDirectory } from './portals/directory.js';
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

  o.expose?.({ dir, chains, portals }); // tests only
  compareRoutes(ctx, { chains, dir });
  portalRoutes(ctx, { chains, dir, portals });

  // Admin setting of this module (shown in the admin section of the web app).
  ctx.routes.get('/admin/settings', { access: 'admin' }, async () => ({ branchCacheDays: ctx.settings.get('branch_cache_days', 7) }));
  ctx.routes.put('/admin/settings', { access: 'admin' }, async (req, reply) => {
    const n = Number((req.body || {}).branchCacheDays);
    if (!Number.isInteger(n) || n < 1 || n > 90) return reply.code(400).send({ error: 'invalid_value' });
    ctx.settings.set('branch_cache_days', n);
    ctx.audit(req.user.id, 'settings', `branch_cache_days=${n}`);
    return { branchCacheDays: n };
  });

  // The 'price-source' capability: for now it only describes what this module can read. Live branch prices arrive in 1.4.0.
  ctx.provide('price-source', { id: 'price-compare', chains: () => chains.all().filter((c) => c.supported && c.enabled).map((c) => c.id) });

  // Cleanup when the core removes things this module keeps notes about.
  const dropLists = (ids) => { const a = db.prepare('DELETE FROM list_compare_stores WHERE list_id = ?'), b = db.prepare('DELETE FROM list_compare_cities WHERE list_id = ?'); for (const id of ids) { a.run(id); b.run(id); } };
  ctx.events.on('list.deleted', ({ listId }) => dropLists([listId]));
  ctx.events.on('store.deleted', ({ storeId }) => db.prepare('DELETE FROM store_chain WHERE store_id = ?').run(storeId));
  ctx.events.on('household.deleted', ({ listIds = [], storeIds = [] }) => { dropLists(listIds); const d = db.prepare('DELETE FROM store_chain WHERE store_id = ?'); for (const id of storeIds) d.run(id); });
}
