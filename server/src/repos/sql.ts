import type { Db } from '../db/index.js';

type Value = string | number | null | boolean | undefined;

/** Builds `UPDATE <table> SET col = ?, ... WHERE workspace_id = ? AND id = ?`. Column names come from code, never from input. */
export async function updateScoped(db: Db, table: string, ws: string, id: string, fields: Record<string, Value>): Promise<number> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE workspace_id = ? AND id = ?`;
  return (await db.run(sql, ...keys.map((k) => fields[k]), ws, id)).changes;
}

export const placeholders = (n: number): string => Array(n).fill('?').join(',');

/** Escapes LIKE wildcards; pair with `db.dialect.ilike(column)` for a case-insensitive match. */
export const like = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
