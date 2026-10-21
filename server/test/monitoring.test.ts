import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMonitor, isValidDsn, workspaceTag, type Monitor } from '../src/monitoring/index.js';
import { fingerprintOf, isExpectedError, NoiseLimiter, scrubEvent, scrubFilename, scrubText, scrubTransaction, templatePath } from '../src/monitoring/scrub.js';
import { AppError } from '../src/errors.js';
import { makeHarness } from './helpers.js';

// Sentry with a FAKE transport: nothing here reaches a network. The scrubber is tested directly, then the whole path (app, jobs, admin) through the real SDK.
process.setMaxListeners(100); // every init of the SDK adds process listeners; the tests init it many times
const DSN = 'https://publickey123@o1.ingest.example.test/42';

interface Captured { type: 'event' | 'transaction'; payload: any }
const everySent: string[] = [];
function fakeTransport(opts: { delayMs?: number } = {}) {
  const sent: Captured[] = [];
  const pending = new Set<Promise<unknown>>();
  const factory = () => ({
    send: (envelope: any) => {
      const p = (async () => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        for (const [header] of envelope[1]) everySent.push(header.type);
      for (const [header, payload] of envelope[1]) if (header.type === 'event' || header.type === 'transaction') sent.push({ type: header.type, payload });
        return {};
      })();
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },
    // like a real transport: flush waits for what is in flight
    flush: async () => {
      await Promise.all([...pending]);
      return true;
    },
  });
  return { sent, factory };
}

const cfg = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(40), SENTRY_DSN: DSN, ...env });

const open: Monitor[] = [];
async function monitorWith(env: Record<string, string> = {}, t = fakeTransport()) {
  const m = await createMonitor(cfg(env), { transport: t.factory });
  open.push(m);
  return { m, t };
}
afterEach(async () => {
  for (const m of open.splice(0)) await m.close(500);
});

const eventsOf = (t: { sent: Captured[] }) => t.sent.filter((s) => s.type === 'event').map((s) => s.payload);
const until = async (cond: () => boolean, ms = 3000) => {
  for (const start = Date.now(); !cond() && Date.now() - start < ms; ) await new Promise((r) => setTimeout(r, 20));
};

