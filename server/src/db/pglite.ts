import type { PGlite } from '@electric-sql/pglite';
import { type PgExecutor, PgHandle, PgTx } from './pghandle.js';
import type { Db, TransactionOptions } from './types.js';

type Queryable = Pick<PGlite, 'query' | 'exec'>;

const executorFor = (target: Queryable): PgExecutor => ({
  async run(text, values) {
    const r = await target.query(text, values as never[]);
    return { rows: r.rows as any[], affected: r.affectedRows ?? r.rows.length };
  },
  async script(sql) {
    await target.exec(sql);
  },
});

/**
 * In-process WASM PostgreSQL for the local test suite. It speaks real Postgres SQL but has ONE connection,
 * so it proves dialect correctness, not multi-connection concurrency (see test/pg-real.test.ts for that).
 */
export class PgliteDb extends PgHandle implements Db {
  readonly kind = 'pglite' as const;

  constructor(private pg: PGlite) {
    super(executorFor(pg));
  }

  static async create(dataDir?: string): Promise<PgliteDb> {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = await PGlite.create({ dataDir, parsers: { 20: Number, 1700: Number } });
    return new PgliteDb(pg);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.pg.transaction(async (t) => {
      const tx = new PgTx('pglite', executorFor(t));
      try {
        if (opts?.isolation) await tx.run(`SET TRANSACTION ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
        return await fn(tx);
      } finally {
        tx.closed = true;
      }
    });
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
