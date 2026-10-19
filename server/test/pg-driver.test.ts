import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { toPgPlaceholders } from '../src/db/dialect.js';
import { mapDriverError, SerializationFailure, UniqueViolation, ForeignKeyViolation } from '../src/db/errors.js';
import { isPostgresUrl } from '../src/db/index.js';
import { PgDb, pgTypes } from '../src/db/pg.js';
import { BACKEND } from './helpers.js';

// The pg Pool code path cannot run against PGlite (one connection, no TCP). These tests drive PgDb with a scripted fake pool
// to pin down the SQL it sends (isolation level, COMMIT/ROLLBACK, savepoints, retries, statement naming, release semantics).
// test/pg-real.test.ts exercises the same class against a real server when TEST_PG_URL is set (CI).

interface Call {
  client: number;
  text: string;
  values?: unknown[];
  name?: string;
}

function fakePool(script: (call: Call) => unknown = () => ({ rows: [], rowCount: 0 })) {
  const calls: Call[] = [];
  const released: unknown[] = [];
  let clients = 0;
  const query = (id: number) => async (q: string | { text: string; values?: unknown[]; name?: string }) => {
    const call: Call = typeof q === 'string' ? { client: id, text: q } : { client: id, text: q.text, values: q.values, name: q.name };
    calls.push(call);
    return script(call) as { rows: unknown[]; rowCount: number };
  };
  const pool = {
    query: query(0),
    connect: async () => ({ query: query(++clients), release: (e?: unknown) => released.push(e ?? false) }),
    end: async () => undefined,
  } as unknown as Pool;
  return { pool, calls, released };
}

describe.skipIf(BACKEND !== 'sqlite')('placeholder translation and type parsing', () => {
  it('rewrites ? to $n but leaves quoted text alone', () => {
    expect(toPgPlaceholders(`SELECT * FROM t WHERE a = ? AND b = 'what?' AND c IN (?, ?)`)).toBe(`SELECT * FROM t WHERE a = $1 AND b = 'what?' AND c IN ($2, $3)`);
  });
  it('parses BIGINT (20) and NUMERIC (1700) as numbers and delegates the rest', () => {
    const t = pgTypes({ getTypeParser: () => (v: string) => `raw:${v}` });
    expect(t.getTypeParser(20)('9007199254740991')).toBe(9007199254740991);
    expect(t.getTypeParser(1700)('12.5')).toBe(12.5);
    expect(t.getTypeParser(25)('x')).toBe('raw:x');
  });
  it('selects the backend from DATABASE_URL', () => {
    expect(isPostgresUrl('postgres://u:p@h/db')).toBe(true);
    expect(isPostgresUrl('postgresql://u:p@h/db')).toBe(true);
    expect(isPostgresUrl(undefined)).toBe(false);
    expect(isPostgresUrl('./data/funnels.db')).toBe(false);
  });
  it('maps driver errors to domain errors', () => {
    expect(mapDriverError({ code: '23505', message: 'dup', constraint: 'tags_workspace_id_name_lower_key' })).toMatchObject({ constructor: UniqueViolation, constraint: 'tags_workspace_id_name_lower_key' });
    expect(mapDriverError({ code: '23503', message: 'fk' })).toBeInstanceOf(ForeignKeyViolation);
    expect(mapDriverError({ code: '40001', message: 'could not serialize' })).toBeInstanceOf(SerializationFailure);
    expect(mapDriverError({ code: '40P01', message: 'deadlock detected' })).toBeInstanceOf(SerializationFailure);
    expect(mapDriverError({ errcode: 2067, message: 'UNIQUE constraint failed: tags.workspace_id, tags.name_lower' })).toMatchObject({ constraint: 'tags.workspace_id, tags.name_lower' });
    const other = new Error('boom');
    expect(mapDriverError(other)).toBe(other);
  });
});

