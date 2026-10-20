import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The route spec, auth and rate-limit modules import each other, so the order a script loads them in matters.
// These run the real scripts in a child process: unit tests import modules in a friendlier order and miss it.
describe('script entry points', () => {
  it('npm run seed creates demo data on a fresh database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funnels-seed-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_PATH: join(dir, 'seed.db'), NODE_ENV: 'development' };
      delete env.DATABASE_URL;
      const out = execFileSync('npx', ['tsx', 'src/seed.ts'], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 90_000,
      });
      expect(out).toMatch(/demo@example\.test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
