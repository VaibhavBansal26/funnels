import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

// `node:sqlite` is loaded through createRequire because bundlers/test runners do not
// recognise it as a builtin when it is imported statically.
const require = createRequire(import.meta.url);
const { DatabaseSync: Sqlite } = require('node:sqlite') as typeof import('node:sqlite');

type Param = string | number | bigint | null | undefined | boolean;

const clean = (params: Param[]) =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | bigint | null)[];

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  private statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Sqlite(path);
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL');
  }

  /** Prepared statements are cached by SQL text (bounded), so hot queries are compiled once. */
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.statements.size >= 400) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...clean(params)) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...clean(params)) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.stmt(sql).run(...clean(params));
    return { changes: Number(r.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls use savepoints, so an inner failure rolls back only the inner part. */
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  explain(sql: string, ...params: Param[]): string[] {
    return this.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...clean(params)).map((r) => String((r as { detail: string }).detail));
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}

export function migrate(db: Db): string[] {
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.tx(() => {
      db.exec(readFileSync(dir + file, 'utf8'));
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
    });
    applied.push(file);
  }
  return applied;
}

export function openDb(path: string): Db {
  const db = new Db(path);
  migrate(db);
  return db;
}
