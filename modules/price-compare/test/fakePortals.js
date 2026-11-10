// A fake of the three retailer portals (and the government city list) for tests and the browser test. It mimics the real
// protocols as described by the il-supermarket-compare plugin, and serves trimmed copies of real price files as fixtures.
//   node test/fakePortals.js [port]     -> prints the URLs to give the server (PORTAL_URL_* and PORTAL_CITIES_URL)
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portal');
const fx = (n) => fs.readFileSync(path.join(FIX, n));
const gz = (s) => zlib.gzipSync(Buffer.from('\ufeff' + s, 'utf8'));
const stores = (chainId, chainName, rows) => `<Root><ChainID>${chainId}</ChainID><ChainName>${chainName}</ChainName><LastUpdateDate>2026-11-05</LastUpdateDate><LastUpdateTime>05:55:00</LastUpdateTime><SubChains><SubChain><SubChainID>001</SubChainID><SubChainName>${chainName}</SubChainName><Stores>${rows.map(([id, name, addr, city, zip = '1234567']) =>
  `<Store><StoreID>${id}</StoreID><BikoretNo>1</BikoretNo><StoreType>1</StoreType><StoreName>${name}</StoreName><Address>${addr}</Address><City>${city}</City><ZIPCode>${zip}</ZIPCode></Store>`).join('')}</Stores></SubChain></SubChains></Root>`;

const FILES = {
  shufersal: {
    stores: ['Stores7290027600007-000-20261105-070000.gz', gz(stores('7290027600007', 'שופרסל', [
      ['017', 'שופרסל שלי רמת גן', 'רחוב ז׳בוטינסקי 1', 'רמת גן'], ['018', 'שופרסל דיל בני ברק', 'רבי עקיבא 5', 'בני ברק'],
      ['019', 'שופרסל יש חסד חיפה', 'הנביאים 3', 'חיפה'], ['020', 'שופרסל BE רמת גן', 'ביאליק 2', 'רמת גן'], ['021', 'שופרסל אונליין', 'https://shufersal.co.il', 'תל אביב'],
    ]))],
    full: { 17: ['PriceFull7290027600007-001-017-20261107-030000.gz', fx('PriceFull7290027600007-001-017-20261107-030000.gz')] },
    delta: (id) => [`Price7290027600007-001-${String(id).padStart(3, '0')}-20261107-020000.gz`, gz('<Root><ChainID>7290027600007</ChainID><Items></Items></Root>')],
  },
  carrefour: {
    stores: ['Stores7290055700007-000-20261105-060000.gz', gz(stores('7290055700007', 'קרפור', [
      ['981', 'קרפור מרקט הרצליה', 'סוקולוב 10', '6400'], ['982', 'קרפור סיטי חולון', 'ויצמן 4', '6600'],
    ]))],
    full: { 981: ['PriceFull7290055700007-001-981-20261107-051011.gz', fx('PriceFull7290055700007-001-981-20261107-051011.gz')] },
  },
  shared: {
    RamiLevi: {
      stores: ['Stores7290058140886-000-20261105-060000.gz', gz(stores('7290058140886', 'רמי לוי', [['001', 'רמי לוי בני ברק', 'מבצע קדש 68', '6100'], ['002', 'רמי לוי רמת גן', 'ז׳בוטינסקי 5', '8600']]))],
      full: { 1: ['PriceFull7290058140886-001-001-20261107-001000.gz', fx('PriceFull7290058140886-001-001-20261107-001000.gz')],
              36: ['PriceFull7290058140886-001-036-20261107-180021.gz', fx('PriceFull7290058140886-001-001-20261107-001000.gz')] }, // the sub-chain segment is -001- in every name
      extra: [['Price7290058140886-001-001-20261107-080013.gz', gz('<Root><Items></Items></Root>')]],
    },
    Stop_Market: {
      stores: ['Stores7290639000004-000-20261105-055500.xml', fx('Stores7290639000004-000-20261105-055500.xml')],
      full: { 2: ['PriceFull7290639000004-001-002-20261107-010011.gz', fx('PriceFull7290639000004-001-002-20261107-010011.gz')] },
    },
    osherad: { stores: ['Stores7290103152017-000-20261105-060000.gz', gz(stores('7290103152017', 'אושר עד', [['011', 'אושר עד הקישון', 'הקישון 11', '6100']]))], full: {} },
    victoryfake: { stores: ['Stores7290000000001-000-20261105-060000.gz', gz(stores('7290000000001', 'ויקטורי', [['005', 'ויקטורי רמת גן', 'ביאליק 9', '8600']]))], full: {} },
  },
};
const CITIES = [{ 'סמל_ישוב': 8600, 'שם_ישוב': 'רמת גן   ' }, { 'סמל_ישוב': 6100, 'שם_ישוב': 'בני ברק' }, { 'סמל_ישוב': 6400, 'שם_ישוב': 'הרצליה' }, { 'סמל_ישוב': 6600, 'שם_ישוב': 'חולון' },
  { 'סמל_ישוב': 4000, 'שם_ישוב': 'חיפה' }, { 'סמל_ישוב': 7400, 'שם_ישוב': 'נתניה' }, { 'סמל_ישוב': 9700, 'שם_ישוב': 'הוד השרון' }, { 'סמל_ישוב': 8300, 'שם_ישוב': 'ראשון לציון' }];

