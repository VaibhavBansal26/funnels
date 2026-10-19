import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobQueue, JobWorker, PermanentJobError, retryDelayMs } from '../src/jobs/queue.js';
import { assertPublicUrl, isBlockedIp, SsrfError } from '../src/net/ssrf.js';
import { silentLogger } from '../src/logger.js';
import { signPayload } from '../src/services/webhooks.js';
import { Db, migrate } from '../src/db/db.js';
import { formTarget, makeHarness, checkoutTarget, type Harness } from './helpers.js';

describe('isBlockedIp', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255', '192.0.0.1', '198.18.0.1',
    '::1', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2001:db8::1', '::127.0.0.1', '[::1]', 'not-an-ip', '1.2.3', '256.1.1.1',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '192.167.0.1', '192.169.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8'];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('assertPublicUrl', () => {
  const lookup = (table: Record<string, string[]>) => async (h: string) => {
    if (!table[h]) throw new Error('ENOTFOUND');
    return table[h]!;
  };
  const table = { 'hooks.example.com': ['93.184.216.34'], 'rebind.example.com': ['127.0.0.1'], 'mixed.example.com': ['93.184.216.34', '10.0.0.5'], 'v6.example.com': ['::1'], 'empty.example.com': [] as string[] };
  const check = (u: string) => assertPublicUrl(u, lookup(table));

  it('accepts public http(s) hosts and pins the vetted address', async () => {
    expect((await check('https://hooks.example.com/path?q=1')).address).toBe('93.184.216.34');
    expect((await check('http://hooks.example.com:8080/x')).url.port).toBe('8080');
    expect((await check('https://8.8.8.8/hook')).address).toBe('8.8.8.8');
  });

  it.each([
    'http://127.0.0.1/', 'http://127.0.0.1:8080/admin', 'http://[::1]/', 'http://10.1.2.3/', 'http://172.16.0.9/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/', 'http://localhost/', 'http://LOCALHOST:3000/', 'http://api.localhost/', 'http://metadata.google.internal/', 'http://printer.local/', 'http://intranet/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fd00::1]/',
    'ftp://hooks.example.com/', 'file:///etc/passwd', 'gopher://hooks.example.com/', 'javascript:alert(1)', 'data:text/plain,x', 'not a url', '',
    'http://user:pass@hooks.example.com/', 'https://rebind.example.com/', 'https://mixed.example.com/', 'https://v6.example.com/', 'https://empty.example.com/', 'https://nxdomain.example.com/',
  ])('rejects %s', async (u) => {
    await expect(check(u)).rejects.toBeInstanceOf(SsrfError);
  });

  it('DNS rebinding: the check uses every resolved address, so a hostname that flips to a private IP is refused', async () => {
    const t: Record<string, string[]> = { 'flip.example.com': ['93.184.216.34'] };
    const l = lookup(t);
    expect((await assertPublicUrl('https://flip.example.com/', l)).address).toBe('93.184.216.34');
    t['flip.example.com'] = ['192.168.0.10'];
    await expect(assertPublicUrl('https://flip.example.com/', l)).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('retry schedule', () => {
  it('doubles from 30 seconds and caps at one hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
    expect(retryDelayMs(0)).toBe(30_000);
  });
});

async function hookSetup(env: Record<string, string> = {}) {
  const h = makeHarness({ env });
  const u = await h.register();
  const t = await formTarget(h, u.token);
  const hook = (await h.call('POST', '/api/webhooks', { token: u.token, body: { url: 'https://hooks.example.com/in', events: ['funnel.optin', 'funnel.purchase'] } })).json;
  const submit = (email = 'ada@example.com') => h.call('POST', t.path, { body: { fields: { name: 'Ada', email, _consent: true }, consent: true }, headers: { 'user-agent': 'Mozilla/5.0 Chrome' } });
  const deliveries = async () => (await h.call('GET', `/api/webhooks/${hook.id}/deliveries`, { token: u.token })).json.data as any[];
  return { h, u, t, hook, submit, deliveries };
}

describe('webhook management', () => {
  it('creates with a one-time secret, masks it afterwards and validates URLs and events', async () => {
    const h = makeHarness();
    const u = await h.register();
    const ok = await h.call('POST', '/api/webhooks', { token: u.token, body: { url: 'https://hooks.example.com/a', events: ['funnel.optin'] } });
    expect(ok.status).toBe(201);
    expect(ok.json.secret).toMatch(/^whsec_/);
    const list = (await h.call('GET', '/api/webhooks', { token: u.token })).json.data[0];
    expect(list.secret).toBeUndefined();
    expect(list.secretPreview).toBe(`whsec_…${ok.json.secret.slice(-4)}`);
    const rotated = (await h.call('POST', `/api/webhooks/${ok.json.id}/rotate-secret`, { token: u.token })).json;
    expect(rotated.secret).not.toBe(ok.json.secret);
    for (const url of ['http://127.0.0.1/hook', 'http://169.254.169.254/', 'http://localhost:3000/', 'ftp://hooks.example.com/', 'https://unknown-host.example.com/', 'nope']) {
      const r = await h.call('POST', '/api/webhooks', { token: u.token, body: { url, events: ['funnel.optin'] } });
      expect([url, r.status]).toEqual([url, 400]);
    }
    expect((await h.call('POST', '/api/webhooks', { token: u.token, body: { url: 'https://hooks.example.com/a', events: [] } })).status).toBe(400);
    expect((await h.call('POST', '/api/webhooks', { token: u.token, body: { url: 'https://hooks.example.com/a', events: ['funnel.nope'] } })).status).toBe(400);
    expect((await h.call('PATCH', `/api/webhooks/${ok.json.id}`, { token: u.token, body: { url: 'http://10.0.0.1/' } })).json.error.code).toBe('INVALID_WEBHOOK_URL');
    expect((await h.call('PATCH', `/api/webhooks/${ok.json.id}`, { token: u.token, body: { active: false } })).json.active).toBe(false);
  });
});

describe('webhook delivery', () => {
  it('signs the exact body with HMAC-SHA256 over timestamp.body', async () => {
    const { h, u, hook, submit, deliveries } = await hookSetup();
    await submit();
    expect(await h.worker.tick()).toBe(1);
    expect(h.http.calls).toHaveLength(1);
    const call = h.http.calls[0]!;
    expect(call.target.url.href).toBe('https://hooks.example.com/in');
    expect(call.target.address).toBe('93.184.216.34');
    const secret = h.deps.db.get<{ secret: string }>('SELECT secret FROM webhooks WHERE id = ?', hook.id)!.secret;
    const ts = call.headers['x-funnels-timestamp']!;
    expect(ts).toBe(String(Math.floor(h.clock.now().getTime() / 1000)));
    const expected = createHmac('sha256', secret).update(`${ts}.${call.body}`).digest('hex');
    expect(call.headers['x-funnels-signature']).toBe(`sha256=${expected}`);
    expect(signPayload(secret, ts, call.body)).toBe(expected);
    expect(signPayload('other-secret', ts, call.body)).not.toBe(expected);
    expect(signPayload(secret, String(Number(ts) + 1), call.body)).not.toBe(expected); // replay with another timestamp fails
    expect(signPayload(secret, ts, call.body + ' ')).not.toBe(expected); // tampered body fails
    expect(call.headers).toMatchObject({ 'content-type': 'application/json', 'x-funnels-event': 'funnel.optin' });
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ event: 'funnel.optin', data: { funnel: { name: expect.any(String) }, lead: { email: 'ada@example.com', name: 'Ada' } } });
    expect(call.headers['x-funnels-delivery']).toBe(body.id);
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200, error: null });
    expect(u.token).toBeTruthy();
  });

  it('retries with exponential backoff and succeeds on a later attempt', async () => {
    const { h, submit, deliveries } = await hookSetup();
    h.http.statuses = [500, 502];
    await submit();
    await h.worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 500, error: 'HTTP 500' });
    h.clock.advance(29_000);
    expect(await h.worker.tick()).toBe(0); // not due: 30s backoff
    h.clock.advance(1_000);
    expect(await h.worker.tick()).toBe(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 2, responseStatus: 502 });
    h.clock.advance(59_000);
    expect(await h.worker.tick()).toBe(0); // 60s backoff after the second failure
    h.clock.advance(1_000);
    expect(await h.worker.tick()).toBe(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 3, error: null });
    expect(h.http.calls).toHaveLength(3);
    h.clock.advance(3600_000);
    expect(await h.worker.tick()).toBe(0);
  });

  it('dead-letters after the maximum attempts following the full backoff schedule', async () => {
    const { h, submit, deliveries } = await hookSetup({ WEBHOOK_MAX_ATTEMPTS: '4' });
    h.http.statuses = [500, 500, 500, 500, 200];
    await submit();
    const dueAt: number[] = [];
    for (let i = 0; i < 4; i++) {
      await h.worker.tick();
      const job = h.deps.db.get<{ run_at: number; status: string }>(`SELECT run_at, status FROM jobs WHERE type = 'webhook.deliver'`)!;
      dueAt.push(job.run_at - h.clock.now().getTime());
      if (job.status === 'queued') h.clock.advance(job.run_at - h.clock.now().getTime());
    }
    expect(dueAt.slice(0, 3)).toEqual([30_000, 60_000, 120_000]);
    expect(h.deps.db.get('SELECT status, attempts FROM jobs WHERE type = ?', 'webhook.deliver')).toEqual({ status: 'dead', attempts: 4 });
    expect((await deliveries())[0]).toMatchObject({ status: 'dead', attempts: 4, error: 'HTTP 500' });
    h.clock.advance(7 * 24 * 3600_000);
    expect(await h.worker.tick()).toBe(0); // dead means dead
    expect(h.http.calls).toHaveLength(4);
  });

  it('treats redirects as failures and never follows them', async () => {
    const { h, submit, deliveries } = await hookSetup();
    h.http.statuses = [302];
    await submit();
    await h.worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', responseStatus: 302, error: 'HTTP 302' });
    expect(h.http.calls).toHaveLength(1);
  });

  it('retries network errors and timeouts', async () => {
    const { h, submit, deliveries } = await hookSetup();
    h.http.statuses = [new Error('ECONNRESET')];
    await submit();
    await h.worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'ECONNRESET' });
  });

  it('SSRF at delivery time: a hostname that now resolves to a private address is dead-lettered without any request', async () => {
    const { h, submit, deliveries } = await hookSetup();
    h.lookupTable.set('hooks.example.com', ['127.0.0.1']); // DNS rebinding after the webhook was created
    await submit();
    await h.worker.tick();
    expect(h.http.calls).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ status: 'dead', attempts: 1 });
    expect((await deliveries())[0].error).toContain('blocked');
    h.clock.advance(3600_000);
    expect(await h.worker.tick()).toBe(0);
  });

  it('inactive or deleted webhooks are not called; event filters are respected', async () => {
    const { h, u, hook, submit, deliveries } = await hookSetup();
    await h.call('PATCH', `/api/webhooks/${hook.id}`, { token: u.token, body: { events: ['funnel.purchase'] } });
    await submit('a@example.com');
    expect(await deliveries()).toHaveLength(0); // opt-in not subscribed
    await h.call('PATCH', `/api/webhooks/${hook.id}`, { token: u.token, body: { events: ['funnel.optin'] } });
    await submit('b@example.com');
    await h.call('PATCH', `/api/webhooks/${hook.id}`, { token: u.token, body: { active: false } }); // disabled before delivery
    await h.worker.tick();
    expect(h.http.calls).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ status: 'dead', error: 'webhook disabled or removed' });
    await h.call('PATCH', `/api/webhooks/${hook.id}`, { token: u.token, body: { active: false } });
    await submit('c@example.com');
    expect(await deliveries()).toHaveLength(1); // inactive webhooks receive nothing new
  });

  it('fires funnel.purchase for each order', async () => {
    const { h, u, hook, deliveries } = await hookSetup();
    const t = await checkoutTarget(h, u.token);
    await h.call('POST', t.mainPath, { body: { email: 'buyer@example.com', bumpBlockIds: [t.bumpId] }, headers: { 'user-agent': 'Mozilla/5.0' } });
    await h.worker.tick();
    const bodies = h.http.calls.map((c) => JSON.parse(c.body));
    expect(bodies.map((b) => b.event)).toEqual(['funnel.purchase', 'funnel.purchase']);
    expect(bodies[0].data.order).toMatchObject({ productName: 'Email Marketing Masterclass', amount: 97, currency: 'USD', isBump: false, email: 'buyer@example.com' });
    expect(bodies[1].data.order.isBump).toBe(true);
    expect(await deliveries()).toHaveLength(2);
    expect(hook.id).toBeTruthy();
  });

  it('test events, manual retry of dead deliveries and cross-tenant isolation', async () => {
    const { h, u, hook, deliveries } = await hookSetup({ WEBHOOK_MAX_ATTEMPTS: '1' });
    const t = await h.call('POST', `/api/webhooks/${hook.id}/test`, { token: u.token });
    expect(t.status).toBe(202);
    h.http.statuses = [500];
    await h.worker.tick();
    const [d] = await deliveries();
    expect(d).toMatchObject({ event: 'funnel.test', status: 'dead' });
    expect((await h.call('POST', `/api/webhooks/deliveries/${d.id}/retry`, { token: u.token })).status).toBe(200);
    await h.worker.tick();
    expect((await deliveries())[0].status).toBe('delivered');
    const other = await h.register();
    expect((await h.call('POST', `/api/webhooks/deliveries/${d.id}/retry`, { token: other.token })).status).toBe(404);
  });
});

