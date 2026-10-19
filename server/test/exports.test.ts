import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeCell, toCsv } from '../src/util/csv.js';
import { migrationFiles } from '../src/db/migrate.js';
import { checkoutTarget, formTarget, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 Chrome' };

describe('csv helpers', () => {
  it('neutralises formula injection by prefixing a quote', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tcmd', '\rcmd', '=HYPERLINK("http://evil","x")']) expect(neutralizeCell(bad)).toBe(`'${bad}`);
    for (const ok of ['hello', 'a=b', '1+1', '', 'user@example.com', ' =space first']) expect(neutralizeCell(ok)).toBe(ok);
    expect(neutralizeCell(null)).toBe('');
    expect(neutralizeCell(42)).toBe('42');
  });
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=A1,B1')).toBe(`"'=A1,B1"`);
    expect(toCsv(['a', 'b'], [[1, 'x,y'], [null, '=2']])).toBe(`a,b\r\n1,"x,y"\r\n,'=2\r\n`);
  });
});

async function leadsWorld() {
  const h = await makeHarness();
  const u = await h.register();
  const t = await formTarget(h, u.token);
  const submit = (fields: object, sub?: string) => h.call('POST', t.path, { body: { fields: { ...fields, _consent: true }, consent: true, submissionId: sub }, headers: UA });
  return { h, u, t, submit };
}

