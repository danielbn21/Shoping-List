import { getSetting } from '../util.js';
import { makeChains } from '../chains.js';
import { decodeXmlBytes } from './decode.js';
import { parseStoresXml } from './xml.js';
import { cityKey, refreshCityNames, seedCities, citiesFetchedAt } from './cities.js';

const DAY = 86_400_000;
const normName = (s) => String(s).replace(/["'’״׳\-–]/g, ' ').replace(/\s+/g, ' ').trim();
const NOT_A_SUPERMARKET = /\bBE\b|אונליין|online|@|https?:\/\//i; // pharmacies (Shufersal BE), online-only shops, URL entries

// Shufersal and Carrefour run several formats with very different prices; the format is the first word of the store name.
export function bannerOf(chain, name) {
  if (chain.platform !== 'shufersal' && chain.platform !== 'carrefour') return '';
  return name.replace('שופרסל', '').replace('קרפור', '').trim().split(/\s+/)[0] || '';
}

export function createDirectory({ db, portals, http, citiesUrl, delayMs = 400, now = Date.now }) {
  const chains = makeChains(db);
  let job = null;
  seedCities(db);

  const state = db.prepare('SELECT * FROM portal_chain_state WHERE chain = ?');
  const touch = db.prepare('INSERT INTO portal_chain_state(chain) VALUES (?) ON CONFLICT(chain) DO NOTHING');
  const markError = (chain, e) => { touch.run(chain); db.prepare('UPDATE portal_chain_state SET last_error = ?, last_error_at = ? WHERE chain = ?').run(String(e?.message || e).slice(0, 300), now(), chain); };

  // Chains disagree on how they write the city (numeric locality code vs a name), so a name that matches a known city is mapped to its code.
  const cityResolver = () => {
    const byName = new Map(db.prepare('SELECT code, name FROM city_names').all().map((r) => [normName(r.name), r.code]));
    return (raw) => { const k = cityKey(raw); return /^\d+$/.test(k) || !k ? k : byName.get(normName(k)) ?? k; };
  };

  // Read the chain's newest Stores file and replace its branches in the directory.
  async function refreshChain(chain) {
    try {
      const resolveCity = cityResolver();
      const access = portals.open(chain);
      const f = await access.stores();
      const parsed = parseStoresXml(decodeXmlBytes(f.bytes));
      const rows = parsed.stores.filter((s) => !NOT_A_SUPERMARKET.test(`${s.name} ${s.address}`));
      if (!rows.length) throw new Error('the Stores file has no branches');
      const ins = db.prepare('INSERT OR REPLACE INTO portal_branches(chain, store_id, name, address, city_key, zip, banner, sub_chain, store_type) VALUES (?,?,?,?,?,?,?,?,?)');
      db.transaction(() => {
        db.prepare('DELETE FROM portal_branches WHERE chain = ?').run(chain.id);
        for (const s of rows) ins.run(chain.id, s.storeId, s.name, s.address, resolveCity(s.city), s.zip, bannerOf(chain, s.name), s.subChainName || '', s.storeType);
        touch.run(chain.id);
        db.prepare('UPDATE portal_chain_state SET branches_fetched_at = ?, stores_file = ?, branch_count = ?, last_ok_at = ?, last_error = NULL, last_error_at = NULL WHERE chain = ?')
          .run(now(), f.name, rows.length, now(), chain.id);
      })();
      return { chain: chain.id, ok: true, branches: rows.length, file: f.name };
    } catch (e) {
      markError(chain.id, e);
      return { chain: chain.id, ok: false, error: String(e?.message || e) };
    }
  }

  const status = () => job && { running: job.running, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, done: job.done, total: job.total, current: job.current, results: job.results };

  // One background job at a time: the city list (if due), then each usable chain, one after another.
  function startRefresh({ only } = {}) {
    if (job?.running) return { started: false, job: status() };
    const list = chains.all().filter((c) => c.supported && c.enabled && (!only || only.includes(c.id)));
    job = { running: true, startedAt: now(), done: 0, total: list.length, current: null, results: [] };
    const me = job;
    (async () => {
      try {
        if (now() - citiesFetchedAt(db) > 30 * DAY) {
          me.current = 'cities';
          try { await refreshCityNames({ db, http, url: citiesUrl, now }); } catch (e) { me.results.push({ chain: 'cities', ok: false, error: String(e?.message || e) }); }
        }
        for (const c of list) {
          me.current = c.id;
          me.results.push(await refreshChain(c));
          me.done++;
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
      } finally { me.running = false; me.current = null; me.finishedAt = now(); }
    })();
    return { started: true, job: status() };
  }

  // Lazy: the first picker visit (or a stale directory) starts the load; nothing is fetched otherwise.
  function ensureFresh() {
    if (job?.running) return;
    const usable = chains.all().filter((c) => c.supported && c.enabled);
    const maxAge = Number(getSetting(db, 'branch_cache_days')) * DAY;
    const stale = usable.filter((c) => { const s = state.get(c.id); return !s?.branches_fetched_at || now() - s.branches_fetched_at > maxAge; });
    // A chain whose last attempt failed is retried at most once an hour.
    const due = stale.filter((c) => { const s = state.get(c.id); return !s?.last_error_at || now() - s.last_error_at > 3_600_000; });
    if (due.length) startRefresh({ only: due.map((c) => c.id) });
  }

  const nameOf = db.prepare('SELECT name FROM city_names WHERE code = ?');
  const cityName = (key) => nameOf.get(key)?.name ?? (/^\d+$/.test(key) ? '' : key);

  function listCities() {
    const usable = chains.all().filter((c) => c.supported && c.enabled).map((c) => c.id);
    if (!usable.length) return [];
    const rows = db.prepare(`SELECT b.city_key AS key, COUNT(*) AS branches, COUNT(DISTINCT b.chain) AS chains
      FROM portal_branches b WHERE b.chain IN (${usable.map(() => '?').join(',')}) AND b.city_key <> '' GROUP BY b.city_key`).all(...usable);
    return rows.map((r) => ({ key: r.key, name: cityName(r.key) || `#${r.key}`, branches: r.branches, chains: r.chains }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  function listBranches({ cities = [], chainIds } = {}) {
    if (!cities.length) return [];
    const usable = chains.all().filter((c) => c.supported && c.enabled && (!chainIds || chainIds.includes(c.id))).map((c) => c.id);
    if (!usable.length) return [];
    const rows = db.prepare(`SELECT * FROM portal_branches WHERE city_key IN (${cities.map(() => '?').join(',')}) AND chain IN (${usable.map(() => '?').join(',')})
      ORDER BY chain, banner, city_key, name LIMIT 800`).all(...cities, ...usable);
    return rows.map((r) => ({ chain: r.chain, storeId: r.store_id, name: r.name, address: r.address, cityKey: r.city_key, cityName: cityName(r.city_key) || `#${r.city_key}`, banner: r.banner, zip: r.zip }));
  }

  const branchById = db.prepare('SELECT * FROM portal_branches WHERE chain = ? AND store_id = ?');
  const getBranch = (chain, storeId) => {
    const r = branchById.get(chain, String(storeId));
    return r && { chain: r.chain, storeId: r.store_id, name: r.name, address: r.address, cityKey: r.city_key, cityName: cityName(r.city_key) || `#${r.city_key}`, banner: r.banner };
  };

  const chainStats = () => chains.all().filter((c) => c.supported).map((c) => {
    const s = state.get(c.id);
    return { chain: c.id, branches: s?.branch_count ?? 0, fetchedAt: s?.branches_fetched_at ?? null, lastError: s?.last_error ?? null };
  });

  return { refreshChain, startRefresh, ensureFresh, status, listCities, listBranches, getBranch, cityName, chainStats, chains, state };
}
