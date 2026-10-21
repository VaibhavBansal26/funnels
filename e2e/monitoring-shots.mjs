// Screenshots of Admin > Monitoring (off and on) for docs/design/. Boots the BUILT server in development mode (two-factor not required) with PLATFORM_ADMIN_EMAILS and, for the "on"
// state, a SENTRY_DSN that points at a tiny LOCAL listener on 127.0.0.1 that records envelopes: nothing leaves this machine.
//   npm run build (repo root), then: node monitoring-shots.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-monitoring-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const received = [];
const sentry = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { received.push(b.length); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); }).listen(0, '127.0.0.1');
await new Promise((r) => sentry.once('listening', r));
const SPORT = sentry.address().port;

async function boot(port, extra) {
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_PATH: ':memory:', JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', APP_PUBLIC_URL: `http://127.0.0.1:${port}`, WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PLATFORM_ADMIN_EMAILS: 'ops@example.test', MAIL_PORT: String(port + 1), ...extra };
  const p = spawn('node', ['--import', '../server/node_modules/tsx/dist/esm/index.mjs', 'server.mjs'], { cwd: join(root, 'e2e'), env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 200)); }
  return p;
}
const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const browser = await chromium.launch();
const servers = [];
process.on('exit', () => servers.forEach((x) => x.kill()));
for (const [state, port, extra] of [['off', 4395, {}], ['on', 4397, { SENTRY_DSN: `http://publickeyshots@127.0.0.1:${SPORT}/1`, SENTRY_RELEASE: 'a1b2c3d', SENTRY_ENVIRONMENT: 'production' }]]) {
  const proc = await boot(port, extra);
  servers.push(proc);
  const BASE = `http://127.0.0.1:${port}`;
  const reg = await (await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops@example.test', password: 'correct horse battery', name: 'Ops' }) })).json();
  for (const theme of ['light', 'dark']) {
    for (const size of [{ id: '1440', width: 1440, height: 900 }, { id: '390', width: 390, height: 844 }]) {
      const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
      await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, reg.token]);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin/monitoring`);
      await page.getByRole('region', { name: 'Error monitoring' }).waitFor();
      if (state === 'on') { await page.getByRole('button', { name: 'Send test error' }).click(); await page.getByRole('status').waitFor(); }
      await shot(page, `admin-monitoring-${state}-${size.id}-${theme}`);
      await ctx.close();
    }
  }
}
await browser.close();
for (const s of servers) s.kill();
sentry.close();
rmSync(dir, { recursive: true, force: true });
console.log(`written to ${out}; the local fake Sentry received ${received.length} envelope(s)`);