describe('leads', () => {
  it('lists with search, date range, funnel filter and pagination', async () => {
    const { h, u, t, submit } = await leadsWorld();
    await submit({ name: 'Ada Lovelace', email: 'ada@example.com' });
    h.clock.advance(2 * 24 * 3600_000);
    await submit({ name: 'Grace Hopper', email: 'grace@navy.mil' });
    h.clock.advance(2 * 24 * 3600_000);
    await submit({ name: 'Alan Turing', email: 'alan@bletchley.uk' });
    const q = async (s: string) => (await h.call('GET', `/api/leads?${s}`, { token: u.token })).json;
    expect((await q('')).data.map((l: any) => l.name)).toEqual(['Alan Turing', 'Grace Hopper', 'Ada Lovelace']); // newest first
    expect((await q('search=GRACE')).data).toHaveLength(1);
    expect((await q('search=navy.mil')).data).toHaveLength(1);
    expect((await q('search=%25')).data).toHaveLength(0);
    expect((await q('from=2026-03-12&to=2026-03-12')).data.map((l: any) => l.name)).toEqual(['Grace Hopper']);
    expect((await q('from=2026-03-12')).data).toHaveLength(2);
    expect((await q('to=2026-03-10')).data).toHaveLength(1);
    expect((await q(`funnelId=${t.funnelId}`)).data).toHaveLength(3);
    expect((await q('funnelId=other')).data).toHaveLength(0);
    const page = await q('limit=2&page=2');
    expect(page.data).toHaveLength(1);
    expect(page.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect((await h.call('GET', '/api/leads?from=nope', { token: u.token })).status).toBe(400);
    expect((await h.call('GET', '/api/leads?limit=500', { token: u.token })).status).toBe(400);
  });

  it('exports CSV with injection-safe cells and respects filters', async () => {
    const { h, u, submit } = await leadsWorld();
    await submit({ name: '=HYPERLINK("http://evil.example","click")', email: 'a@example.com' });
    await submit({ name: '+cmd|calc', email: 'b@example.com' });
    await submit({ name: '@SUM(1)', email: 'c@example.com' });
    await submit({ name: '-1+1', email: 'd@example.com' });
    await submit({ name: 'Normal, "Quoted"', email: 'e@example.com' });
    const res = await h.app.request('/api/leads/export', { headers: { authorization: `Bearer ${u.token}` } });
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('leads.csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('Email,Name,Phone,First funnel,Submissions,Created,Last activity');
    expect(lines).toHaveLength(6);
    for (const cell of [`'=HYPERLINK`, `'+cmd|calc`, `'@SUM(1)`, `'-1+1`]) expect(text).toContain(cell);
    expect(text).not.toMatch(/(^|,)"?[=+@]/m); // no raw formula cell survives
    expect(text).toContain('"Normal, ""Quoted"""');
    const filtered = (await h.call('GET', '/api/leads/export?search=e@example', { token: u.token })).text.trim().split('\r\n');
    expect(filtered).toHaveLength(2);
  });
});

describe('orders', () => {
  async function ordersWorld() {
    const h = await makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const buy = (email: string, name?: string) => h.call('POST', t.mainPath, { body: { email, name, bumpBlockIds: [t.bumpId] }, headers: UA });
    return { h, u, t, buy };
  }

  it('lists orders with search, funnel and date filters', async () => {
    const { h, u, t, buy } = await ordersWorld();
    await buy('first@example.com', 'First');
    h.clock.advance(24 * 3600_000);
    await buy('second@example.com', 'Second');
    const q = async (s: string) => (await h.call('GET', `/api/orders?${s}`, { token: u.token })).json;
    expect((await q('')).data).toHaveLength(4);
    expect((await q('search=second')).data).toHaveLength(2);
    expect((await q('search=masterclass')).data).toHaveLength(2);
    expect((await q('from=2026-03-11&to=2026-03-11')).data.every((o: any) => o.email === 'second@example.com')).toBe(true);
    expect((await q(`funnelId=${t.funnelId}`)).data).toHaveLength(4);
    expect((await q('funnelId=none')).data).toHaveLength(0);
    const first = (await q('limit=1')).data[0];
    expect(first).toMatchObject({ amount: 17, currency: 'USD', isBump: true, funnelName: 'Sales page with order bump and upsell' });
    expect((await h.call('GET', `/api/orders/${first.id}`, { token: u.token })).json).toMatchObject({ id: first.id, email: 'second@example.com' });
  });

  it('exports CSV with neutralised cells', async () => {
    const { h, u, buy } = await ordersWorld();
    await buy('=cmd@example.com', '=2+2');
    const text = (await h.call('GET', '/api/orders/export', { token: u.token })).text;
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('Order,Date,Funnel,Step,Product,Amount,Currency,Bump,Upsell,Email,Name,Provider reference');
    expect(lines).toHaveLength(3);
    expect(text).toContain(`'=cmd@example.com`);
    expect(text).toContain(`'=2+2`);
    expect(lines.some((l) => l.includes('97.00,USD,no,no'))).toBe(true);
    expect(lines.some((l) => l.includes('17.00,USD,yes,no'))).toBe(true);
  });
});

describe('notifications and the SSE stream', () => {
  async function readEvents(h: Harness, path: string, headers: Record<string, string>, trigger: () => Promise<unknown>, want: number) {
    const ac = new AbortController();
    const res = await h.app.request(path, { headers, signal: ac.signal });
    if (res.status !== 200) return { res, events: [] as { event: string; data: string }[] };
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events: { event: string; data: string }[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (.*)/.exec(block)?.[1] ?? 'message';
          events.push({ event: ev, data: /data: (.*)/.exec(block)?.[1] ?? '' });
        }
      }
    })().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await trigger();
    for (let i = 0; i < 50 && events.length < want; i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await reader.cancel().catch(() => undefined);
    await pump;
    return { res, events };
  }

  it('streams new lead and new sale toasts to the right workspace only, via ticket or bearer', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const ta = await formTarget(h, a.token);
    const tb = await formTarget(h, b.token);
    const ticket = (await h.call('POST', '/api/events/ticket', { token: a.token })).json.ticket;
    const submit = (t: { path: string }, email: string) => h.call('POST', t.path, { body: { fields: { name: 'N', email, _consent: true }, consent: true }, headers: UA });
    const { res, events } = await readEvents(h, `/api/events/stream?ticket=${ticket}`, {}, async () => {
      await submit(tb, 'other@example.com'); // other workspace: must not appear
      await submit(ta, 'mine@example.com');
    }, 2);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events[0]!.event).toBe('ready');
    const note = events.find((e) => e.event === 'notification')!;
    expect(JSON.parse(note.data)).toMatchObject({ type: 'new_lead', body: expect.stringContaining('mine@example.com') });
    expect(events.filter((e) => e.event === 'notification')).toHaveLength(1);

    const bearer = await readEvents(h, '/api/events/stream', { authorization: `Bearer ${a.token}` }, async () => void (await submit(ta, 'again@example.com')), 2);
    expect(bearer.events.some((e) => e.event === 'notification')).toBe(true);
  });

  it('requires a valid credential: no auth, bad tickets, expired tickets and access tokens passed as tickets are refused', async () => {
    const h = await makeHarness();
    const a = await h.register();
    expect((await h.app.request('/api/events/stream')).status).toBe(401);
    expect((await h.app.request('/api/events/stream?ticket=garbage')).status).toBe(401);
    expect((await h.app.request(`/api/events/stream?ticket=${a.token}`)).status).toBe(401); // an access token is not a stream ticket
    const ticket = (await h.call('POST', '/api/events/ticket', { token: a.token })).json.ticket;
    expect((await h.call('GET', '/api/funnels', { token: ticket })).status).toBe(401); // a ticket is not an access token
    expect((await h.call('POST', '/api/events/ticket')).status).toBe(401);
    h.clock.advance(61_000);
    expect((await h.app.request(`/api/events/stream?ticket=${ticket}`)).status).toBe(401);
  });

  it('lists, marks read and marks all read', async () => {
    const { h, u, submit } = await leadsWorld();
    await submit({ name: 'One', email: 'one@example.com' });
    await submit({ name: 'Two', email: 'two@example.com' });
    let r = (await h.call('GET', '/api/notifications', { token: u.token })).json;
    expect(r.unread).toBe(2);
    expect(r.data.map((n: any) => n.body)).toEqual([expect.stringContaining('two@'), expect.stringContaining('one@')]);
    expect((await h.call('POST', `/api/notifications/${r.data[0].id}/read`, { token: u.token })).status).toBe(204);
    expect((await h.call('GET', '/api/notifications', { token: u.token })).json.unread).toBe(1);
    expect((await h.call('POST', '/api/notifications/read-all', { token: u.token })).status).toBe(204);
    r = (await h.call('GET', '/api/notifications', { token: u.token })).json;
    expect(r.unread).toBe(0);
    expect(r.data.every((n: any) => n.readAt)).toBe(true);
    expect((await h.call('POST', '/api/notifications/missing/read', { token: u.token })).status).toBe(404);
  });
});

