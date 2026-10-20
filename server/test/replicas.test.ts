import { describe, expect, it, vi } from 'vitest';
import { ReplicaSet } from '../src/db/replicas.js';
import { PgDb } from '../src/db/pg.js';
import { BACKEND } from './helpers.js';

const pool = (lag: number | Error) => ({
  query: vi.fn(async () => {
    if (lag instanceof Error) throw lag;
    return { rows: [{ lag }], rowCount: 1 };
  }),
  end: vi.fn(async () => undefined),
});

describe.skipIf(BACKEND !== 'sqlite')('read replicas', () => {
  const setup = (lags: (number | Error)[], over: Partial<ConstructorParameters<typeof ReplicaSet>[1]> = {}) => {
    let t = 1_000_000;
    const pools = lags.map(pool);
    const rs = new ReplicaSet(pools.map((p, i) => ({ handle: `replica-${i}`, pool: p as never })), { maxLagMs: 2000, stickyMs: 5000, pollMs: 0, now: () => t, ...over });
    return { rs, pools, advance: (ms: number) => (t += ms) };
  };

  it('uses healthy replicas round-robin', async () => {
    const { rs } = setup([0, 100, 500]);
    await rs.refresh();
    expect([1, 2, 3, 4].map(() => rs.pick())).toEqual(['replica-0', 'replica-1', 'replica-2', 'replica-0']);
  });

  it('takes a lagging or failing replica out of rotation and puts it back when it recovers', async () => {
    const { rs, pools } = setup([0, 5000, new Error('down')]);
    await rs.refresh();
    expect(rs.status()).toEqual([{ healthy: true, lagMs: 0 }, { healthy: false, lagMs: 5000 }, { healthy: false, lagMs: 0 }]);
    expect([1, 2, 3].map(() => rs.pick())).toEqual(['replica-0', 'replica-0', 'replica-0']);
    pools[1]!.query.mockResolvedValueOnce({ rows: [{ lag: 50 }], rowCount: 1 });
    await rs.refresh();
    expect(rs.status()[1]).toEqual({ healthy: true, lagMs: 50 });
  });

  it('falls back to the primary (null) when every replica is unhealthy', async () => {
    const { rs } = setup([9000, new Error('x')]);
    await rs.refresh();
    expect(rs.pick()).toBeNull();
  });

  it('read-your-writes: a key that wrote recently reads from the primary, others do not, and it expires', async () => {
    const { rs, advance } = setup([0]);
    await rs.refresh();
    rs.noteWrite('ws_a');
    expect(rs.pick('ws_a')).toBeNull();
    expect(rs.pick('ws_b')).toBe('replica-0');
    expect(rs.pick()).toBe('replica-0');
    advance(4999);
    expect(rs.pick('ws_a')).toBeNull();
    advance(2);
    expect(rs.pick('ws_a')).toBe('replica-0');
  });

  it('PgDb.read() returns a replica handle or itself, and noteWrite pins to the primary', async () => {
    const primary = pool(0);
    const replicaPool = pool(0);
    const replica = new PgDb(replicaPool as never);
    const rs = new ReplicaSet([{ handle: replica, pool: replicaPool as never }], { maxLagMs: 1000, stickyMs: 5000, pollMs: 0 });
    await rs.refresh();
    const db = new PgDb(primary as never, undefined, { replicas: rs });
    expect(db.read('ws')).toBe(replica);
    db.noteWrite('ws');
    expect(db.read('ws')).toBe(db);
    expect(db.read('other')).toBe(replica);
    await db.close();
    expect(replicaPool.end).toHaveBeenCalled();
    expect(primary.end).toHaveBeenCalled();
  });

  it('disables named prepared statements for PgBouncer transaction pooling', async () => {
    const calls: { name?: string }[] = [];
    const p = { query: async (q: { name?: string }) => (calls.push(q), { rows: [], rowCount: 0 }), end: async () => undefined };
    const db = new PgDb(p as never, undefined, { prepare: false });
    for (let i = 0; i < 5; i++) await db.get('SELECT ?', i);
    expect(calls.every((c) => c.name === undefined)).toBe(true);
    const named = new PgDb({ ...p, query: async (q: { name?: string }) => (calls.push(q), { rows: [], rowCount: 0 }) } as never);
    calls.length = 0;
    for (let i = 0; i < 5; i++) await named.get('SELECT ?', i);
    expect(calls.some((c) => c.name)).toBe(true);
  });
});
