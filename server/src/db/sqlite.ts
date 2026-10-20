import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { sqliteDialect } from './dialect.js';
import { mapDriverError } from './errors.js';
import { type Db, normalizeParams, type Param, type QueryResult } from './types.js';

// `node:sqlite` is loaded through createRequire because bundlers/test runners do not
// recognise it as a builtin when it is imported statically.
const require = createRequire(import.meta.url);
const { DatabaseSync: Sqlite } = require('node:sqlite') as typeof import('node:sqlite');

const STATEMENT_CACHE = 400;
const READS = /^\s*(select|with|pragma|explain)\b/i;

function localDay(ts: unknown, tz: unknown): string | null {
  if (typeof ts !== 'string' || typeof tz !== 'string') return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

/**
 * Zero-config backend. node:sqlite is synchronous and the file has one writer, so a transaction must own the
 * connection from BEGIN to COMMIT even though callers `await` in between: statements issued on the root handle
 * while a transaction is open wait in a FIFO queue; statements on the transaction handle run immediately.
 */
export class SqliteDb implements Db {
  readonly kind = 'sqlite' as const;
  readonly dialect = sqliteDialect;
  readonly raw: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private busy = false;
  private waiters: (() => void)[] = [];
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Sqlite(path);
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL');
    this.raw.function('local_day', { deterministic: true }, localDay as never);
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.statements.size >= STATEMENT_CACHE) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Executes synchronously on the connection. Only call while holding the connection (no transaction open, or inside it). */
  execute<T>(sql: string, params: Param[] = []): QueryResult<T> {
    try {
      const s = this.stmt(sql);
      const values = normalizeParams(params);
      if (READS.test(sql) || /\breturning\b/i.test(sql)) {
        const rows = s.all(...values) as T[];
        return { rows, changes: rows.length };
      }
      return { rows: [], changes: Number(s.run(...values).changes) };
    } catch (e) {
      throw mapDriverError(e);
    }
  }

  private async acquire(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // ownership passes straight to the next waiter
    else this.busy = false;
  }

  async query<T>(sql: string, params: Param[] = []): Promise<QueryResult<T>> {
    await this.acquire();
    try {
      return this.execute<T>(sql, params);
    } finally {
      this.release();
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
    await this.acquire();
    try {
      this.raw.exec(sql);
    } catch (e) {
      throw mapDriverError(e);
    } finally {
      this.release();
    }
  }

  async explain(sql: string, ...params: Param[]): Promise<string[]> {
    const { rows } = await this.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
    return rows.map((r) => String(r.detail));
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await this.acquire();
    const tx = new SqliteTx(this);
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = await fn(tx);
        this.raw.exec('COMMIT');
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* the transaction was already ended by SQLite */
        }
        throw e;
      }
      return result;
    } finally {
      tx.closed = true;
      this.release();
    }
  }

  read(): Db {
    return this;
  }

  noteWrite(): void {}

  async close(): Promise<void> {
    await this.acquire();
    this.statements.clear();
    this.raw.close();
    this.release();
  }

  nextSavepoint(): string {
    return `sp_${this.depth++}`;
  }

  endSavepoint(): void {
    this.depth--;
  }
}

class SqliteTx implements Db {
  readonly kind = 'sqlite' as const;
  readonly dialect = sqliteDialect;
  closed = false;
  constructor(private root: SqliteDb) {}

  private guard(): void {
    if (this.closed) throw new Error('Transaction handle used after the transaction finished');
  }

  async query<T>(sql: string, params: Param[] = []): Promise<QueryResult<T>> {
    this.guard();
    return this.root.execute<T>(sql, params);
  }
  async get<T>(sql: string, ...p: Param[]) {
    return (await this.query<T>(sql, p)).rows[0];
  }
  async all<T>(sql: string, ...p: Param[]) {
    return (await this.query<T>(sql, p)).rows;
  }
  async run(sql: string, ...p: Param[]) {
    return { changes: (await this.query(sql, p)).changes };
  }
  async exec(sql: string): Promise<void> {
    this.guard();
    this.root.raw.exec(sql);
  }
  async explain(sql: string, ...p: Param[]) {
    return (await this.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...p)).map((r) => String(r.detail));
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.guard();
    const sp = this.root.nextSavepoint();
    this.root.raw.exec(`SAVEPOINT ${sp}`);
    try {
      const r = await fn(this);
      this.root.raw.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.root.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      this.root.endSavepoint();
    }
  }

  read(): Db {
    return this;
  }

  noteWrite(): void {}

  async close(): Promise<void> {
    throw new Error('A transaction handle cannot close the database');
  }
}
