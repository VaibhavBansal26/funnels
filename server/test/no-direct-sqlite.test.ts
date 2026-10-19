import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKEND } from './helpers.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// Pure source scan, so it only needs to run once.
describe.skipIf(BACKEND !== 'sqlite')('the data layer boundary', () => {
  const all = files(SRC).map((p) => ({ path: relative(SRC, p), text: stripComments(readFileSync(p, 'utf8')) }));
  const outsideDb = all.filter((f) => !f.path.startsWith('db/'));

  it('no code outside src/db imports node:sqlite or touches DatabaseSync', () => {
    const bad = all.filter((f) => f.path !== 'db/sqlite.ts' && /node:sqlite|DatabaseSync|\bStatementSync\b/.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('no code outside src/db reaches for driver internals (.raw, pg Pool, PGlite)', () => {
    const bad = outsideDb.filter((f) => /\bdb\.raw\b|from 'pg'|@electric-sql\/pglite/.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('SQLite-only SQL stays out of services, routes and repositories (use dialect helpers)', () => {
    const banned = /INSERT OR (IGNORE|REPLACE)|datetime\(\s*'now'|json_extract|GROUP_CONCAT|COLLATE NOCASE|strftime\(|\bPRAGMA\b|\browid\b|AUTOINCREMENT|last_insert_rowid/i;
    const bad = outsideDb.filter((f) => banned.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('migrations exist for both dialects with the same file names', () => {
    const dir = (d: string) => readdirSync(join(SRC, 'db/migrations', d)).filter((f) => f.endsWith('.sql')).sort();
    expect(dir('pg')).toEqual(dir('sqlite'));
  });
});
