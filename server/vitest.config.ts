import { defineConfig } from 'vitest/config';

// TEST_DB selects the engine(s) the whole suite runs against: sqlite | pglite | pg (real server, needs TEST_PG_URL) | both (sqlite + pglite, default).
const choice = process.env.TEST_DB ?? 'both';
const engines = choice === 'both' ? ['sqlite', 'pglite'] : choice.split(',');

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: engines.map((engine) => ({
      extends: true as const,
      test: {
        name: engine,
        include: ['test/**/*.test.ts'],
        // The real-Postgres concurrency file only makes sense with a real server; it skips itself otherwise.
        env: { TEST_DB: engine },
      },
    })),
  },
});
