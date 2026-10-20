import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { backoff, beginSql, PgHandle, type PgExecutor, PgTx, RETRIES } from './pghandle.js';
import { SerializationFailure } from './errors.js';
import { ReplicaSet, type ReplicaOptions } from './replicas.js';
import type { Db, TransactionOptions } from './types.js';

const MAX_NAMED = 200;

/** pg returns BIGINT (COUNT, SUM, epoch columns) and NUMERIC as strings; every one of them fits a double here. */
export const pgTypes = (base: { getTypeParser(oid: number, format?: string): (v: string) => unknown }) => ({
  getTypeParser: (oid: number, format?: string) => (oid === 20 || oid === 1700 ? Number : base.getTypeParser(oid, format)),
});

/**
 * Names a statement (server-side prepared statement, cached per connection) once its text has been seen twice.
 * Bounded, so dynamic `IN (?, ?, ...)` lists cannot grow server memory without limit.
 */
class StatementNames {
  private seen = new Map<string, number>();
  private named = new Map<string, string>();
  nameFor(text: string): string | undefined {
    const hit = this.named.get(text);
    if (hit) return hit;
    const n = (this.seen.get(text) ?? 0) + 1;
    if (this.seen.size > 5000) this.seen.clear();
    this.seen.set(text, n);
    if (n >= 2 && this.named.size < MAX_NAMED) {
      const name = `s_${createHash('md5').update(text).digest('hex').slice(0, 24)}`;
      this.named.set(text, name);
      return name;
    }
    return undefined;
  }
}

const executorFor = (target: Pick<Pool | PoolClient, 'query'>, names: StatementNames, named = true): PgExecutor => ({
  async run(text, values, prepare) {
    const r = await target.query({ text, values: values as never[], name: prepare && named ? names.nameFor(text) : undefined });
    return { rows: r.rows, affected: r.rowCount ?? r.rows.length };
  },
  async script(sql) {
    await target.query(sql);
  },
});

/** Production PostgreSQL backend on a `pg` Pool. */
export class PgDb extends PgHandle implements Db {
  readonly kind = 'pg' as const;

  constructor(
    private pool: Pool,
    private names = new StatementNames(),
    private opts: { replicas?: ReplicaSet<PgDb>; prepare?: boolean } = {},
  ) {
    super(executorFor(pool, names, opts.prepare !== false));
  }

  override read(stickyKey?: string): Db {
    return this.opts.replicas?.pick(stickyKey) ?? this;
  }

  override noteWrite(stickyKey: string): void {
    this.opts.replicas?.noteWrite(stickyKey);
  }

  get replicas(): ReplicaSet<PgDb> | undefined {
    return this.opts.replicas;
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      const tx = new PgTx('pg', executorFor(client, this.names, this.opts.prepare !== false));
      let broken = false;
      try {
        await client.query(beginSql(opts));
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // the connection is unusable; do not return it to the pool
        }
        if (e instanceof SerializationFailure && attempt < RETRIES) {
          await backoff(attempt);
          continue;
        }
        throw e;
      } finally {
        tx.closed = true;
        client.release(broken || undefined);
      }
    }
  }

  async close(): Promise<void> {
    await this.opts.replicas?.close();
    await this.pool.end();
  }
}

export interface PgConnectOptions {
  max: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Read replicas for `db.read()`. */
  replicaUrls?: string[];
  replica?: Partial<Pick<ReplicaOptions, 'maxLagMs' | 'stickyMs' | 'pollMs'>>;
  /** false = never use named server-side prepared statements (PgBouncer in transaction pooling mode shares connections between clients, so a name prepared on one is unknown on the next). */
  prepare?: boolean;
}

export async function connectPg(url: string, opts: PgConnectOptions): Promise<PgDb> {
  const pg = (await import('pg')).default;
  const make = (u: string, max: number) => {
    const pool = new pg.Pool({ connectionString: u, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, types: pgTypes(pg.types) as never });
    pool.on('error', (e) => opts.log?.('pg pool error', { error: e.message })); // idle client errors must not crash the process
    return pool;
  };
  const pool = make(url, opts.max);
  await pool.query('SELECT 1');
  let replicas: ReplicaSet<PgDb> | undefined;
  if (opts.replicaUrls?.length) {
    const targets = opts.replicaUrls.map((u) => {
      const rp = make(u, Math.max(2, Math.ceil(opts.max / 2)));
      return { handle: new PgDb(rp, undefined, { prepare: opts.prepare }), pool: rp };
    });
    replicas = new ReplicaSet(targets, {
      maxLagMs: opts.replica?.maxLagMs ?? 2000,
      stickyMs: opts.replica?.stickyMs ?? 5000,
      pollMs: opts.replica?.pollMs ?? 1000,
      onChange: (i) => opts.log?.('read replicas', i),
    });
    await replicas.refresh();
  }
  return new PgDb(pool, undefined, { replicas, prepare: opts.prepare });
}
