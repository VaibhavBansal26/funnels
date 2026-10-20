// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { EnvSchema } from '../src/config.js';
import { configDoc, openApiText, withPolicies, withRbac } from '../scripts/docgen.js';
import { BACKEND, makeHarness } from './helpers.js';

// Documentation enforcement (docs/adr/0012). Pure file checks, so they run once (with the sqlite project).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, f);
      if (['node_modules', 'dist', '.git', 'coverage'].includes(f)) continue;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        if (dir === '' && !['docs', '.github'].includes(f)) continue;
        walk(rel);
      } else if (f.endsWith('.md')) out.push(rel);
    }
  };
  walk('');
  return out;
}

const slug = (h: string) => h.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
const anchorsOf = (md: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
};
const strip = (md: string) => md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

describe.skipIf(BACKEND !== 'sqlite')('documentation', () => {
  const files = markdownFiles();

  it('has no broken relative links or anchors', () => {
    const broken: string[] = [];
    for (const f of files) {
      for (const m of strip(read(f)).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:)/.test(target)) continue;
        const [path, anchor] = target.split('#');
        const abs = path ? resolve(ROOT, dirname(f), path) : resolve(ROOT, f);
        if (!existsSync(abs)) {
          broken.push(`${f}: ${target} (missing file)`);
          continue;
        }
        if (anchor && abs.endsWith('.md') && !anchorsOf(readFileSync(abs, 'utf8')).has(anchor)) broken.push(`${f}: ${target} (missing anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('lists every file under docs/ in docs/README.md', () => {
    const index = read('docs/README.md');
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(join(ROOT, dir))) {
        const rel = join(dir, f);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (rel !== 'docs/README.md' && !index.includes(`(${relative('docs', rel)})`)) missing.push(rel);
      }
    };
    walk('docs');
    expect(missing, 'add these to docs/README.md').toEqual([]);
  });

  it('documents exactly the environment variables of the config schema', () => {
    const doc = read('docs/CONFIGURATION.md');
    const documented = new Set([...doc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]));
    const defined = new Set(Object.keys(EnvSchema.shape));
    expect([...defined].filter((k) => !documented.has(k)), 'defined but undocumented').toEqual([]);
    expect([...documented].filter((k) => !defined.has(k!)), 'documented but not defined').toEqual([]);
    const example = read('.env.example');
    expect([...defined].filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(example) && !['WEB_DIST', 'NODE_ENV'].includes(k)), '.env.example is missing').toEqual([]);
  });

  it('has generated documents that are up to date (run npm run docs:config / docs:api)', () => {
    expect(read('docs/CONFIGURATION.md') === configDoc(), 'docs/CONFIGURATION.md is stale: npm run docs:config').toBe(true);
    expect(read('docs/openapi.json') === openApiText(), 'docs/openapi.json is stale: npm run docs:api').toBe(true);
    const rl = read('docs/RATE-LIMITING.md');
    expect(rl === withPolicies(rl), 'the policy table in docs/RATE-LIMITING.md is stale: npm run docs:config').toBe(true);
    const rbac = read('docs/RBAC.md');
    expect(rbac === withRbac(rbac), 'the permission and route tables in docs/RBAC.md are stale: npm run docs:config').toBe(true);
    expect(rbac).toContain('<!-- permissions:start -->');
    expect(rbac).toContain('<!-- routes:start -->');
  });

  it('has an OpenAPI entry for every route the app registers', async () => {
    const h = await makeHarness();
    const spec = JSON.parse(read('docs/openapi.json')) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.replace(/\{([A-Za-z]+)\}/g, ':$1').replace('/:rest', '/*')}`)));
    const missing = createApp(h.deps).routes.filter((r) => r.method !== 'ALL' && r.path !== '/*' && !documented.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('has valid Mermaid diagrams', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const k of ['window', 'document', 'navigator'] as const) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
    const mermaid = (await import('mermaid')).default;
    const bad: string[] = [];
    let count = 0;
    for (const f of files) {
      for (const m of read(f).matchAll(/```mermaid\n([\s\S]*?)```/g)) {
        count++;
        try {
          await mermaid.parse(m[1]!);
        } catch (e) {
          bad.push(`${f}: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }
    expect(count).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('keeps an Unreleased section in the changelog', () => {
    expect(read('CHANGELOG.md')).toMatch(/^## \[Unreleased\]/m);
  });

  it('runs the examples in docs/API.md marked runnable', async () => {
    const h = await makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '1000' } });
    const vars: Record<string, string> = {};
    const sub = (s: string) => s.replace(/\$\{?([A-Z_]+)\}?/g, (m, n: string) => vars[n] ?? m);
    const get = (obj: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
    let ran = 0;
    for (const block of read('docs/API.md').matchAll(/```bash\n# runnable\n([\s\S]*?)```/g)) {
      let last: { status: number; json: unknown } | null = null;
      for (const line of block[1]!.split('\n')) {
        const save = /^# save ([A-Z_]+)=(.+)$/.exec(line);
        if (save) {
          const v = get(last?.json, save[2]!);
          expect(v, `${line}: nothing at that path in ${JSON.stringify(last)}`).toBeDefined();
          vars[save[1]!] = String(v);
          continue;
        }
        if (!line.startsWith('curl')) continue;
        const cmd = sub(line);
        const url = /(?:"|\s)(?:\$BASE|http:\/\/localhost:3000)?(\/[^\s"']+)/.exec(cmd.replace(/\$BASE/g, ''))?.[1];
        expect(url, line).toBeTruthy();
        const method = /-X (\w+)/.exec(cmd)?.[1] ?? 'GET';
        const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.50' };
        for (const hm of cmd.matchAll(/-H '([^']+)'|-H "([^"]+)"/g)) {
          const [k, ...v] = (hm[1] ?? hm[2]!).split(': ');
          headers[k!.toLowerCase()] = v.join(': ');
        }
        const body = /-d '([^']*)'/.exec(cmd)?.[1];
        const res = await h.app.request(url!, { method, headers, body });
        const text = await res.text();
        last = { status: res.status, json: text ? JSON.parse(text) : null };
        ran++;
        const expected = /-X PUT/.test(cmd) && /"blocks":\[\]/.test(cmd) ? 409 : method === 'POST' && url!.startsWith('/api/public') ? 202 : method === 'POST' && url!.includes('/funnels') ? 201 : method === 'POST' ? 201 : 200;
        expect(res.status, `${line} -> ${text}`).toBe(expected);
      }
    }
    expect(ran).toBeGreaterThanOrEqual(8);
  });
});