describe.skipIf(BACKEND !== 'sqlite')('PgDb on a scripted pool', () => {
  it('sends translated SQL with parameters, and names a statement once it is hot', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ n: 1 }], rowCount: 1 }));
    const db = new PgDb(pool);
    await db.get('SELECT n FROM t WHERE id = ?', 'a');
    await db.get('SELECT n FROM t WHERE id = ?', 'b');
    await db.get('SELECT n FROM t WHERE id = ?', 'c');
    expect(calls.map((c) => c.text)).toEqual(Array(3).fill('SELECT n FROM t WHERE id = $1'));
    expect(calls.map((c) => c.values)).toEqual([['a'], ['b'], ['c']]);
    expect(calls[0]!.name).toBeUndefined();
    expect(calls[1]!.name).toMatch(/^s_[0-9a-f]{24}$/);
    expect(calls[2]!.name).toBe(calls[1]!.name);
  });

  it('binds undefined as NULL and booleans as integers', async () => {
    const { pool, calls } = fakePool();
    await new PgDb(pool).run('INSERT INTO t VALUES (?, ?, ?)', undefined, true, false);
    expect(calls[0]!.values).toEqual([null, 1, 0]);
  });

  it('runs a transaction on one pooled connection: BEGIN READ COMMITTED, statements, COMMIT, release', async () => {
    const { pool, calls, released } = fakePool();
    const db = new PgDb(pool);
    await db.transaction(async (tx) => { await tx.run('UPDATE a SET x = ?', 1); await tx.run('UPDATE b SET y = ?', 2); });
    expect(calls.map((c) => c.text)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'UPDATE a SET x = $1', 'UPDATE b SET y = $1', 'COMMIT']);
    expect(new Set(calls.map((c) => c.client))).toEqual(new Set([1]));
    expect(released).toEqual([false]);
    await db.transaction(async () => undefined, { isolation: 'serializable' });
    expect(calls.at(-2)!.text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
  });

  it('rolls back and releases when the callback throws, and rethrows the original error', async () => {
    const { pool, calls, released } = fakePool();
    await expect(new PgDb(pool).transaction(async (tx) => { await tx.run('UPDATE a SET x = 1'); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls.map((c) => c.text)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'UPDATE a SET x = 1', 'ROLLBACK']);
    expect(released).toEqual([false]);
  });

  it('discards a connection whose ROLLBACK failed instead of returning it to the pool', async () => {
    const { pool, released } = fakePool((c) => { if (c.text === 'ROLLBACK') throw new Error('connection lost'); return { rows: [], rowCount: 0 }; });
    await expect(new PgDb(pool).transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(released).toEqual([true]);
  });

  it('nested transactions are savepoints and an inner failure rolls back only the inner part', async () => {
    const { pool, calls } = fakePool();
    await new PgDb(pool).transaction(async (tx) => {
      await expect(tx.transaction(async (i) => { await i.run('INSERT INTO x VALUES (1)'); throw new Error('inner'); })).rejects.toThrow('inner');
      await tx.transaction(async (i) => { await i.run('INSERT INTO x VALUES (2)'); });
    });
    expect(calls.map((c) => c.text).slice(1, -1)).toEqual([
      'SAVEPOINT sp_0', 'INSERT INTO x VALUES (1)', 'ROLLBACK TO SAVEPOINT sp_0', 'RELEASE SAVEPOINT sp_0',
      'SAVEPOINT sp_0', 'INSERT INTO x VALUES (2)', 'RELEASE SAVEPOINT sp_0',
    ]);
  });

  it('retries a transaction that fails with a serialization failure or deadlock, on a fresh connection, then gives up', async () => {
    let fails = 2;
    const { pool, calls } = fakePool((c) => {
      if (c.text.startsWith('UPDATE') && fails-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return { rows: [], rowCount: 1 };
    });
    let runs = 0;
    const result = await new PgDb(pool).transaction(async (tx) => { runs++; await tx.run('UPDATE a SET x = 1'); return 'ok'; });
    expect([result, runs]).toEqual(['ok', 3]);
    expect(calls.filter((c) => c.text === 'ROLLBACK')).toHaveLength(2);
    expect(new Set(calls.map((c) => c.client))).toEqual(new Set([1, 2, 3]));

    const always = fakePool((c) => { if (c.text.startsWith('UPDATE')) throw Object.assign(new Error('x'), { code: '40001' }); return { rows: [], rowCount: 0 }; });
    let attempts = 0;
    await expect(new PgDb(always.pool).transaction(async (tx) => { attempts++; await tx.run('UPDATE a SET x = 1'); })).rejects.toBeInstanceOf(SerializationFailure);
    expect(attempts).toBe(4); // first try + 3 retries
  });

  it('does not retry ordinary errors, and maps unique violations', async () => {
    const { pool } = fakePool((c) => { if (c.text.startsWith('INSERT')) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'k' }); return { rows: [], rowCount: 0 }; });
    let attempts = 0;
    const err = await new PgDb(pool).transaction(async (tx) => { attempts++; await tx.run('INSERT INTO t VALUES (1)'); }).catch((e) => e);
    expect(err).toBeInstanceOf(UniqueViolation);
    expect(attempts).toBe(1);
  });

  it('EXPLAIN runs in a transaction with sequential scans disabled', async () => {
    const { pool, calls } = fakePool((c) => (c.text.startsWith('EXPLAIN') ? { rows: [{ 'QUERY PLAN': 'Index Scan using idx on t' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
    const plan = await new PgDb(pool).explain('SELECT * FROM t WHERE a = ?', 1);
    expect(plan).toEqual(['Index Scan using idx on t']);
    expect(calls.map((c) => c.text)).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED', 'SET LOCAL enable_seqscan = off', 'EXPLAIN SELECT * FROM t WHERE a = $1', 'COMMIT']);
  });

  it('close ends the pool', async () => {
    let ended = false;
    const { pool } = fakePool();
    (pool as unknown as { end: () => Promise<void> }).end = async () => { ended = true; };
    await new PgDb(pool).close();
    expect(ended).toBe(true);
  });
});
