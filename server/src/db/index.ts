import { migrate } from './migrate.js';
import { SqliteDb } from './sqlite.js';
import type { Db } from './types.js';

export type { Db, Param, QueryResult } from './types.js';
export type { Dialect } from './dialect.js';
export { isForeignKeyViolation, isUniqueViolation, UniqueViolation, ForeignKeyViolation } from './errors.js';
export { migrate } from './migrate.js';

export interface DbOptions {
  /** `postgres://` / `postgresql://` URL selects PostgreSQL; anything else is a SQLite file path or `:memory:`. */
  url?: string;
  sqlitePath?: string;
  poolMax?: number;
  replicaUrls?: string[];
  replica?: { maxLagMs?: number; stickyMs?: number; pollMs?: number };
  /** false disables named prepared statements (PgBouncer transaction pooling). */
  prepare?: boolean;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export const isPostgresUrl = (url: string | undefined): url is string => !!url && /^postgres(ql)?:\/\//i.test(url);

/** Connects and migrates. `DATABASE_URL` wins over the SQLite path, which keeps zero-config development working. */
export async function openDb(opts: DbOptions = {}): Promise<Db> {
  let db: Db;
  if (isPostgresUrl(opts.url)) {
    const { connectPg } = await import('./pg.js');
    db = await connectPg(opts.url, { max: opts.poolMax ?? 10, log: opts.log, replicaUrls: opts.replicaUrls, replica: opts.replica, prepare: opts.prepare });
  } else {
    db = new SqliteDb(opts.sqlitePath ?? ':memory:');
  }
  await migrate(db);
  return db;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PgliteDb } = await import('./pglite.js');
  const db = await PgliteDb.create(dataDir);
  await migrate(db);
  return db;
}