// Tests: replace the PriceFull file a branch serves (chain is shufersal, carrefour, rami_levy or stop_market). Returns a function that restores it.
export function replaceFull(chain, storeId, name, bytes) {
  const slot = { shufersal: FILES.shufersal.full, carrefour: FILES.carrefour.full, rami_levy: FILES.shared.RamiLevi.full, stop_market: FILES.shared.Stop_Market.full }[chain];
  const old = slot[storeId];
  slot[storeId] = [name, bytes];
  return () => { if (old) slot[storeId] = old; else delete slot[storeId]; };
}
export const gzipXml = gz;

export async function startFakePortals({ port = 0 } = {}) {
  const state = { down: new Set(), hits: {}, cities: true, log: [] };
  const sessions = new Map(); // sid -> user
  const send = (res, code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };
  const cookieOf = (req, n) => (req.headers.cookie || '').split(/;\s*/).map((x) => x.split('=')).find(([k]) => k === n)?.[1];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const [, area, ...rest] = u.pathname.split('/');
    const hit = (k) => { state.hits[k] = (state.hits[k] || 0) + 1; };
    state.log.push(`${req.method} ${u.pathname}${u.search}`);
    let body = '';
    for await (const c of req) body += c;
    const form = new URLSearchParams(body);
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      if (state.down.has(area)) return send(res, 503, 'down');
      if (area === 'gov') { hit('gov'); return state.cities ? send(res, 200, JSON.stringify({ result: { records: CITIES } }), { 'content-type': 'application/json' }) : send(res, 500, 'no'); }

      if (area === 'shufersal') {
        hit('shufersal');
        if (rest[0] === 'FileObject') {
          const cat = u.searchParams.get('catID'), id = Number(u.searchParams.get('storeId') || 0);
          const link = (n) => `<a href="${origin}/shufersal/files/${n}?sv=1&amp;sig=abc">${n}</a>`;
          if (cat === '5') return send(res, 200, `<html>${link(FILES.shufersal.stores[0])}</html>`);
          if (cat === '2') {
            const f = FILES.shufersal.full[id];
            return send(res, 200, `<html>${f ? link(f[0]) : ''}${link(FILES.shufersal.delta(id)[0])}</html>`);
          }
        }
        if (rest[0] === 'files') {
          const n = rest[1];
          const all = [FILES.shufersal.stores, ...Object.values(FILES.shufersal.full), FILES.shufersal.delta(17), FILES.shufersal.delta(18)];
          const f = all.find((x) => x[0] === n);
          return f ? send(res, 200, f[1]) : send(res, 404, 'nf');
        }
      }

      if (area === 'carrefour') {
        hit('carrefour');
        const names = [FILES.carrefour.stores[0], ...Object.values(FILES.carrefour.full).map((f) => f[0]), 'Price7290055700007-001-981-20261107-060000.gz'];
        if (rest.length === 0 || rest[0] === '') {
          return send(res, 200, `<html><script>const path = '4242'; const files = [${names.map((n) => `{"name":"${n}","size":1}`).join(',')}];</script></html>`);
        }
        if (rest[0] === '4242') {
          const n = rest[1];
          const f = [FILES.carrefour.stores, ...Object.values(FILES.carrefour.full)].find((x) => x[0] === n);
          return f ? send(res, 200, f[1]) : send(res, 404, 'nf');
        }
      }

      if (area === 'shared') {
        hit('shared');
        const sub = '/' + rest.join('/');
        const user = sessions.get(cookieOf(req, 'cftpSID'));
        if (sub === '/login') return send(res, 200, '<html><meta name="csrftoken" content="LOGIN-TOKEN"></html>');
        if (sub === '/login/user') {
          const ok = form.get('csrftoken') === 'LOGIN-TOKEN' && form.get('password') === '' && FILES.shared[form.get('username')];
          if (!ok) return send(res, 302, '', { location: '/shared/login' });
          const sid = `sid-${sessions.size + 1}`;
          sessions.set(sid, form.get('username'));
          return send(res, 302, '', { location: '/shared/file', 'set-cookie': `cftpSID=${sid}; Path=/; HttpOnly` });
        }
        if (!user) return send(res, 302, '', { location: '/shared/login' });
        const data = FILES.shared[user];
        if (sub === '/file') return send(res, 200, `<html><meta name="csrftoken" content="FILE-${user}"></html>`);
        if (sub === '/file/json/dir') {
          if (form.get('csrftoken') !== `FILE-${user}`) return send(res, 403, 'csrf');
          const q = form.get('sSearch') || '';
          const all = [data.stores, ...Object.values(data.full), ...(data.extra || [])];
          const rows = all.filter(([n]) => n.includes(q)).map(([n, b]) => ({ fname: n, size: b.length, time: '2026-11-07 05:00' }));
          return send(res, 200, JSON.stringify({ sEcho: 1, iTotalRecords: rows.length, aaData: rows }), { 'content-type': 'application/json' });
        }
        if (sub.startsWith('/file/d/')) {
          const n = decodeURIComponent(sub.slice(8));
          const f = [data.stores, ...Object.values(data.full), ...(data.extra || [])].find((x) => x[0] === n);
          return f ? send(res, 200, f[1]) : send(res, 404, 'nf');
        }
      }
      return send(res, 404, 'nf');
    } catch (e) { return send(res, 500, String(e)); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state, base,
    urls: { shufersal: `${base}/shufersal`, shared: `${base}/shared`, carrefour: `${base}/carrefour`, cities: `${base}/gov/datastore_search` },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = await startFakePortals({ port: Number(process.argv[2] || 0) });
  console.log(JSON.stringify(f.urls));
}
