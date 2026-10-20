const TOKEN_KEY = 'funnels.token';
const REFRESH_KEY = 'funnels.refresh';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export const tokenStore = {
  get: (): string | null => read(TOKEN_KEY),
  getRefresh: (): string | null => read(REFRESH_KEY),
  set(token: string, refreshToken?: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    } catch {
      /* storage unavailable: the session lasts until reload */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};

let refreshing: Promise<boolean> | null = null;

/**
 * Renews the access token with the stored refresh token (which the server rotates: the response carries the next one). One refresh at a time per tab; when
 * another tab wins the race (`REFRESH_RACE`) its tokens are already in storage, so this waits briefly and uses them. False means the session is over.
 */
export function refreshTokens(): Promise<boolean> {
  const rt = tokenStore.getRefresh();
  if (!rt) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (res.ok) {
        const j = (await res.json()) as { token: string; refreshToken: string };
        tokenStore.set(j.token, j.refreshToken);
        return true;
      }
      const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      if (code === 'REFRESH_RACE') {
        await new Promise((r) => setTimeout(r, 300));
        return tokenStore.getRefresh() !== rt && !!tokenStore.get();
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export const UNAUTHORIZED_EVENT = 'funnels:unauthorized';

/** An error response in the server's `{ error: { code, message, details } }` shape (or a network failure with status 0). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Per-field messages from either `details.fields` (form submissions) or zod-style `details: [{ path, message }]`. */
  get fieldErrors(): Record<string, string> {
    const d = this.details as unknown;
    if (Array.isArray(d)) {
      return Object.fromEntries(d.filter((i) => i && typeof i.path === 'string' && typeof i.message === 'string').map((i) => [i.path as string, i.message as string]));
    }
    const fields = (d as { fields?: unknown } | undefined)?.fields;
    return fields && typeof fields === 'object' ? (fields as Record<string, string>) : {};
  }
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Set false for endpoints that must not carry credentials (login/register). */
  auth?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = opts.auth === false ? null : tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body: handled below */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && token) {
      // An expired access token is routine: renew it once and repeat the request. Anything else (revoked session, bad refresh token) ends the session.
      if (!retried && (await refreshTokens())) return request<T>(method, path, opts, true);
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, opts: Pick<RequestOptions, 'auth'> = {}) => request<T>('POST', path, { body, ...opts }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  delete: <T = void>(path: string, query?: RequestOptions['query']) => request<T>('DELETE', path, { query }),
};

/** Downloads an authenticated CSV endpoint through the browser. */
export async function downloadFile(path: string, filename: string, query?: RequestOptions['query']): Promise<void> {
  const get = () => fetch(buildUrl(path, query), { headers: tokenStore.get() ? { authorization: `Bearer ${tokenStore.get()}` } : {} });
  let res = await get();
  if (res.status === 401 && (await refreshTokens())) res = await get();
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'The export could not be downloaded');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
