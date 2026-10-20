import type { Dialect } from './dialect.js';

export type Param = string | number | bigint | boolean | null | undefined;

export interface QueryResult<T> {
  rows: T[];
  /** Rows affected by INSERT/UPDATE/DELETE; for SELECT it is the number of rows returned. */
  changes: number;
}

export interface TransactionOptions {
  /** PostgreSQL isolation level. Default `read committed`; SQLite is always serialised by its single writer lock. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
}

/**
 * The async data-access contract every service and repository codes against. SQL is written with `?`
 * placeholders; drivers translate. Handles passed to `transaction` callbacks implement the same interface
 * and are only valid until the callback settles.
 */
export interface Db {
  readonly kind: 'sqlite' | 'pg' | 'pglite';
  readonly dialect: Dialect;
  query<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<QueryResult<T>>;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  /** Runs a script of several statements (migrations). No parameters. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` atomically. On the root handle it opens a transaction (retrying serialization failures and
   * deadlocks on PostgreSQL); on a transaction handle it opens a SAVEPOINT, so an inner failure rolls back only the inner part.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** Query plan lines (EXPLAIN QUERY PLAN / EXPLAIN). On PostgreSQL sequential scans are disabled so tiny test tables still show index use. */
  explain(sql: string, ...params: Param[]): Promise<string[]>;
  close(): Promise<void>;
  /**
   * The handle for a read that may be slightly stale (history, lists, analytics): a healthy read replica when one is configured, else this handle.
   * `stickyKey` (a workspace id) pins reads to the primary for a few seconds after `noteWrite(stickyKey)`, so a user sees their own writes.
   */
  read(stickyKey?: string): Db;
  noteWrite(stickyKey: string): void;
}

export const normalizeParams = (params: Param[]): (string | number | bigint | null)[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