describe('scrubber', () => {
  const dirty = () => ({
    event_id: 'a'.repeat(32), timestamp: 1_800_000_000, platform: 'node', level: 'error', release: 'abc1234', environment: 'production', server_name: 'render-host-1',
    message: 'Failed for ada@example.com with Bearer abc.def.ghi and key sk_live_51Habcdefghij',
    request: {
      method: 'POST', url: 'https://app.example.com/api/funnels/fn_0mvhmtceq000aWXj9s2e/steps?token=SECRET123&email=a@b.co',
      headers: { authorization: 'Bearer eyJhbGciOi.eyJzdWIiOi.sig', cookie: 'visitor_id=abc; session=xyz', 'x-api-key': 'k-123456789012345678901234567890123' },
      cookies: { session: 'xyz' }, data: { email: 'lead@example.com', name: 'Lee', card: '4242424242424242' }, query_string: 'token=SECRET123',
    },
    user: { id: 'u1', email: 'ada@example.com', ip_address: '203.0.113.7', username: 'ada' },
    breadcrumbs: [{ message: 'clicked "Buy now" by ada@example.com', data: { url: '/checkout?token=abc' } }],
    extra: { form: { fields: [{ name: 'email', value: 'lead@example.com' }, { name: 'phone', value: '+1 555 0100' }], pageHtml: '<h1>Secret offer</h1>' }, nested: { deep: { token: 'zzz' } }, list: ['a@b.co', { k: 'sk_test_abcdefghij' }] },
    contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), op: 'http.server' }, runtime: { name: 'node', version: 'v22.1.0' }, device: { name: 'host', memory_size: 123 }, os: { name: 'Linux', kernel_version: '5.15' }, app: { app_name: 'x' } },
    tags: { request_id: 'req-123', route: '/api/funnels/:id/steps', workspace: 'abcdef012345', plan: 'free', email: 'ada@example.com', custom: 'anything', kind: 'request' },
    exception: { values: [{ type: 'Error', value: 'duplicate key value violates unique constraint "idx_x" Key (email)=(ada@example.com) at 10.0.0.12 token=abc123', mechanism: { type: 'generic', handled: false },
      stacktrace: { frames: [{ filename: '/Users/build/app/server/src/services/leads.ts', function: 'submitForm', lineno: 10, colno: 3, in_app: true, vars: { email: 'ada@example.com' }, pre_context: ['const secret = 1'], context_line: 'throw new Error(email)' }] } }] },
    sdk: { name: 'sentry.javascript.node', version: '11.8.0', integrations: ['Http'] },
    modules: { express: '1.0.0' },
  });

  it('keeps only the allow-listed fields: no request data, headers, cookies, user, breadcrumbs, extra, vars, device or server name', () => {
    const out = scrubEvent(dirty() as any) as any;
    const text = JSON.stringify(out);
    for (const secret of ['ada@example.com', 'lead@example.com', 'SECRET123', 'eyJhbGciOi', 'visitor_id=abc', 'xyz', '203.0.113.7', '4242424242424242', 'Secret offer', '+1 555 0100', 'sk_live_51Habcdefghij', 'sk_test_abcdefghij', 'k-1234567890', 'render-host-1', '10.0.0.12', 'throw new Error', 'const secret', 'Buy now', 'Linux', 'express', '/Users/build']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(out).not.toHaveProperty('user');
    expect(out).not.toHaveProperty('breadcrumbs');
    expect(out).not.toHaveProperty('extra');
    expect(out).not.toHaveProperty('server_name');
    expect(out).not.toHaveProperty('modules');
    expect(out.request).toEqual({ method: 'POST' });
    expect(out.contexts).toEqual({ trace: expect.objectContaining({ trace_id: 'b'.repeat(32) }), runtime: { name: 'node', version: 'v22.1.0' } });
    expect(out.tags).toEqual({ request_id: 'req-123', route: '/api/funnels/:id/steps', workspace: 'abcdef012345', plan: 'free', kind: 'request' });
    expect(out.exception.values[0].stacktrace.frames[0]).toEqual({ filename: 'src/services/leads.ts', function: 'submitForm', lineno: 10, colno: 3, in_app: true, module: undefined });
    expect(out.exception.values[0].type).toBe('Error');
    expect(out.exception.values[0].value).toContain('[email]');
    expect(out.message).toContain('[email]');
    expect(out.release).toBe('abc1234');
  });

  it('scrubs free text: emails, tokens, keys, addresses, query strings, key=value pairs; caps the length', () => {
    expect(scrubText('mail ada@example.com now')).toBe('mail [email] now');
    expect(scrubText('Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(scrubText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln here')).toContain('[jwt]');
    expect(scrubText('stripe sk_live_51Habcdefghij and whsec_abcdefghij and pk_test_abcdefghij')).not.toMatch(/sk_live|whsec_|pk_test/);
    expect(scrubText('google AIzaSyA-1234567890abcdefghijklmnopqrstu')).toContain('[google-key]');
    expect(scrubText('anthropic sk-ant-api03-abcdefghij')).toContain('[api-key]');
    expect(scrubText('GET https://x.example.com/a/b?token=abc&email=z@y.co failed')).toBe('GET https://x.example.com/a/b?[query] failed');
    expect(scrubText('password=hunter2 and api_key: "abc def"')).toBe('password=[redacted] and api_key: [redacted]');
    expect(scrubText('from 203.0.113.7 and 2001:db8:85a3:0:0:8a2e:370:7334')).toBe('from [ip] and [ip]');
    expect(scrubText('token ' + 'a1'.repeat(24))).toContain('[token]');
    expect(scrubText('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
    expect(scrubText(undefined)).toBe('');
    expect(scrubText({ toString: () => 'obj a@b.co' })).toBe('obj [email]');
  });

  it('turns raw URLs and ids into route patterns', () => {
    expect(templatePath('/api/funnels/fn_0mvhmtceq000aWXj9s2e/steps/stp_abcdef123456?token=1')).toBe('/api/funnels/:id/steps/:id');
    expect(templatePath('POST /api/leads/1234')).toBe('POST /api/leads/:id');
    expect(templatePath('/api/funnels/:id/steps/:sid')).toBe('/api/funnels/:id/steps/:sid');
    expect(templatePath('/s/acme/free-guide/thanks')).toBe('/s/acme/free-guide/thanks');
    expect(templatePath('/api/x/550e8400-e29b-41d4-a716-446655440000')).toBe('/api/x/:id');
    expect(scrubFilename('https://app.example.com/assets/index-abc.js?x=1')).toBe('assets/index-abc.js');
    expect(scrubFilename('/srv/app/node_modules/hono/dist/x.js')).toBe('node_modules/hono/dist/x.js');
  });

  it('transactions keep route, timing and status only (no span descriptions or data)', () => {
    const out = scrubTransaction({
      type: 'transaction', transaction: 'GET /api/funnels/fn_0mvhmtceq000aWXj9s2e', start_timestamp: 1, timestamp: 2, release: 'r',
      request: { url: 'https://a/b?token=1', headers: { cookie: 'x' } }, user: { email: 'a@b.co' },
      contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), op: 'http.server', status: 'ok', data: { 'http.url': 'https://a/b?token=1' } } },
      spans: [{ span_id: 'd'.repeat(16), parent_span_id: 'c'.repeat(16), trace_id: 'b'.repeat(32), op: 'db', description: 'SELECT * FROM users WHERE email = \'a@b.co\'', data: { sql: 'x' }, start_timestamp: 1, timestamp: 2, status: 'ok' }],
    } as any) as any;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/a@b\.co|token=1|SELECT|cookie|http\.url/);
    expect(out.transaction).toBe('GET /api/funnels/:id');
    expect(out.spans[0]).toEqual({ span_id: 'd'.repeat(16), parent_span_id: 'c'.repeat(16), trace_id: 'b'.repeat(32), op: 'db', start_timestamp: 1, timestamp: 2, status: 'ok' });
  });

  it('knows what is expected and not worth a report', () => {
    for (const e of [new AppError(400, 'VALIDATION_ERROR', 'x'), new AppError(404, 'NOT_FOUND', 'x'), new AppError(429, 'RATE_LIMITED', 'x'), new AppError(503, 'INGEST_BACKPRESSURE', 'x'), Object.assign(new Error('aborted'), { name: 'AbortError' }), new Error('socket hang up'), Object.assign(new Error('x'), { name: 'ZodError' }), new Error('read ECONNRESET')]) {
      expect(isExpectedError(e), String((e as Error).message)).toBe(true);
    }
    for (const e of [new Error('boom'), new TypeError('x is undefined'), new AppError(500, 'INTERNAL_ERROR', 'x'), new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'x')]) expect(isExpectedError(e), String(e.message)).toBe(false);
  });

  it('limits noisy errors per fingerprint and globally, and the window resets', () => {
    let now = 0;
    const l = new NoiseLimiter({ perFingerprint: 3, global: 5, windowMs: 1000, now: () => now });
    expect([1, 2, 3, 4, 5].map(() => l.allow('a'))).toEqual([true, true, true, false, false]);
    expect(l.allow('b')).toBe(true);
    expect(l.allow('c')).toBe(true);
    expect(l.allow('d')).toBe(false); // global cap of 5
    now = 1001;
    expect(l.allow('a')).toBe(true);
    const e = { exception: { values: [{ type: 'Error', value: 'user 12345 failed in 99ms', stacktrace: { frames: [{ filename: '/x/src/a.ts', function: 'f', in_app: true }] } }] } };
    expect(fingerprintOf(e)).toBe(fingerprintOf({ exception: { values: [{ type: 'Error', value: 'user 777 failed in 1ms', stacktrace: { frames: [{ filename: '/y/src/a.ts', function: 'f', in_app: true }] } }] } }));
  });
});