describe('job queue', () => {
  function queue() {
    let now = 1_000_000;
    const db = new Db(':memory:');
    migrate(db);
    const q = new JobQueue(db, () => now);
    return { db, q, advance: (ms: number) => (now += ms), now: () => now };
  }

  it('claims due jobs in order, increments attempts and dead-letters unknown types', async () => {
    const { q, db } = queue();
    q.enqueue('a', { n: 1 });
    q.enqueue('b', { n: 2 }, { delayMs: 5000 });
    const seen: unknown[] = [];
    const w = new JobWorker(q, { a: async (p) => void seen.push(p), b: async () => undefined }, silentLogger);
    expect(await w.tick()).toBe(1);
    expect(seen).toEqual([{ n: 1 }]);
    q.enqueue('mystery', {});
    await w.tick();
    expect(db.get('SELECT status, last_error FROM jobs WHERE type = ?', 'mystery')).toMatchObject({ status: 'dead' });
  });

  it('retries failures with backoff and honours PermanentJobError and max attempts', async () => {
    const { q, db, advance } = queue();
    let calls = 0;
    const w = new JobWorker(q, { flaky: async () => { calls++; throw new Error('boom'); }, fatal: async () => { throw new PermanentJobError('never'); } }, silentLogger);
    q.enqueue('flaky', {}, { maxAttempts: 3 });
    q.enqueue('fatal', {}, { maxAttempts: 5 });
    await w.tick();
    expect(db.get('SELECT status, attempts FROM jobs WHERE type = ?', 'fatal')).toEqual({ status: 'dead', attempts: 1 });
    expect(db.get('SELECT status, attempts FROM jobs WHERE type = ?', 'flaky')).toEqual({ status: 'queued', attempts: 1 });
    advance(30_000);
    await w.tick();
    advance(60_000);
    await w.tick();
    expect(calls).toBe(3);
    expect(db.get('SELECT status, attempts, last_error FROM jobs WHERE type = ?', 'flaky')).toEqual({ status: 'dead', attempts: 3, last_error: 'boom' });
  });

  it('dedupes queued jobs by key and releases locks of crashed workers', () => {
    const { q, db, advance } = queue();
    expect(q.enqueue('x', {}, { dedupeKey: 'k' })).toBeTruthy();
    expect(q.enqueue('x', {}, { dedupeKey: 'k' })).toBeNull();
    const [job] = q.claimDue();
    expect(job!.attempts).toBe(1);
    expect(q.enqueue('x', {}, { dedupeKey: 'k' })).toBeTruthy(); // allowed while the first one is running (needed for re-scheduling)
    expect(q.claimDue()).toHaveLength(1);
    advance(6 * 60_000);
    // both jobs were 'running' for > 5 minutes: one is re-claimed, the other is superseded instead of violating the dedupe key
    expect(q.claimDue()).toHaveLength(1);
    expect(db.all('SELECT status FROM jobs ORDER BY rowid')).toEqual([{ status: 'running' }, { status: 'dead' }]);
    expect(db.get('SELECT attempts FROM jobs WHERE id = ?', job!.id)).toEqual({ attempts: 2 });
  });
});

export type { Harness };
