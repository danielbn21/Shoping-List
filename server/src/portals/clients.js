import { PortalError } from './http.js';

export const DEFAULT_URLS = {
  shufersal: 'https://prices.shufersal.co.il',
  shared: 'https://url.publishedprices.co.il',
  carrefour: 'https://prices.carrefour.co.il',
};

// File names look like  PriceFull7290058140886-001-001-20261107-001000.gz : the date and time are the freshness.
export const stampOf = (name) => { const m = /(\d{8})-(\d{6})/.exec(name); return m ? m[1] + m[2] : ''; };
export const newestFirst = (files) => [...files].sort((a, b) => (stampOf(b.name) || b.name).localeCompare(stampOf(a.name) || a.name));
const pad3 = (id) => String(parseInt(id, 10)).padStart(3, '0');
// PriceFull<chainId>-<subChain>-<store>-<date>-<time>.gz : compare the store segment only. The plugin looks for -<store>- anywhere in the
// name, which also matches the sub-chain segment (-001- in every Rami Levy file), so store 1 would pick up some other branch's file.
export const storeOfName = (name) => /^[A-Za-z]+\d+-\d+-(\d+)-\d{8}-\d{6}/.exec(name)?.[1] ?? null;
const forBranch = (files, storeId) => files.filter((f) => {
  const s = storeOfName(f.name);
  return s !== null ? parseInt(s, 10) === parseInt(storeId, 10) : f.name.includes(`-${pad3(storeId)}-`);
});
const nameOfUrl = (u) => decodeURIComponent(u.split('?')[0].split('/').pop() || u);
const csrfOf = (html) => /name="csrftoken"\s+content="([^"]+)"/.exec(html)?.[1] ?? /content="([^"]+)"\s+name="csrftoken"/.exec(html)?.[1];

// Behaviour ported from the il-supermarket-compare plugin (chains.py). One "access" object per chain and job.
export function createPortals({ http, baseUrls = {} }) {
  const base = { ...DEFAULT_URLS, ...baseUrls };
  const get = (url, o) => http.request(url, o);

  // ---- Shufersal: https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=<n>&storeId=<id> ; catID 5 = Stores, 2 = PriceFull
  const shufersal = () => {
    const links = async (cat, storeId = 0) => {
      const html = (await get(`${base.shufersal}/FileObject/UpdateCategory?catID=${cat}&storeId=${storeId}`)).text().replace(/&amp;/g, '&');
      return [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => ({ name: nameOfUrl(m[1]), url: m[1] }));
    };
    return {
      async probe() { return { detail: `${(await links(5)).length} Stores link(s)` }; },
      async stores() {
        const all = newestFirst(await links(5));
        if (!all.length) throw new PortalError('no_stores_file', 'no Stores file link found');
        return { name: all[0].name, files: all.slice(0, 5), bytes: (await get(all[0].url, { timeout: 120_000 })).buffer };
      },
      async priceFullList(storeId) { return newestFirst((await links(2, storeId)).filter((f) => f.name.includes('PriceFull'))); },
      async priceFull(storeId) {
        const f = (await this.priceFullList(storeId))[0];
        if (!f) throw new PortalError('no_pricefull', `no PriceFull file published for store ${storeId} (closed today / Shabbat?)`);
        return { name: f.name, bytes: (await get(f.url, { timeout: 300_000 })).buffer };
      },
    };
  };

  // ---- Shared portal (url.publishedprices.co.il): log in with the chain's public username and an empty password
  const shared = (user) => {
    let sess;
    const login = async () => {
      if (sess) return sess;
      const jar = http.newJar();
      const page = (await get(`${base.shared}/login`, { jar })).text();
      const tok = csrfOf(page);
      if (!tok) throw new PortalError('login_page', 'login page has no csrf token (portal changed?)');
      await get(`${base.shared}/login/user`, { method: 'POST', form: { username: user, password: '', csrftoken: tok }, jar });
      const filePage = await get(`${base.shared}/file`, { jar });
      const tok2 = new URL(filePage.url).pathname.startsWith('/login') || /\/login\/?$/.test(new URL(filePage.url).pathname) ? null : csrfOf(filePage.text());
      if (!tok2) throw new PortalError('login_failed', `publishedprices login failed for ${user}`);
      sess = { jar, tok: tok2 };
      return sess;
    };
    const list = async (search) => {
      const s = await login();
      const r = await get(`${base.shared}/file/json/dir`, { method: 'POST', jar: s.jar, form: { sEcho: 1, iDisplayStart: 0, iDisplayLength: 100000, sSearch: search, cd: '/', csrftoken: s.tok } });
      let j;
      try { j = JSON.parse(r.text()); } catch { throw new PortalError('bad_listing', 'file listing is not JSON'); }
      const rows = (j.aaData || []).filter((x) => x && typeof x === 'object');
      const files = rows.map((x) => ({ name: String(x.fname ?? ''), size: x.size ?? x.fsize ?? null, time: x.time ?? x.ftime ?? x.date ?? null })).filter((f) => f.name);
      return { files: newestFirst(files), rawKeys: rows[0] ? Object.keys(rows[0]) : [] };
    };
    const dl = async (name) => { const s = await login(); return (await get(`${base.shared}/file/d/${name}`, { jar: s.jar, timeout: 300_000 })).buffer; };
    return {
      async probe() { await login(); return { detail: 'logged in' }; },
      async stores() {
        const { files } = await list('Stores');
        const f = files.find((x) => x.name.startsWith('Stores')) || files[0];
        if (!f) throw new PortalError('no_stores_file', 'no Stores file listed');
        return { name: f.name, files: files.slice(0, 5), bytes: await dl(f.name) };
      },
      async priceFullList(storeId) { const r = await list('PriceFull'); this.rawKeys = r.rawKeys; return forBranch(r.files.filter((f) => f.name.startsWith('PriceFull')), storeId); },
      async priceFull(storeId) {
        const f = (await this.priceFullList(storeId))[0];
        if (!f) throw new PortalError('no_pricefull', `no PriceFull file published for store ${storeId} (closed today / Shabbat?)`);
        return { name: f.name, bytes: await dl(f.name) };
      },
    };
  };

  // ---- Carrefour: the home page lists files in a script (const path = '<digits>' and "name":"<file>" entries)
  const carrefour = () => {
    let idx;
    const index = async () => {
      if (idx) return idx;
      const html = (await get(`${base.carrefour}/`)).text();
      const path = /const path = '(\d+)'/.exec(html)?.[1];
      if (!path) throw new PortalError('index_page', 'Carrefour index page has no file path (portal changed?)');
      const names = [...new Set([...html.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]))];
      idx = { path, files: newestFirst(names.map((name) => ({ name }))) };
      return idx;
    };
    const dl = async (name) => { const i = await index(); return (await get(`${base.carrefour}/${i.path}/${name}`, { timeout: 300_000 })).buffer; };
    return {
      async probe() { return { detail: `${(await index()).files.length} file(s) listed` }; },
      async stores() {
        const f = (await index()).files.filter((x) => x.name.startsWith('Stores'));
        if (!f.length) throw new PortalError('no_stores_file', 'no Stores file listed');
        return { name: f[0].name, files: f.slice(0, 5), bytes: await dl(f[0].name) };
      },
      async priceFullList(storeId) { return forBranch((await index()).files.filter((x) => x.name.startsWith('PriceFull')), storeId); },
      async priceFull(storeId) {
        const f = (await this.priceFullList(storeId))[0];
        if (!f) throw new PortalError('no_pricefull', `no PriceFull file published for store ${storeId} (closed today / Shabbat?)`);
        return { name: f.name, bytes: await dl(f.name) };
      },
    };
  };

  return {
    baseUrls: base,
    open(chain) {
      if (chain.platform === 'shufersal') return shufersal();
      if (chain.platform === 'carrefour') return carrefour();
      if (chain.platform === 'shared') return shared(chain.user);
      throw new PortalError('unsupported', `chain ${chain.id} has no portal client`);
    },
  };
}
