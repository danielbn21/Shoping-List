export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public body?: any) {
    super(code);
  }
}

type Opts = { method?: string; body?: unknown };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const hasBody = opts.body !== undefined || (method !== 'GET' && method !== 'DELETE');
  const headers: Record<string, string> = { 'X-SL-Client': 'web' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  // fetch() itself throws TypeError on network failure; callers treat non-ApiError as "offline".
  const res = await fetch('/api' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'server_error', data?.detail, data);
  return data as T;
}

// Receipt photos go up as raw image bytes (already compressed in the browser).
export async function apiUpload<T = any>(path: string, blob: Blob): Promise<T> {
  const res = await fetch('/api' + path, {
    method: 'POST', credentials: 'same-origin', body: blob,
    headers: { 'Content-Type': blob.type || 'image/jpeg', 'X-SL-Client': 'web' },
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'server_error', data?.detail, data);
  return data as T;
}
