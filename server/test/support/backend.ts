import { afterEach } from 'vitest';
import type { Db } from '../../src/db/index.js';
import { openDb, openPglite } from '../../src/db/index.js';

/** Which engine the suite runs against: `sqlite` (default), `pglite` (in-process Postgres) or `pg` (a real server at TEST_PG_URL). */
export type Backend = 'sqlite' | 'pglite' | 'pg';
export const BACKEND: Backend = process.env.TEST_DB === 'pglite' ? 'pglite' : process.env.TEST_DB === 'pg' ? 'pg' : 'sqlite';
export const IS_PG = BACKEND !== 'sqlite';

const free: Db[] = [];
const busy = new Set<Db>();
let tables: string[] | null = null;

/** Creates a fresh, migrated database on the server at `url` and connects a pool to it. One per worker process, so parallel test files never see each other's rows. */
export async function createPg(poolMax = 8): Promise<Db> {
  const url = process.env.TEST_PG_URL;
  if (!url) throw new Error('TEST_DB=pg needs TEST_PG_URL (postgres://user:pass@host:5432/db)');
  const admin = await openDbNoMigrate(url);
  const name = `funnels_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  // Concurrent CREATE DATABASE calls from parallel workers can collide on template1 ("is being accessed by other users"); retry.
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.exec(`CREATE DATABASE ${name}`);
      break;
    } catch (e) {
      if (attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
    }
  }
  await admin.close();
  const u = new URL(url);
  u.pathname = `/${name}`;
  return openDb({ url: u.toString(), poolMax });
}

async function openDbNoMigrate(url: string): Promise<Db> {
  const { connectPg } = await import('../../src/db/pg.js');
  return connectPg(url, { max: 1 });
}

/** Resets a reused Postgres-flavoured database to "migrated and empty" (milliseconds, versus ~1 s to boot a new PGlite). */
export async function wipe(db: Db): Promise<void> {
  tables ??= (await db.all<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).map((r) => r.tablename);
  await db.exec(`TRUNCATE ${tables.join(', ')} CASCADE`);
}

/** A migrated, empty database. Postgres-flavoured instances are pooled per test file and wiped after every test. */
export async function testDb(): Promise<Db> {
  if (BACKEND === 'sqlite') return openDb({ sqlitePath: ':memory:' });
  const db = free.pop() ?? (await (BACKEND === 'pglite' ? openPglite() : createPg()));
  busy.add(db);
  return db;
}

const teardown: (() => Promise<void>)[] = [];

/** Makes every matching statement fail with "simulated failure" (a trigger on both engines), to prove transactions are atomic. Removed after the test. */
export async function failOn(db: Db, table: string, op: 'DELETE' | 'UPDATE' | 'INSERT', column?: string): Promise<void> {
  const name = `fail_${op.toLowerCase()}_${table}`;
  const of = op === 'UPDATE' && column ? ` OF ${column}` : '';
  if (db.dialect.name === 'sqlite') {
    await db.exec(`CREATE TRIGGER ${name} BEFORE ${op}${of} ON ${table} BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    teardown.push(() => db.exec(`DROP TRIGGER IF EXISTS ${name}`));
  } else {
    await db.exec(`CREATE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql`);
    await db.exec(`CREATE TRIGGER ${name} BEFORE ${op}${of} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    teardown.push(() => db.exec(`DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}()`));
  }
}

afterEach(async () => {
  for (const t of teardown.splice(0)) await t();
  for (const db of busy) {
    await wipe(db);
    free.push(db);
  }
  busy.clear();
});
