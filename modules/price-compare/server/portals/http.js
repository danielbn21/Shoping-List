// A tiny HTTP helper for the retailer portals: User-Agent, timeouts, size limit, a per-session cookie jar and manual redirects
// (the shared portal sets its session cookie on a redirect response, which plain fetch would drop). TLS verification stays on.
export const USER_AGENT = 'il-supermarket-compare/1.0 (personal price comparison; shoplist)';

export class PortalError extends Error {
  constructor(code, message, extra = {}) { super(message || code); this.code = code; Object.assign(this, extra); }
}

export function createHttp({ fetchImpl = globalThis.fetch, timeoutMs = 60_000, maxBytes = 150 * 1024 * 1024 } = {}) {
  const newJar = () => new Map(); // host -> Map(name -> value)

  const cookieHeader = (jar, url) => {
    const c = jar?.get(new URL(url).host);
    return c && c.size ? [...c].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  };
  const storeCookies = (jar, url, res) => {
    if (!jar) return;
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (!list.length) return;
    const host = new URL(url).host;
    const c = jar.get(host) ?? new Map();
    for (const raw of list) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      if (i > 0) { const v = pair.slice(i + 1).trim(); if (v) c.set(pair.slice(0, i).trim(), v); else c.delete(pair.slice(0, i).trim()); }
    }
    jar.set(host, c);
  };

  async function request(url, { method = 'GET', headers = {}, body, form, jar, timeout = timeoutMs, maxRedirects = 6 } = {}) {
    let cur = url, m = method, payload = body;
    const h = { 'user-agent': USER_AGENT, accept: '*/*', ...headers };
    if (form) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      let res;
      try {
        const ck = cookieHeader(jar, cur);
        res = await fetchImpl(cur, { method: m, headers: ck ? { ...h, cookie: ck } : h, body: m === 'GET' || m === 'HEAD' ? undefined : payload, redirect: 'manual', signal: ctl.signal });
        storeCookies(jar, cur, res);
        if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
          clearTimeout(timer);
          cur = new URL(res.headers.get('location'), cur).toString();
          if (res.status !== 307 && res.status !== 308) { m = 'GET'; payload = undefined; delete h['content-type']; }
          continue;
        }
        if (res.status >= 400) throw new PortalError('http_error', `HTTP ${res.status} from ${new URL(cur).host}`, { status: res.status });
        const len = Number(res.headers.get('content-length') || 0);
        if (len > maxBytes) throw new PortalError('too_large', `file larger than ${maxBytes} bytes`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new PortalError('too_large', `file larger than ${maxBytes} bytes`);
        return { status: res.status, url: cur, headers: res.headers, buffer: buf, text: () => buf.toString('utf8') };
      } catch (e) {
        if (e instanceof PortalError) throw e;
        if (e?.name === 'AbortError') throw new PortalError('timeout', `no answer from ${new URL(cur).host} within ${Math.round(timeout / 1000)} s`);
        throw new PortalError('network', `${e?.cause?.code || e?.code || 'network error'} reaching ${new URL(cur).host}`);
      } finally { clearTimeout(timer); }
    }
    throw new PortalError('too_many_redirects', 'too many redirects');
  }
  return { request, newJar };
}
