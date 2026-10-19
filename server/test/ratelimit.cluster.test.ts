import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKEND } from './helpers.js';
import { redisBinary, startRedis, type RedisServer } from './support/redis.js';

const available = redisBinary() !== null && BACKEND === 'sqlite';

interface Node {
  proc: ChildProcess;
  base: string;
}

async function startNode(env: Record<string, string>): Promise<Node> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'test/support/node-server.ts'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() });
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout!.on('data', (b: Buffer) => {
      const m = /PORT (\d+)/.exec(b.toString());
      if (m) resolve(Number(m[1]));
    });
    proc.once('exit', (c) => reject(new Error(`node exited ${c}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

const startNodes = (n: number, e: Record<string, string>) => Promise.all(Array.from({ length: n }, () => startNode(e)));

const stopAll = (nodes: Node[]) => Promise.all(nodes.map((n) => new Promise((r) => { n.proc.once('exit', r); n.proc.kill('SIGTERM'); })));

describe.skipIf(!available)('several server processes sharing one Redis enforce one global limit', () => {
  let redis: RedisServer;
  beforeAll(async () => { redis = await startRedis(); });
  afterAll(async () => { await redis?.stop(); });

  const hammer = async (nodes: Node[], total: number) => {
    const body = JSON.stringify({ funnelId: 'fn_x', stepId: 'stp_x', type: 'page_view', visitorId: 'v1' });
    const t0 = performance.now();
    const statuses: number[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        while (next < total) {
          const i = next++;
          const r = await fetch(`${nodes[i % nodes.length]!.base}/api/public/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/120' }, body });
          await r.arrayBuffer();
          statuses.push(r.status);
        }
      }),
    );
    const rs = statuses;
    return { ok: rs.filter((s) => s === 202).length, limited: rs.filter((s) => s === 429).length, seconds: (performance.now() - t0) / 1000 };
  };
  const env = (lease: string) => ({ REDIS_URL: redis.url, REDIS_KEY_PREFIX: `cluster${lease}${Date.now()}`, PUBLIC_EVENTS_PER_MINUTE: '60', IP_GUARD_PER_MINUTE: '1000000', RATELIMIT_LEASE_FRACTION: lease, REDIS_TIMEOUT_MS: '3000' });

  it('exact mode (no local lease): 3 processes admit the burst plus what refilled while the test ran, never more', async () => {
    const nodes = await startNodes(3, env('0'));
    try {
      const r = await hammer(nodes, 600);
      expect(r.ok + r.limited).toBe(600);
      expect(r.ok).toBeGreaterThanOrEqual(60);
      expect(r.ok, `ok=${r.ok} in ${r.seconds.toFixed(2)}s`).toBeLessThanOrEqual(60 + Math.ceil(r.seconds) + 1); // 60 burst + 1 token per second refill
    } finally {
      await stopAll(nodes);
    }
  }, 60_000);

  it('lease mode: no overshoot beyond the burst, and at most nodes x lease tokens stranded', async () => {
    const nodes = await startNodes(3, env('0.1'));
    try {
      const r = await hammer(nodes, 600);
      const lease = Math.ceil(60 * 0.1);
      expect(r.ok, `ok=${r.ok}`).toBeLessThanOrEqual(60 + Math.ceil(r.seconds) + 1);
      expect(r.ok, `ok=${r.ok}`).toBeGreaterThanOrEqual(60 - nodes.length * lease);
    } finally {
      await stopAll(nodes);
    }
  }, 60_000);

  it('a different client key is unaffected by the first one being limited', async () => {
    const nodes = await startNodes(2, env('0'));
    try {
      await hammer(nodes, 200);
      const r = await fetch(`${nodes[0]!.base}/api/public/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/120' }, body: JSON.stringify({ funnelId: 'fn_other', stepId: 'stp_x', type: 'page_view', visitorId: 'v1' }) });
      expect(r.status).toBe(202);
    } finally {
      await stopAll(nodes);
    }
  }, 60_000);
});
