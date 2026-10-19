import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { Redis } from 'ioredis';

/** The redis-server binary tests run against, or null (the Redis suites then skip). REDIS_SERVER_BIN overrides the lookup. */
export function redisBinary(): string | null {
  const candidates = [process.env.REDIS_SERVER_BIN, '/opt/homebrew/bin/redis-server', '/usr/local/bin/redis-server', '/usr/bin/redis-server'].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync('which', ['redis-server']);
  return which.status === 0 ? which.stdout.toString().trim() : null;
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export interface RedisServer {
  url: string;
  port: number;
  stop(): Promise<void>;
  start(): Promise<void>;
  client(): Redis;
}

/** A throwaway real redis-server (no persistence) on a free port. `stop`/`start` simulate an outage and recovery on the same port. */
export async function startRedis(): Promise<RedisServer> {
  const bin = redisBinary();
  if (!bin) throw new Error('redis-server not found');
  const port = await freePort();
  let proc: ChildProcess | null = null;
  const clients: Redis[] = [];
  const start = async () => {
    proc = spawn(bin, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      const probe = new Redis({ port, host: '127.0.0.1', lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
      try {
        await probe.connect();
        await probe.ping();
        probe.disconnect();
        return;
      } catch {
        probe.disconnect();
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error('redis-server did not start');
  };
  await start();
  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    start,
    client: () => {
      const c = new Redis({ port, host: '127.0.0.1' });
      c.on('error', () => undefined);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) c.disconnect();
      if (proc) {
        const p = proc;
        proc = null;
        p.kill('SIGKILL');
        await new Promise((r) => p.once('exit', r));
      }
    },
  };
}
