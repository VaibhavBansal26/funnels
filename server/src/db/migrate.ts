import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './types.js';

const dirFor = (db: Db) => fileURLToPath(new URL(`./migrations/${db.dialect.name === 'sqlite' ? 'sqlite' : 'pg'}/`, import.meta.url));

/** Arbitrary constant; serialises concurrent boots of several replicas on PostgreSQL. */
const MIGRATION_LOCK = 724_309_117;

export function migrationFiles(dialect: 'sqlite' | 'postgres'): string[] {
  const dir = fileURLToPath(new URL(`./migrations/${dialect === 'sqlite' ? 'sqlite' : 'pg'}/`, import.meta.url));
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Applies pending numbered migrations. Both dialects share file names (`NNN_name.sql`) and numbering, so a
 * migration means the same thing everywhere; only the SQL differs. Each file runs in its own transaction
 * together with its bookkeeping row (DDL is transactional on both engines).
 */
export async function migrate(db: Db): Promise<string[]> {
  const dir = dirFor(db);
  // Under the same advisory lock as the migrations: two replicas booting on an empty database race on CREATE TABLE IF NOT EXISTS (duplicate pg_type key).
  await db.transaction(async (tx) => {
    if (db.dialect.name === 'postgres') await tx.run('SELECT pg_advisory_xact_lock(?)', MIGRATION_LOCK);
    await tx.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  });
  const applied: string[] = [];
  for (const file of migrationFiles(db.dialect.name)) {
    const sql = readFileSync(dir + file, 'utf8');
    await db.transaction(async (tx) => {
      if (db.dialect.name === 'postgres') await tx.run('SELECT pg_advisory_xact_lock(?)', MIGRATION_LOCK);
      // Checked after taking the lock, so a replica that waited sees the winner's work and skips it.
      if (await tx.get('SELECT 1 FROM schema_migrations WHERE name = ?', file)) return;
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
      applied.push(file);
    });
  }
  return applied;
}