describe('the monitor with a fake transport', () => {
  it('reports an unexpected error with request id, route pattern, hashed workspace and plan; nothing else', async () => {
    const { m, t } = await monitorWith({ SENTRY_RELEASE: 'rel-1', SENTRY_ENVIRONMENT: 'staging' });
    const id = m.captureError(new Error('boom for ada@example.com'), { requestId: 'req-1', route: '/api/funnels/fn_0mvhmtceq000aWXj9s2e/steps', workspaceId: 'ws_secret_id', plan: 'pro' });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await m.flush();
    const [e] = eventsOf(t);
    expect(e.tags).toMatchObject({ request_id: 'req-1', route: '/api/funnels/:id/steps', workspace: workspaceTag('ws_secret_id'), plan: 'pro', kind: 'request' });
    expect(workspaceTag('ws_secret_id')).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(e)).not.toContain('ws_secret_id');
    expect(JSON.stringify(e)).not.toContain('ada@example.com');
    expect(e.release).toBe('rel-1');
    expect(e.environment).toBe('staging');
    expect(e.exception.values[0].value).toContain('[email]');
    expect(e).not.toHaveProperty('user');
    expect(e).not.toHaveProperty('breadcrumbs');
  });

  it('turns every default data collection off (the SDK option that replaced sendDefaultPii) and defaults release and environment', async () => {
    const { m } = await monitorWith({ RENDER_GIT_COMMIT: 'abcdef1234567890' });
    const o = Sentry.getClient()!.getOptions() as any;
    expect(o.sendDefaultPii).toBe(false);
    expect(o.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false });
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.tracesSampleRate).toBe(0.05);
    expect(o.release).toBe('abcdef1234567890');
    expect(o.environment).toBe('test');
    expect(m.info).toMatchObject({ environment: 'test', release: 'abcdef1234567890', tracesSampleRate: 0.05, dsnHost: 'o1.ingest.example.test' });
    expect(JSON.stringify(m.info)).not.toContain('publickey123');
  });

  it('release falls back RENDER_GIT_COMMIT then GIT_SHA; SENTRY_RELEASE wins', async () => {
    expect((await monitorWith({ GIT_SHA: 'gitsha1' })).m.info.release).toBe('gitsha1');
    expect((await monitorWith({ GIT_SHA: 'gitsha1', RENDER_GIT_COMMIT: 'render1' })).m.info.release).toBe('render1');
    expect((await monitorWith({ GIT_SHA: 'gitsha1', RENDER_GIT_COMMIT: 'render1', SENTRY_RELEASE: 'explicit' })).m.info.release).toBe('explicit');
  });

  it('ignores expected errors and limits a crash loop to a handful of events', async () => {
    const { m, t } = await monitorWith();
    expect(m.captureError(new AppError(404, 'NOT_FOUND', 'x'))).toBeNull();
    expect(m.captureError(new AppError(429, 'RATE_LIMITED', 'x'))).toBeNull();
    for (let i = 0; i < 40; i++) m.captureError(new Error(`same failure number ${i}`));
    await m.flush();
    expect(eventsOf(t).length).toBe(5);
  });

  it('flushes on graceful shutdown: a slow transport still delivers before close() resolves', async () => {
    const t = fakeTransport({ delayMs: 150 });
    const m = await createMonitor(cfg(), { transport: t.factory });
    m.captureError(new Error('last words'));
    expect(t.sent).toHaveLength(0);
    expect(await m.close(3000)).toBe(true);
    expect(eventsOf(t).map((e) => e.exception.values[0].value)).toEqual(['last words']);
  });

  it('an invalid DSN does not crash anything: monitoring stays off and says so', async () => {
    const warn = vi.fn();
    for (const bad of ['not-a-dsn', 'https://nokey.example.com/1', 'https://k@host/abc', 'ftp://k@host/1']) {
      const m = await createMonitor(cfg({ SENTRY_DSN: bad }), { log: { warn, info: vi.fn() } });
      expect(m.enabled, bad).toBe(false);
      expect(m.captureError(new Error('x'))).toBeNull();
      expect(await m.flush()).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(isValidDsn(DSN)).toBe(true);
    // the whole app boots and serves with it
    const h = await makeHarness({ env: { SENTRY_DSN: 'garbage' } });
    expect((await h.call('GET', '/healthz')).status).toBe(200);
  });

  it('sends nothing but events and transactions: no sessions, no client reports, no breadcrumb or console data', async () => {
    const { m, t } = await monitorWith({ SENTRY_TRACES_SAMPLE_RATE: '1' });
    const client = Sentry.getClient();
    for (const kept of ['Dedupe', 'EventFilters', 'LinkedErrors', 'OnUncaughtException', 'OnUnhandledRejection']) expect(client?.getIntegrationByName(kept), kept).toBeTruthy();
    for (const gone of ['Console', 'Http', 'NodeFetch', 'ProcessSession', 'ContextLines', 'LocalVariablesAsync', 'Modules', 'RequestData']) expect(client?.getIntegrationByName(gone), gone).toBeUndefined();
    console.warn('a console line with ada@example.com'); // must never travel
    m.captureError(new Error('x'));
    m.startRequest('GET')!.end('/api/x', 200);
    await m.close(2000);
    expect(new Set(everySent)).toEqual(new Set(['event', 'transaction']));
    expect(JSON.stringify(t.sent)).not.toContain('a console line');
  });

  it('records sampled transactions with route patterns only', async () => {
    const { m, t } = await monitorWith({ SENTRY_TRACES_SAMPLE_RATE: '1' });
    const span = m.startRequest('GET');
    span!.end('/api/funnels/fn_0mvhmtceq000aWXj9s2e', 200);
    await m.flush();
    const tx = t.sent.find((s) => s.type === 'transaction')!.payload;
    expect(tx.transaction, JSON.stringify(tx)).toBe('GET /api/funnels/:id');
    expect(JSON.stringify(tx)).not.toMatch(/token|cookie|[a-z]@[a-z]/);
    expect((await monitorWith({ SENTRY_TRACES_SAMPLE_RATE: '0' })).m.startRequest('GET')).toBeNull();
  });
});