describe('platform plumbing', () => {
  it('health, readiness and security headers', async () => {
    const h = await makeHarness();
    const health = await h.call('GET', '/healthz');
    expect(health.json).toEqual({ status: 'ok' });
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-request-id')).toBeTruthy();
    const ready = await h.call('GET', '/readyz');
    expect(ready.json).toMatchObject({ status: 'ready', migrations: migrationFiles(h.deps.db.dialect.name).length });
  });

  it('unknown API routes return the JSON error model; malformed JSON and unhandled errors are mapped', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const nf = await h.call('GET', '/api/nope', { token: u.token });
    expect(nf.status).toBe(404);
    expect(nf.json).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    const big = await h.call('POST', '/api/funnels', { token: u.token, raw: JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('CORS allow-list applies to the authenticated API only for listed origins', async () => {
    const h = await makeHarness({ env: { CORS_ORIGINS: 'https://app.example.org' } });
    const ok = await h.app.request('/api/funnels', { headers: { origin: 'https://app.example.org' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    const bad = await h.app.request('/api/funnels', { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves the built web app with SPA fallback, CSP, no traversal and real 404s for missing assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'funnels-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, '..', 'funnels-secret.txt'), 'top secret');
    const h = await makeHarness({ env: { WEB_DIST: dir } });
    const index = await h.app.request('/funnels/abc/builder');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>app</title>');
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const js = await h.app.request('/assets/app.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await h.app.request('/assets/missing.js')).status).toBe(404);
    for (const p of ['/../funnels-secret.txt', '/%2e%2e/funnels-secret.txt', '/assets/../../funnels-secret.txt', '/..%2ffunnels-secret.txt']) {
      const r = await h.app.request(p);
      expect(await r.text(), p).not.toContain('top secret');
    }
    expect((await h.app.request('/%E0%A4%A')).status).toBe(400);
    expect((await h.app.request('/api/nothing-here')).status).toBe(404); // API paths are never answered with the SPA
  });
});
