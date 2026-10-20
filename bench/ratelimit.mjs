// Limiter overhead per decision, without HTTP. Needs `npm run build --prefix server` and a redis-server binary (REDIS_SERVER_BIN or PATH).
// Usage: node bench/ratelimit.mjs [calls=20000] [concurrency=64] [hotClients=0]   (hotClients=0: every request is a new client)
// Measures, for the two layers an ingestion request passes (ip.global + public.events): time added per request and Redis commands per request,
// for the in-memory store, Redis exact, and Redis with the local lease tier.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = (p) => import(pathToFileURL(join(root, 'server/dist', p)));
const { RateLimiter } = await load('ratelimit/limiter.js');
const { MemoryStore } = await load('ratelimit/memory.js');
const { RedisStore } = await load('ratelimit/redis.js');
const { GuardedStore } = await load('ratelimit/guarded.js');
const { buildPolicies } = await load('ratelimit/policies.js');
const { Redis } = await import(pathToFileURL(join(root, 'server/node_modules/ioredis/built/index.js')));
const [CALLS, CONC, HOT] = [Number(process.argv[2] ?? 20000), Number(process.argv[3] ?? 64), Number(process.argv[4] ?? 0)];
const bin = [process.env.REDIS_SERVER_BIN, '/opt/homebrew/bin/redis-server', '/usr/local/bin/redis-server', '/usr/bin/redis-server'].find((p) => p && existsSync(p));
if (!bin) throw new Error('redis-server not found');
const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const proc = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const admin = new Redis({ port, host: '127.0.0.1' });
// Round trips to Redis = EVALSHA/EVAL/SCRIPT calls from clients (total_commands_processed would also count every redis.call inside the Lua scripts).
const commands = async () => { const t = await admin.info('commandstats'); return [...t.matchAll(/cmdstat_(evalsha|eval|script\|load):calls=(\d+)/g)].reduce((n, m) => n + Number(m[2]), 0); };
const cfg = { IP_GUARD_PER_MINUTE: 1e9, PUBLIC_EVENTS_PER_MINUTE: 1e9, PUBLIC_FORMS_PER_MINUTE: 20, PUBLIC_PAGES_PER_MINUTE: 6000, AUTH_ATTEMPTS_PER_MINUTE: 10, AI_RATE_LIMIT_PER_MINUTE: 10, API_USER_PER_MINUTE: 600, API_WORKSPACE_PER_MINUTE: 600, EXPORT_CONCURRENCY: 2, EDGE_RESOLVE_PER_MINUTE: 120000 };
const variants = {
  'disabled (baseline)': () => new RateLimiter({ store: new MemoryStore(), policies: buildPolicies(cfg), hooks: {}, enabled: false }),
  'in-memory store': () => new RateLimiter({ store: new MemoryStore(), policies: buildPolicies(cfg), hooks: {} }),
  'Redis, exact (no lease)': () => new RateLimiter({ store: new GuardedStore(new RedisStore({ url: `redis://127.0.0.1:${port}`, prefix: `b${Math.random()}` }), { timeoutMs: 1000, failureThreshold: 5, openMs: 1000 }), policies: buildPolicies(cfg), hooks: {} }),
  'Redis + local lease (10%)': () => new RateLimiter({ store: new GuardedStore(new RedisStore({ url: `redis://127.0.0.1:${port}`, prefix: `b${Math.random()}` }), { timeoutMs: 1000, failureThreshold: 5, openMs: 1000 }), policies: buildPolicies(cfg), hooks: {}, leaseFraction: 0.1 }),
};
const rows = [];
for (const [name, make] of Object.entries(variants)) {
  const l = make();
  await l.store.ping();
  for (let i = 0; i < 500; i++) await l.evaluate(['ip.global', 'public.events'], { ip: '10.0.0.1', scope: 'fn' }); // warm up
  const lat = [];
  let next = 0; let denied = 0;
  const c0 = await commands(); const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < CALLS) {
      const i = next++; const t = performance.now();
      const r = await l.evaluate(['ip.global', 'public.events'], { ip: HOT ? `10.1.0.${i % HOT}` : `10.1.${(i >> 8) & 255}.${i & 255}`, scope: 'fn' });
      if (r.denied) denied++;
      lat.push(performance.now() - t);
    }
  }));
  const secs = (performance.now() - t0) / 1000; const used = (await commands()) - c0;
  lat.sort((a, b) => a - b); const q = (p) => lat[Math.floor(lat.length * p)];
  rows.push({ name, perSec: Math.round(CALLS / secs), p50: q(0.5), p99: q(0.99), cmds: used / CALLS, denied });
  await l.store.close();
}
console.log(`${CALLS.toLocaleString()} requests x 2 layers (ip.global + public.events), ${CONC} concurrent, ${HOT ? `${HOT} hot clients` : 'every request a new client'}, redis-server ${bin}\n`);
console.log('| variant | requests/s | p50 added ms | p99 added ms | Redis round trips per request | refused |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.perSec} | ${r.p50.toFixed(3)} | ${r.p99.toFixed(3)} | ${r.cmds.toFixed(2)} | ${r.denied} |`);
await admin.quit(); proc.kill('SIGKILL'); process.exit(0);
