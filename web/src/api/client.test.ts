import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, buildUrl, errorMessage, tokenStore, UNAUTHORIZED_EVENT } from './client';

const respond = (status: number, body?: unknown) => vi.fn().mockResolvedValue(new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status }));

beforeEach(() => vi.stubGlobal('fetch', respond(200, {})));
afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends the bearer token and JSON body', async () => {
    tokenStore.set('tok');
    const f = respond(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    expect(await api.post('/api/x', { a: 1 })).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('omits credentials for login and builds query strings', async () => {
    tokenStore.set('tok');
    const f = respond(200, {});
    vi.stubGlobal('fetch', f);
    await api.post('/api/auth/login', {}, { auth: false });
    expect(f.mock.calls[0]![1].headers.authorization).toBeUndefined();
    expect(buildUrl('/a', { x: 1, y: '', z: undefined, w: 'a b' })).toBe('/a?x=1&w=a+b');
    expect(buildUrl('/a?q=1', { x: 2 })).toBe('/a?q=1&x=2');
  });

  it('turns error responses into ApiError with code, message and details', async () => {
    vi.stubGlobal('fetch', respond(409, { error: { code: 'PATH_CONFLICT', message: 'Taken', details: { conflicts: [1] } } }));
    const e = await api.get('/api/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'PATH_CONFLICT', message: 'Taken', details: { conflicts: [1] } });
    expect(errorMessage(e)).toBe('Taken');
  });

  it('exposes field errors from both server shapes', () => {
    expect(new ApiError(422, 'VALIDATION_ERROR', 'm', { fields: { email: 'bad' } }).fieldErrors).toEqual({ email: 'bad' });
    expect(new ApiError(400, 'VALIDATION_ERROR', 'm', [{ path: 'name', message: 'Required' }, { nope: 1 }]).fieldErrors).toEqual({ name: 'Required' });
    expect(new ApiError(400, 'X', 'm').fieldErrors).toEqual({});
  });

  it('handles non-JSON error bodies, 204 and network failures', async () => {
    vi.stubGlobal('fetch', respond(502, '<html>Bad gateway</html>'));
    expect(await api.get('/x').catch((e) => e)).toMatchObject({ status: 502, code: 'HTTP_ERROR', message: 'Request failed (502)' });
    vi.stubGlobal('fetch', respond(204));
    expect(await api.delete('/x')).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await api.get('/x').catch((e) => e)).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(errorMessage('weird')).toBe('Something went wrong');
  });

  it('announces 401 for authenticated calls so the app can sign out', async () => {
    tokenStore.set('expired');
    const seen = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, seen);
    vi.stubGlobal('fetch', respond(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
    await api.get('/api/funnels').catch(() => undefined);
    expect(seen).toHaveBeenCalledTimes(1);
    tokenStore.clear();
    await api.get('/api/funnels').catch(() => undefined);
    expect(seen).toHaveBeenCalledTimes(1); // no token, no sign-out loop
    window.removeEventListener(UNAUTHORIZED_EVENT, seen);
  });
});

describe('token refresh', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('renews an expired access token with the refresh token and repeats the request once', async () => {
    tokenStore.set('old', 'rt_old');
    const calls: string[] = [];
    const f = vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      calls.push(`${url} ${init.headers?.authorization ?? ''}`);
      if (url === '/api/auth/refresh') return json(200, { token: 'new', refreshToken: 'rt_new' });
      return init.headers.authorization === 'Bearer new' ? json(200, { ok: true }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    });
    vi.stubGlobal('fetch', f);
    expect(await api.get('/api/funnels')).toEqual({ ok: true });
    expect(calls).toEqual(['/api/funnels Bearer old', '/api/auth/refresh ', '/api/funnels Bearer new']);
    expect(tokenStore.get()).toBe('new');
    expect(tokenStore.getRefresh()).toBe('rt_new'); // the rotated refresh token replaced the old one
  });

  it('several requests failing at once share one refresh (the server spends a refresh token on use)', async () => {
    tokenStore.set('old', 'rt_old');
    let refreshes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      if (url === '/api/auth/refresh') {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { token: 'new', refreshToken: 'rt_new' });
      }
      return init.headers.authorization === 'Bearer new' ? json(200, { ok: true }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    }));
    await Promise.all([api.get('/api/a'), api.get('/api/b'), api.get('/api/c')]);
    expect(refreshes).toBe(1);
  });

  it('ends the session (event) when the refresh token is refused, and does not loop', async () => {
    tokenStore.set('old', 'rt_old');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      return json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
    }));
    let ended = 0;
    const on = () => ended++;
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    await expect(api.get('/api/funnels')).rejects.toMatchObject({ status: 401 });
    window.removeEventListener(UNAUTHORIZED_EVENT, on);
    expect(seen).toEqual(['/api/funnels', '/api/auth/refresh']);
    expect(ended).toBe(1);
  });

  it('a refresh lost to another tab (REFRESH_RACE) uses the tokens that tab stored', async () => {
    tokenStore.set('old', 'rt_old');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      if (url === '/api/auth/refresh') {
        tokenStore.set('from-other-tab', 'rt_other'); // the other tab's refresh finished first and stored its result
        return json(401, { error: { code: 'REFRESH_RACE', message: 'just used' } });
      }
      return init.headers.authorization === 'Bearer from-other-tab' ? json(200, { ok: true }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    }));
    expect(await api.get('/api/funnels')).toEqual({ ok: true });
  });

  it('does not try to refresh without a refresh token or for requests that carry no credentials', async () => {
    tokenStore.clear();
    const f = vi.fn(async () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } }));
    vi.stubGlobal('fetch', f);
    await expect(api.post('/api/auth/login', {}, { auth: false })).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
