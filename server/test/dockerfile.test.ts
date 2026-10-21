import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Docker web stage only copies the server folders the web app compiles. When the web app gains an alias into
// server/src, the Dockerfile must copy it too, or `docker build` fails (as it did for @pagemodel on first deploy).
const root = resolve(__dirname, '..', '..');
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
const copied = [...dockerfile.matchAll(/^COPY (server\/src\/\S+) /gm)].map((m) => m[1]);

describe('Dockerfile web stage', () => {
  it('copies every server/src folder the web aliases point into', () => {
    const vite = readFileSync(resolve(root, 'web', 'vite.config.ts'), 'utf8');
    const targets = [...vite.matchAll(/r\('\.\.\/(server\/src\/[^']+)'\)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const covered = copied.some((dir) => target === dir || target.startsWith(`${dir}/`));
      expect(covered, `Dockerfile does not COPY a folder containing ${target}`).toBe(true);
    }
  });

  it('copies the block model that the shared page model imports', () => {
    expect(copied).toContain('server/src/blocks');
  });
});
