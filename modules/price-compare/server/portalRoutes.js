import fs from 'node:fs';
import path from 'node:path';
import { publicChain } from './chains.js';
import { runPortalTest, listSamples, samplesDir } from './portals/diagnostics.js';
import { citiesFetchedAt } from './portals/cities.js';

const bad = (reply, error, code = 400) => reply.code(code).send({ error });

export default function portalRoutes(ctx, { chains, dir, portals }) {
  const db = ctx.db;
  const audit = (_db, actor, action, target) => ctx.audit(actor, action, target);

  // ---- for the city and branch pickers (public price-file data, shared by all households) ----
  ctx.routes.get('/portals/cities', async () => {
    dir.ensureFresh(); // lazy: the first visit loads the directory in the background
    const job = dir.status();
    const cities = dir.listCities();
    return { loading: !!job?.running, progress: job ? { done: job.done, total: job.total } : null, cities, chains: chains.all().map(publicChain), stats: dir.chainStats() };
  });

  ctx.routes.get('/portals/branches', async (req) => {
    const split = (v) => (typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 60) : []);
    return { branches: dir.listBranches({ cities: split(req.query.cities), chainIds: req.query.chains ? split(req.query.chains) : undefined }) };
  });

  // ---- Settings > Supermarket portals: any signed-in user may look, reload branch lists and run a test ----
  // Non-admins are rate limited so nobody can hammer the retailers' portals; admins are not. Raw files can only be kept by admins.
  const isAdmin = (u) => u.role === 'admin';
  const last = new Map(); // `${action}|${chain}` -> time of the last non-admin run
  const cooldown = (user, action, chain, seconds, reply) => {
    if (isAdmin(user)) return false;
    const k = `${action}|${chain}`, wait = (last.get(k) ?? 0) + seconds * 1000 - Date.now();
    if (wait > 0) { reply.code(429).send({ error: 'try_later', retryAfter: Math.ceil(wait / 1000) }); return true; }
    last.set(k, Date.now());
    return false;
  };

  // ---- admin: the Portals screen ----
  const overview = () => {
    const stats = new Map(dir.chainStats().map((s) => [s.chain, s]));
    const stateRows = new Map(db.prepare('SELECT * FROM portal_chain_state').all().map((r) => [r.chain, r]));
    const zip = db.prepare("SELECT chain, COUNT(*) AS n, SUM(CASE WHEN zip <> '' AND zip NOT GLOB '[0]*' THEN 1 ELSE 0 END) AS filled, COUNT(DISTINCT city_key) AS cities FROM portal_branches GROUP BY chain").all();
    const zipBy = new Map(zip.map((z) => [z.chain, z]));
    return chains.all().map((c) => {
      const st = stateRows.get(c.id), s = stats.get(c.id), z = zipBy.get(c.id);
      return {
        ...publicChain(c), platform: c.platform, user: c.user, chainId: c.chainId,
        branches: s?.branches ?? 0, cities: z?.cities ?? 0, zipFilled: z?.filled ?? 0,
        fetchedAt: st?.branches_fetched_at ?? null, storesFile: st?.stores_file ?? null,
        lastOkAt: st?.last_ok_at ?? null, lastError: st?.last_error ?? null, lastErrorAt: st?.last_error_at ?? null,
      };
    });
  };

  ctx.routes.get('/admin/portals', { access: 'admin' }, async () => ({
    chains: overview(), job: dir.status(), citiesFetchedAt: citiesFetchedAt(db) || null,
    cityNames: db.prepare("SELECT source, COUNT(*) AS n FROM city_names GROUP BY source").all(), samples: listSamples(ctx.filesDir),
    baseUrls: portals.baseUrls,
  }));

  ctx.routes.put('/admin/portals/:chain', { access: 'admin' }, async (req, reply) => {
    const c = chains.get(req.params.chain);
    if (!c || !c.supported) return bad(reply, 'not_found', 404);
    const on = req.body?.enabled;
    if (typeof on !== 'boolean') return bad(reply, 'invalid_value');
    db.prepare('INSERT INTO portal_chain_state(chain, enabled) VALUES (?, ?) ON CONFLICT(chain) DO UPDATE SET enabled = excluded.enabled').run(c.id, on ? 1 : 0);
    audit(db, req.user.id, 'admin.portal_chain', `${c.id}=${on ? 'on' : 'off'}`);
    return { ok: true };
  });

  ctx.routes.get('/portals/status', async (req) => ({
    chains: overview(), job: dir.status(), citiesFetchedAt: citiesFetchedAt(db) || null,
    cityNames: db.prepare('SELECT source, COUNT(*) AS n FROM city_names GROUP BY source').all(), isAdmin: isAdmin(req.user),
  }));

  // Reload branch lists now (all usable chains, or one).
  ctx.routes.post('/portals/refresh', async (req, reply) => {
    const only = req.body?.chain ? [req.body.chain] : undefined;
    if (only && !chains.usable(only[0])) return bad(reply, 'not_found', 404);
    if (!dir.status()?.running && cooldown(req.user, 'refresh', only?.[0] ?? 'all', 300, reply)) return reply;
    audit(db, req.user.id, 'portals.refresh', only?.[0] ?? 'all');
    return dir.startRefresh({ only });
  });

  // Diagnostics for one chain: login, Stores file, a PriceFull file for one branch, dry-run parse.
  const testing = new Set();
  ctx.routes.post('/portals/:chain/test', async (req, reply) => {
    const c = chains.get(req.params.chain);
    if (!c || !c.supported) return bad(reply, 'not_found', 404);
    if (testing.has(c.id)) return bad(reply, 'try_later', 429);
    if (cooldown(req.user, 'test', c.id, 60, reply)) return reply;
    const storeId = typeof req.body?.storeId === 'string' || typeof req.body?.storeId === 'number' ? String(req.body.storeId).trim() : '';
    const save = isAdmin(req.user) && !!req.body?.save;
    testing.add(c.id);
    try {
      const report = await runPortalTest({ chain: c, portals: portals, storeId, save, dataDir: ctx.filesDir });
      audit(db, req.user.id, 'portals.test', `${c.id}${report.saved.length ? ' (+sample)' : ''}`);
      return { report, samples: isAdmin(req.user) ? listSamples(ctx.filesDir) : [] };
    } finally { testing.delete(c.id); }
  });

  ctx.routes.get('/admin/portals/samples/:chain/:file', { access: 'admin' }, async (req, reply) => {
    const { chain, file } = req.params;
    if (!/^[\w.\-]+$/.test(chain) || !/^[\w.\-]+$/.test(file)) return bad(reply, 'not_found', 404);
    const p = path.join(samplesDir(ctx.filesDir), chain, file);
    if (!fs.existsSync(p)) return bad(reply, 'not_found', 404);
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="${file}"`);
    return reply.send(fs.readFileSync(p));
  });

  ctx.routes.delete('/admin/portals/samples/:chain/:file', { access: 'admin' }, async (req, reply) => {
    const { chain, file } = req.params;
    if (!/^[\w.\-]+$/.test(chain) || !/^[\w.\-]+$/.test(file)) return bad(reply, 'not_found', 404);
    const p = path.join(samplesDir(ctx.filesDir), chain, file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  });

  // Experimental: try another chain of the shared portal by its public username (for example to test Victory or Hazi Hinam).
  ctx.routes.post('/admin/portals/custom', { access: 'admin' }, async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
    const u = typeof req.body?.user === 'string' ? req.body.user.trim() : '';
    if (!name || !/^[A-Za-z0-9_.\-]{2,40}$/.test(u)) return bad(reply, 'invalid_value');
    if (chains.all().some((c) => c.user && c.user.toLowerCase() === u.toLowerCase())) return bad(reply, 'username_taken', 409);
    const id = `custom_${u.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    db.prepare('INSERT INTO custom_chains(id, name, portal_user, created_at) VALUES (?,?,?,?)').run(id, name, u, Date.now());
    audit(db, req.user.id, 'admin.portal_custom_added', `${name} (${u})`);
    return { id };
  });

  ctx.routes.delete('/admin/portals/custom/:id', { access: 'admin' }, async (req, reply) => {
    const r = db.prepare('DELETE FROM custom_chains WHERE id = ?').run(req.params.id);
    if (!r.changes) return bad(reply, 'not_found', 404);
    db.prepare('DELETE FROM portal_branches WHERE chain = ?').run(req.params.id);
    db.prepare('DELETE FROM portal_chain_state WHERE chain = ?').run(req.params.id);
    db.prepare('DELETE FROM list_compare_stores WHERE chain = ?').run(req.params.id);
    db.prepare('DELETE FROM store_chain WHERE chain = ?').run(req.params.id);
    audit(db, req.user.id, 'admin.portal_custom_removed', req.params.id);
    return { ok: true };
  });
}
