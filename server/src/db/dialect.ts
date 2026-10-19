/**
 * Named SQL fragments for the places where SQLite and PostgreSQL differ. Services call these instead of
 * writing dialect SQL inline, so the whole difference between the backends is visible in this file.
 */
export interface Dialect {
  readonly name: 'sqlite' | 'postgres';
  /** Positional placeholder, 1-based (`?` for SQLite, `$n` for PostgreSQL). App SQL uses `?`; drivers rewrite it. */
  placeholder(n: number): string;
  /** Appends a RETURNING clause (both engines support it on INSERT/UPDATE/DELETE). */
  returning(columns: string): string;
  /** `INSERT ... ON CONFLICT (cols) DO UPDATE SET <assignments>`; reference the incoming row as `excluded.col` and the stored row as `table.col`. */
  upsert(conflictColumns: string[], assignments: string): string;
  /** `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` suffix. Put it after VALUES. */
  onConflictDoNothing(conflictColumns?: string[]): string;
  /** Current UTC time as the app's ISO-8601 text format (`2026-03-10T12:00:00.000Z`). */
  nowIso(): string;
  /** Case-insensitive pattern match with backslash escaping, for `like()` patterns from repos/sql.ts. */
  ilike(column: string): string;
  /** ORDER BY expression that sorts case-insensitively and byte-wise on both engines (PostgreSQL's locale collation would differ). */
  orderCi(column: string): string;
  /** Larger of two values per row (SQLite scalar `max`, PostgreSQL `GREATEST`). */
  greatest(a: string, b: string): string;
  /** `col IS NOT NULL` as 0/1 for SUM. */
  boolInt(condition: string): string;
  /** Aggregate concatenation (`GROUP_CONCAT` / `string_agg`). */
  groupConcat(column: string, separator: string): string;
  /** 15-minute UTC bucket label `YYYY-MM-DDTHH:MM` of an ISO text timestamp column. */
  bucket15(column: string): string;
  /** Local calendar day (`YYYY-MM-DD`) of an ISO text timestamp in an IANA zone. SQLite uses a registered `local_day` function. */
  localDay(column: string, tzParam: string): string;
  /** Extracts a text value from a JSON text column. */
  jsonText(column: string, key: string): string;
  /** Row lock suffix; empty on SQLite, whose single writer already serialises transactions. */
  forUpdate(): string;
  forShare(): string;
  /** Weaker than FOR UPDATE: does not block inserts of rows that reference the locked row through a foreign key. */
  forNoKeyUpdate(): string;
  /** Lets several workers claim different rows of the same queue without waiting on each other. */
  forUpdateSkipLocked(): string;
}

export const sqliteDialect: Dialect = {
  name: 'sqlite',
  placeholder: () => '?',
  returning: (c) => ` RETURNING ${c}`,
  upsert: (cols, set) => ` ON CONFLICT (${cols.join(', ')}) DO UPDATE SET ${set}`,
  onConflictDoNothing: (cols) => ` ON CONFLICT${cols ? ` (${cols.join(', ')})` : ''} DO NOTHING`,
  nowIso: () => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ilike: (col) => `${col} LIKE ? ESCAPE '\\'`,
  orderCi: (col) => `lower(${col})`,
  greatest: (a, b) => `max(${a}, ${b})`,
  boolInt: (cond) => `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`,
  groupConcat: (col, sep) => `GROUP_CONCAT(${col}, '${sep}')`,
  bucket15: (col) => `substr(${col}, 1, 14) || printf('%02d', (CAST(substr(${col}, 15, 2) AS INTEGER) / 15) * 15)`,
  localDay: (col, tz) => `local_day(${col}, ${tz})`,
  jsonText: (col, key) => `json_extract(${col}, '$.${key}')`,
  forUpdate: () => '',
  forShare: () => '',
  forNoKeyUpdate: () => '',
  forUpdateSkipLocked: () => '',
};

export const pgDialect: Dialect = {
  name: 'postgres',
  placeholder: (n) => `$${n}`,
  returning: (c) => ` RETURNING ${c}`,
  upsert: (cols, set) => ` ON CONFLICT (${cols.join(', ')}) DO UPDATE SET ${set}`,
  onConflictDoNothing: (cols) => ` ON CONFLICT${cols ? ` (${cols.join(', ')})` : ''} DO NOTHING`,
  nowIso: () => `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  ilike: (col) => `${col} ILIKE ? ESCAPE '\\'`,
  orderCi: (col) => `lower(${col}) COLLATE "C"`,
  greatest: (a, b) => `GREATEST(${a}, ${b})`,
  boolInt: (cond) => `(CASE WHEN ${cond} THEN 1 ELSE 0 END)`,
  groupConcat: (col, sep) => `string_agg(${col}, '${sep}')`,
  bucket15: (col) => `substr(${col}, 1, 14) || lpad(((substr(${col}, 15, 2)::int / 15) * 15)::text, 2, '0')`,
  localDay: (col, tz) => `to_char((${col})::timestamptz AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
  jsonText: (col, key) => `(${col}::jsonb ->> '${key}')`,
  forUpdate: () => ' FOR UPDATE',
  forShare: () => ' FOR SHARE',
  forNoKeyUpdate: () => ' FOR NO KEY UPDATE',
  forUpdateSkipLocked: () => ' FOR UPDATE SKIP LOCKED',
};

/** Rewrites `?` placeholders to `$1..$n`, leaving quoted string literals alone. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") quote = !quote;
    out += c === '?' && !quote ? `$${++n}` : c;
  }
  return out;
}
