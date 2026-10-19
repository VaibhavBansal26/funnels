import type { Db } from '../../src/db/index.js';

export interface ColumnInfo {
  name: string;
  /** Normalised type family: `text` or `int` (INTEGER and BIGINT are the same family: SQLite integers are 64-bit). */
  type: string;
  notNull: boolean;
}
export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  /** True for an index created by an explicit CREATE INDEX (`idx_*`), false for one implied by PRIMARY KEY / UNIQUE. */
  explicit: boolean;
}
export interface TableInfo {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

const family = (t: string): string => (/int/i.test(t) ? 'int' : /char|text|clob/i.test(t) ? 'text' : t.toLowerCase());

/** Reads the live schema (tables, columns, indexes) of either engine into one comparable shape. */
export async function introspect(db: Db): Promise<Record<string, TableInfo>> {
  const out: Record<string, TableInfo> = {};
  if (db.dialect.name === 'sqlite') {
    const tables = await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    for (const { name } of tables) {
      const cols = await db.all<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info(${name})`);
      const idx = await db.all<{ name: string; unique: number }>(`PRAGMA index_list(${name})`);
      const indexes: IndexInfo[] = [];
      for (const i of idx) {
        const c = await db.all<{ name: string }>(`PRAGMA index_info(${i.name})`);
        indexes.push({ name: i.name, unique: i.unique === 1, columns: c.map((x) => x.name), explicit: i.name.startsWith('idx_') });
      }
      // WITHOUT ROWID tables and INTEGER-less primary keys expose the PK as an index too; TEXT PRIMARY KEY tables get an autoindex. Normalise: PK is always an index.
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      if (pk.length && !indexes.some((i) => i.unique && !i.explicit && i.columns.join() === pk.join())) indexes.push({ name: `${name}_pkey`, unique: true, columns: pk, explicit: false });
      out[name] = { columns: cols.map((c) => ({ name: c.name, type: family(c.type), notNull: c.notnull === 1 || c.pk > 0 })), indexes };
    }
  } else {
    const tables = await db.all<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    for (const { table_name: name } of tables) {
      const cols = await db.all<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position`, name,
      );
      const idx = await db.all<{ name: string; unique: boolean; columns: string[] }>(
        `SELECT i.relname::text AS name, ix.indisunique AS "unique", array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = 'public' AND t.relname = ? GROUP BY i.relname, ix.indisunique ORDER BY i.relname`, name,
      );
      out[name] = {
        columns: cols.map((c) => ({ name: c.column_name, type: family(c.data_type), notNull: c.is_nullable === 'NO' })),
        indexes: idx.map((i) => ({ name: i.name, unique: i.unique, columns: i.columns, explicit: i.name.startsWith('idx_') })),
      };
    }
  }
  return out;
}

export async function columnNames(db: Db, table: string): Promise<string[]> {
  return ((await introspect(db))[table]?.columns ?? []).map((c) => c.name);
}