describe('through the app', () => {
  async function world(env: Record<string, string> = {}) {
    const t = fakeTransport();
    const monitor = await createMonitor(cfg(env), { transport: t.factory });
    open.push(monitor);
    const h = await makeHarness({ env: { SENTRY_DSN: DSN, ...env }, deps: { monitor } });
    const owner = await h.register();
    return { h, t, monitor, owner };
  }

  it('client errors are not reported: 400, 401, 404 and 429', async () => {
    const { h, t, monitor, owner } = await world({ AUTH_ATTEMPTS_PER_MINUTE: '2' });
    expect((await h.call('POST', '/api/funnels', { token: owner.token, body: { name: '' } })).status).toBe(400);
    expect((await h.call('GET', '/api/funnels')).status).toBe(401);
    expect((await h.call('GET', '/api/funnels/fn_missing', { token: owner.token })).status).toBe(404);
    for (let i = 0; i < 6; i++) await h.call('POST', '/api/auth/login', { body: { email: 'a@b.co', password: 'wrong-password' } });
    await monitor.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(eventsOf(t)).toHaveLength(0);
  });

  it('a 5xx is reported with the request id, the route pattern, the hashed workspace and the plan, and the response does not leak the cause', async () => {
    const { h, t, owner } = await world();
    const real = h.deps.db.get.bind(h.deps.db);
    const spy = vi.spyOn(h.deps.db, 'get').mockImplementation(((sql: string, ...p: any[]) => {
      if (/SELECT COUNT\(\*\) AS n FROM funnels f WHERE/.test(sql)) throw new Error('db exploded for ada@example.com token=abc123');
      return real(sql, ...p);
    }) as never);
    const res = await h.call('GET', '/api/funnels', { token: owner.token, headers: { 'x-request-id': 'req-from-client-1' } });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('ada@example.com');
    await until(() => eventsOf(t).length > 0);
    const [e] = eventsOf(t);
    expect(e.tags).toMatchObject({ request_id: 'req-from-client-1', route: '/api/funnels', workspace: workspaceTag(owner.wsId), plan: 'free', kind: 'request' });
    expect(JSON.stringify(e)).not.toMatch(/ada@example\.com|abc123|Bearer|authorization|wsId/i);
    expect(JSON.stringify(e)).not.toContain(owner.wsId);
    expect(JSON.stringify(e.request ?? {})).not.toMatch(/url|header|cookie|data/);
  });

  it('a 5xx AppError (a payment provider failing) is reported, a load-shedding 503 is not', async () => {
    const { h, t, monitor } = await world();
    const app = (await import('../src/app.js')).createApp(h.deps);
    app.get('/__boom', () => { throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not start the checkout'); });
    app.get('/__shed', () => { throw new AppError(503, 'INGEST_BACKPRESSURE', 'busy'); });
    expect((await app.request('/__boom')).status).toBe(502);
    expect((await app.request('/__shed')).status).toBe(503);
    await until(() => eventsOf(t).length > 0);
    await monitor.flush();
    expect(eventsOf(t)).toHaveLength(1);
    expect(eventsOf(t)[0].exception.values[0].value).toContain('payment provider');
  });

  it('a dead job is reported with its type (retries are not)', async () => {
    const { h, t, monitor } = await world();
    await h.deps.jobs.enqueue('no.such.job', { secret: 'ada@example.com' }, { maxAttempts: 1 });
    await h.worker.tick();
    await monitor.flush();
    const [e] = eventsOf(t);
    expect(e.tags).toMatchObject({ kind: 'job', job_type: 'no.such.job' });
    expect(JSON.stringify(e)).not.toContain('ada@example.com'); // the payload is never part of the report
  });

  it('GET /api/config serves the browser settings at runtime (SENTRY_WEB_DSN, else SENTRY_DSN), null without a DSN', async () => {
    const a = await world({ SENTRY_RELEASE: 'r9' });
    expect((await a.h.call('GET', '/api/config')).json).toEqual({ monitoring: { dsn: DSN, environment: 'test', release: 'r9', tracesSampleRate: 0 } });
    const web = 'https://webkey456@o1.ingest.example.test/43';
    const b = await world({ SENTRY_WEB_DSN: web });
    expect((await b.h.call('GET', '/api/config')).json.monitoring.dsn).toBe(web);
    const off = await makeHarness({});
    expect((await off.call('GET', '/api/config')).json).toEqual({ monitoring: null });
    const bad = await makeHarness({ env: { SENTRY_WEB_DSN: 'nope' } });
    expect((await bad.call('GET', '/api/config')).json).toEqual({ monitoring: null });
  });

  it('the admin test action: platform administrators only, sends one labelled event, never returns the DSN', async () => {
    const t = fakeTransport();
    const monitor = await createMonitor(cfg(), { transport: t.factory });
    open.push(monitor);
    const h = await makeHarness({ env: { SENTRY_DSN: DSN, PLATFORM_ADMIN_EMAILS: 'ops@example.test' }, deps: { monitor } });
    const ops = await h.register('ops@example.test', 'Ops');
    const user = await h.register('user@example.test', 'User');
    expect((await h.call('POST', '/api/admin/monitoring/test', { token: user.token })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/monitoring', { token: user.token })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/monitoring/test')).status).toBe(401);
    const status = await h.call('GET', '/api/admin/monitoring', { token: ops.token });
    expect(status.json).toMatchObject({ enabled: true, ingestHost: 'o1.ingest.example.test', browserEnabled: true });
    expect(status.text).not.toContain('publickey123');
    const r = await h.call('POST', '/api/admin/monitoring/test', { token: ops.token });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sent: true, flushed: true, eventId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(r.text).not.toContain('publickey123');
    const [e] = eventsOf(t);
    expect(e.exception.values[0].value).toMatch(/^Funnels test error: sent by a platform administrator at /);
    expect(e.tags.kind).toBe('test');
    expect((await h.call('GET', '/api/admin/stats', { token: ops.token })).status).toBe(200);
  });

  it('the admin test action says so when monitoring is off', async () => {
    const h = await makeHarness({ env: { PLATFORM_ADMIN_EMAILS: 'ops@example.test' } });
    const ops = await h.register('ops@example.test', 'Ops');
    const r = await h.call('POST', '/api/admin/monitoring/test', { token: ops.token });
    expect(r.json).toMatchObject({ enabled: false, sent: false, eventId: null });
  });
});
