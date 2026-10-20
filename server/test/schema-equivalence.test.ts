import { describe, expect, it } from 'vitest';
import { openDb, openPglite } from '../src/db/index.js';
import { BACKEND } from './helpers.js';
import { introspect, type TableInfo } from './support/schema.js';

// The two dialects keep separate migration files, so this test is what stops them drifting: it migrates a fresh SQLite
// database and a fresh PGlite (real PostgreSQL) database and compares what each one actually exposes.
describe.skipIf(BACKEND !== 'sqlite')('SQLite and PostgreSQL schemas are equivalent', () => {
  const load = async () => {
    const sqlite = await openDb({ sqlitePath: ':memory:' });
    const pg = await openPglite();
    const schemas = { sqlite: await introspect(sqlite), pg: await introspect(pg) };
    await pg.close();
    await sqlite.close();
    return schemas;
  };

  it('expose the same tables', async () => {
    const { sqlite, pg } = await load();
    expect(Object.keys(pg).sort()).toEqual(Object.keys(sqlite).sort());
    expect(Object.keys(sqlite)).toEqual(expect.arrayContaining(['funnels', 'steps', 'events', 'event_rollups', 'schema_migrations']));
    expect(Object.keys(sqlite)).not.toContain('visitor_days'); // removed again in migration 004 on SQLite, never created on PostgreSQL
  });

  it('expose the same columns with the same nullability and type family', async () => {
    const { sqlite, pg } = await load();
    for (const table of Object.keys(sqlite)) {
      const norm = (t: TableInfo) => t.columns.map((c) => `${c.name}:${c.type}:${c.notNull ? 'not null' : 'null'}`).sort();
      expect(norm(pg[table]!), table).toEqual(norm(sqlite[table]!));
    }
  });

  it('expose the same indexes (named indexes by name, implicit unique/primary-key indexes by column list)', async () => {
    const { sqlite, pg } = await load();
    for (const table of Object.keys(sqlite)) {
      const explicit = (t: TableInfo) => t.indexes.filter((i) => i.explicit).map((i) => `${i.name}(${i.columns.join(',')})${i.unique ? ' unique' : ''}`).sort();
      // A partitioned PostgreSQL table must include the partition key (created_at) in its primary key; `events` is the only such table.
      const implicit = (t: TableInfo) => t.indexes.filter((i) => !i.explicit).map((i) => `(${i.columns.filter((c) => !(table === 'events' && c === 'created_at')).join(',')})`).sort();
      expect(explicit(pg[table]!), `${table} explicit indexes`).toEqual(explicit(sqlite[table]!));
      expect(implicit(pg[table]!), `${table} implicit unique indexes`).toEqual(implicit(sqlite[table]!));
    }
  });

  it('both record the same migration names', async () => {
    const a = await openDb({ sqlitePath: ':memory:' });
    const b = await openPglite();
    const names = async (d: typeof a) => (await d.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
    expect(await names(b)).toEqual(await names(a));
    await b.close();
  });
});
