import { describe, expect, it } from 'vitest';
import { ForeignKeyViolation, isForeignKeyViolation, isUniqueViolation, UniqueViolation } from '../src/db/index.js';
import { migrate } from '../src/db/index.js';
import { migrationFiles } from '../src/db/migrate.js';
import { bucketOf } from '../src/services/rollups.js';
import { dayKey } from '../src/util/time.js';
import { newId } from '../src/util/ids.js';
import { BACKEND, testDb } from './helpers.js';

const ws = (id: string) => ({ sql: `INSERT INTO workspaces (id, name, created_at) VALUES (?, 'n', 'now')`, id });

describe(`data layer on ${BACKEND}`, () => {
  it('applies migrations once, in order, and re-running is a no-op', async () => {
    const db = await testDb();
    const names = (await db.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
    expect(names).toEqual(migrationFiles(db.dialect.name));
    expect(await migrate(db)).toEqual([]);
  });

  it('enforces foreign keys and CHECK constraints and maps violations to domain errors', async () => {
    const db = await testDb();
    const user = (id: string, w: string, email: string, role = 'owner') =>
      db.run(`INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'n', 'h', ?, 'now')`, id, w, email, role);
    await expect(user('u', 'missing', 'a@b.c')).rejects.toBeInstanceOf(ForeignKeyViolation);
    await db.run(ws('w').sql, 'w');
    await expect(user('u', 'w', 'a@b.c', 'god')).rejects.toThrow(/check|CHECK/);
    await user('u1', 'w', 'a@b.c');
    const dup = await user('u2', 'w', 'a@b.c').catch((e) => e);
    expect(dup).toBeInstanceOf(UniqueViolation);
    expect(isUniqueViolation(dup)).toBe(true);
    expect(isForeignKeyViolation(dup)).toBe(false);
    expect((await user('u1', 'w', 'other@b.c').catch((e) => e)) as unknown).toBeInstanceOf(UniqueViolation); // primary key
  });

  it('transactions commit, roll back, and nest with savepoints', async () => {
    const db = await testDb();
    const count = async () => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces'))!.n;
    const add = (tx: typeof db, id: string) => tx.run(ws(id).sql, id);
    await db.transaction((tx) => add(tx, 'a'));
    expect(await count()).toBe(1);
    await expect(db.transaction(async (tx) => { await add(tx, 'b'); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await count()).toBe(1);
    await db.transaction(async (tx) => {
      await add(tx, 'c');
      await expect(tx.transaction(async (inner) => { await add(inner, 'd'); throw new Error('inner'); })).rejects.toThrow('inner');
      await add(tx, 'e');
    });
    expect((await db.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id')).map((r) => r.id)).toEqual(['a', 'c', 'e']);
    await expect(db.transaction(async (tx) => { await add(tx, 'f'); await tx.transaction((i) => add(i, 'g')); throw new Error('outer'); })).rejects.toThrow('outer');
    expect(await count()).toBe(3);
    expect(await db.transaction(async () => 42)).toBe(42);
  });

  it('an error inside a savepoint does not poison the enclosing transaction (PostgreSQL aborts the whole transaction otherwise)', async () => {
    const db = await testDb();
    await db.transaction(async (tx) => {
      await tx.run(ws('a').sql, 'a');
      await expect(tx.transaction((i) => i.run(ws('a').sql, 'a'))).rejects.toBeInstanceOf(UniqueViolation);
      await tx.run(ws('b').sql, 'b'); // still usable
    });
    expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces'))!.n).toBe(2);
  });

  it('a transaction handle cannot be used after the transaction ended, nor close the database', async () => {
    const db = await testDb();
    let leaked: typeof db | undefined;
    await db.transaction(async (tx) => { leaked = tx; await expect(tx.close()).rejects.toThrow(/cannot close/); });
    await expect(leaked!.get('SELECT 1')).rejects.toThrow(/after the transaction/);
  });

  it('statements on the root handle wait for an open transaction instead of running inside it', async () => {
    const db = await testDb();
    let seenDuring: number | undefined;
    const tx = db.transaction(async (t) => {
      await t.run(ws('x').sql, 'x');
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('rollback me');
    });
    const outside = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces').then((r) => (seenDuring = r!.n));
    await expect(tx).rejects.toThrow('rollback me');
    await outside;
    expect(seenDuring).toBe(0); // never saw (or became part of) the rolled-back transaction
  });

  it('concurrent transactions are serialised per connection and never interleave their statements', async () => {
    const db = await testDb();
    const log: string[] = [];
    const work = (name: string) => db.transaction(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.get('SELECT 1');
        log.push(`${name}${i}`);
        await new Promise((r) => setTimeout(r, 2));
      }
    });
    await Promise.all([work('a'), work('b'), work('c')]);
    expect(log).toHaveLength(9);
    // On one connection (SQLite, PGlite) transactions run one after another. A pool may overlap them, which is also correct.
    if (BACKEND !== 'pg') {
      for (const n of ['a', 'b', 'c']) {
        const at = log.flatMap((e, i) => (e.startsWith(n) ? [i] : []));
        expect(at[2]! - at[0]!, `${n} ran contiguously`).toBe(2);
      }
    }
  });

  it('binds undefined as NULL and booleans as integers', async () => {
    const db = await testDb();
    await db.exec('CREATE TABLE t_bind (a INTEGER, b INTEGER)');
    await db.run('INSERT INTO t_bind VALUES (?, ?)', undefined, true);
    expect(await db.get('SELECT a, b FROM t_bind')).toEqual({ a: null, b: 1 });
    await db.exec('DROP TABLE t_bind');
  });

  it('returns COUNT/SUM as numbers (PostgreSQL BIGINT would be a string)', async () => {
    const db = await testDb();
    await db.run(ws('a').sql, 'a');
    const r = await db.get<{ n: unknown; s: unknown }>('SELECT COUNT(*) AS n, SUM(1) AS s FROM workspaces');
    expect(r).toEqual({ n: 1, s: 1 });
  });
});

describe(`dialect helpers on ${BACKEND}`, () => {
  it('ilike is case-insensitive and honours escaped wildcards', async () => {
    const db = await testDb();
    const d = db.dialect;
    for (const [i, name] of ['Summer Sale', 'summer_sale', '100% Off', 'Other'].entries()) await db.run(`INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, 'now')`, `w${i}`, name);
    const find = async (pattern: string) => (await db.all<{ name: string }>(`SELECT name FROM workspaces WHERE ${d.ilike('name')} ORDER BY name`, pattern)).map((r) => r.name);
    expect(await find('%SUMMER%')).toEqual(['Summer Sale', 'summer_sale']);
    expect(await find('%summer\\_sale%')).toEqual(['summer_sale']);
    expect(await find('%100\\%%')).toEqual(['100% Off']);
  });

  it('orderCi sorts case-insensitively and byte-wise', async () => {
    const db = await testDb();
    for (const [i, n] of ['banana', 'Apple', 'cherry', 'apple2', '_x'].entries()) await db.run(`INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, 'now')`, `w${i}`, n);
    const names = (await db.all<{ name: string }>(`SELECT name FROM workspaces ORDER BY ${db.dialect.orderCi('name')}`)).map((r) => r.name);
    expect(names).toEqual(['Apple', '_x', 'apple2', 'banana', 'cherry'].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it('greatest, boolInt, groupConcat, jsonText and nowIso', async () => {
    const db = await testDb();
    const d = db.dialect;
    expect(await db.get(`SELECT ${d.greatest('3', '7')} AS a, ${d.greatest('9', '2')} AS b`)).toEqual({ a: 7, b: 9 });
    expect(await db.get(`SELECT ${d.boolInt('1 = 1')} AS t, ${d.boolInt('1 = 2')} AS f`)).toEqual({ t: 1, f: 0 });
    await db.run(`INSERT INTO workspaces (id, name, created_at) VALUES ('a', 'x', 'now'), ('b', 'y', 'now')`);
    const joined = (await db.get<{ s: string }>(`SELECT ${d.groupConcat('name', ',')} AS s FROM (SELECT name FROM workspaces ORDER BY name) q`))!.s;
    expect(joined.split(',').sort()).toEqual(['x', 'y']);
    await db.run(`UPDATE workspaces SET name = ? WHERE id = 'a'`, JSON.stringify({ k: 'v', n: 1 }));
    expect(await db.get(`SELECT ${d.jsonText('name', 'k')} AS k FROM workspaces WHERE id = 'a'`)).toEqual({ k: 'v' });
    const now = (await db.get<{ t: string }>(`SELECT ${d.nowIso()} AS t`))!.t;
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(60_000);
  });

  it('upsert, onConflictDoNothing and returning', async () => {
    const db = await testDb();
    const d = db.dialect;
    await db.run(ws('w').sql, 'w');
    const up = () => db.run(`INSERT INTO ai_usage (workspace_id, day, count) VALUES ('w', 'd', 1)${d.upsert(['workspace_id', 'day'], 'count = ai_usage.count + excluded.count')}`);
    await up();
    await up();
    expect(await db.get('SELECT count FROM ai_usage')).toEqual({ count: 2 });
    expect((await db.run(`INSERT INTO ai_usage (workspace_id, day, count) VALUES ('w', 'd', 9)${d.onConflictDoNothing()}`)).changes).toBe(0);
    const inserted = await db.all<{ day: string }>(`INSERT INTO ai_usage (workspace_id, day, count) VALUES ('w', 'e', 1)${d.onConflictDoNothing()}${d.returning('day')}`);
    expect(inserted).toEqual([{ day: 'e' }]);
  });

  it('bucket15 agrees with the JavaScript bucketing used by the rollup writer', async () => {
    const db = await testDb();
    for (const ts of ['2026-03-10T12:00:00.000Z', '2026-03-10T12:14:59.999Z', '2026-03-10T12:15:00.000Z', '2026-03-10T23:59:59.999Z', '2026-12-31T00:44:00.000Z']) {
      const r = await db.get<{ b: string }>(`SELECT ${db.dialect.bucket15('ts')} AS b FROM (SELECT CAST(? AS TEXT) AS ts) q`, ts);
      expect(r!.b, ts).toBe(bucketOf(ts));
    }
  });

  it('localDay agrees with dayKey for zones with DST and half-hour offsets', async () => {
    const db = await testDb();
    for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Europe/Berlin']) {
      for (const ts of ['2026-03-10T03:30:00.000Z', '2026-03-10T04:00:00.000Z', '2026-03-09T18:30:00.000Z', '2026-03-29T00:59:59.000Z', '2026-12-31T23:59:59.000Z']) {
        const r = await db.get<{ d: string }>(`SELECT ${db.dialect.localDay('ts', '?')} AS d FROM (SELECT CAST(? AS TEXT) AS ts) q`, tz, ts);
        expect(r!.d, `${ts} ${tz}`).toBe(dayKey(ts, tz));
      }
    }
  });

  it('explain returns plan lines that name the index used', async () => {
    const db = await testDb();
    const plan = (await db.explain('SELECT * FROM users WHERE workspace_id = ?', 'w')).join(' | ');
    expect(plan).toMatch(/idx_users_workspace/);
  });
});

describe('ids', () => {
  it('are unique, URL-safe, and sort in creation order within a process', () => {
    const ids = Array.from({ length: 5000 }, () => newId('x'));
    expect(new Set(ids).size).toBe(5000);
    expect(ids.every((i) => /^x_[a-z0-9]{12}[A-Za-z0-9_-]{8}$/.test(i))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]!.length).toBeLessThanOrEqual(40);
  });
});
