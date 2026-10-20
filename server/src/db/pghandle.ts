import { pgDialect, toPgPlaceholders } from './dialect.js';
import { mapDriverError } from './errors.js';
import { type Db, normalizeParams, type Param, type QueryResult, type TransactionOptions } from './types.js';

/** Minimal execution primitive the PostgreSQL drivers (pg client/pool, PGlite) provide. */
export interface PgExecutor {
  run(text: string, values: unknown[], prepare: boolean): Promise<{ rows: any[]; affected: number }>;
  script(sql: string): Promise<void>;
}

/** Shared behaviour of every PostgreSQL-flavoured handle: placeholder rewriting, error mapping, savepoints, EXPLAIN. */
export abstract class PgHandle implements Db {
  abstract readonly kind: 'pg' | 'pglite';
  readonly dialect = pgDialect;
  private translated = new Map<string, string>();

  protected constructor(protected readonly executor: PgExecutor) {}

  private text(sql: string): string {
    let t = this.translated.get(sql);
    if (!t) {
      t = toPgPlaceholders(sql);
      if (this.translated.size > 1000) this.translated.clear();
      this.translated.set(sql, t);
    }
    return t;
  }

  async query<T>(sql: string, params: Param[] = []): Promise<QueryResult<T>> {
    try {
      const r = await this.executor.run(this.text(sql), normalizeParams(params), true);
      return { rows: r.rows as T[], changes: r.affected };
    } catch (e) {
      throw mapDriverError(e);
    }
  }
  async get<T>(sql: string, ...p: Param[]): Promise<T | undefined> {
    return (await this.query<T>(sql, p)).rows[0];
  }
  async all<T>(sql: string, ...p: Param[]): Promise<T[]> {
    return (await this.query<T>(sql, p)).rows;
  }
  async run(sql: string, ...p: Param[]): Promise<{ changes: number }> {
    return { changes: (await this.query(sql, p)).changes };
  }
  async exec(sql: string): Promise<void> {
    try {
      await this.executor.script(sql);
    } catch (e) {
      throw mapDriverError(e);
    }
  }

  async explain(sql: string, ...p: Param[]): Promise<string[]> {
    return this.transaction(async (tx) => {
      await tx.run('SET LOCAL enable_seqscan = off');
      return (await tx.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, ...p)).map((r) => r['QUERY PLAN']);
    });
  }

  abstract transaction<T>(fn: (tx: Db) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  abstract close(): Promise<void>;

  /** Handles without replicas read from themselves. PgDb overrides this. */
  read(_stickyKey?: string): Db {
    return this;
  }

  noteWrite(_stickyKey: string): void {}
}

/** A handle bound to one open transaction. Nested `transaction` calls become savepoints. */
export class PgTx extends PgHandle {
  closed = false;
  private depth = 0;

  constructor(
    readonly kind: 'pg' | 'pglite',
    executor: PgExecutor,
  ) {
    super(executor);
  }

  override async query<T>(sql: string, params: Param[] = []): Promise<QueryResult<T>> {
    if (this.closed) throw new Error('Transaction handle used after the transaction finished');
    return super.query<T>(sql, params);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const sp = `sp_${this.depth++}`;
    await this.run(`SAVEPOINT ${sp}`);
    try {
      const r = await fn(this);
      await this.run(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      await this.run(`ROLLBACK TO SAVEPOINT ${sp}`);
      await this.run(`RELEASE SAVEPOINT ${sp}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  override explain(sql: string, ...p: Param[]): Promise<string[]> {
    return this.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, ...p).then((rows) => rows.map((r) => r['QUERY PLAN']));
  }

  async close(): Promise<void> {
    throw new Error('A transaction handle cannot close the database');
  }
}

export const beginSql = (opts?: TransactionOptions): string => `BEGIN ISOLATION LEVEL ${(opts?.isolation ?? 'read committed').toUpperCase()}`;

/** Serialization failures and deadlocks are safe to retry because nothing outside the database has happened yet. */
export const RETRIES = 3;
export const backoff = (attempt: number): Promise<void> => new Promise((r) => setTimeout(r, 5 * 2 ** attempt + Math.random() * 10));
