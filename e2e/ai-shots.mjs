// Screenshots of the AI funnel builder, the builder assistant, Google reviews and the identity pepper screens for docs/design/ (and for design review). Boots the e2e server (built app, fake Cloudflare Pages, job worker),
// builds a workspace with a published funnel, ad spend, attributed orders and an integration through the real API, and captures each screen at 1440, 1024 and 390 px, light and dark.
//   npm run build (repo root), then: node ai-shots.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-ai-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4394);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: ':memory:', JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', DATA_ENCRYPTION_KEY: 'shots-data-key-shots-data-key-shots-data-12', APP_PUBLIC_URL: BASE, APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test', WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', EVENT_BUFFER_MS: '0', JOB_POLL_MS: '300', PAGES_POLL_INTERVAL_MS: '300', PAGES_DEBOUNCE_SECONDS: '0', MAIL_PORT: String(PORT + 1), ACCESS_TOKEN_TTL_SECONDS: '3600' };
const server = spawn('node', ['--import', '../server/node_modules/tsx/dist/esm/index.mjs', 'server.mjs'], { cwd: join(root, 'e2e'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const call = async (method, path, body, token, raw) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(raw ? { 'content-type': raw } : body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120' }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const reg = await call('POST', '/api/auth/register', { email: 'shots@example.test', password: 'correct horse battery', name: 'Ada Founder' });
const T = reg.token;

await call('PUT', '/api/google-reviews/settings', { apiKey: 'AIzaSyD-shots-0000000000000000000000000', defaultPlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', defaultPlaceName: 'Corner Bakery' }, T);
const lead = await call('POST', '/api/templates/lead-magnet/use', undefined, T);
const build = await call('POST', '/api/ai/builds', { prompt: 'We run a neighbourhood bakery in Austin. Families can request custom birthday cakes, from $40 to $120. Friendly tone.', options: { products: 'create' } }, T);
let done;
for (let i = 0; i < 60; i++) { done = await call('GET', `/api/ai/builds/${build.id}`, undefined, T); if (!['queued', 'running'].includes(done.status)) break; await new Promise((r) => setTimeout(r, 300)); }
if (done.status !== 'succeeded') throw new Error(`build did not finish: ${JSON.stringify(done.error)}`);

const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name, target) {
  const png = join(dir, `${name}.png`);
  await (target ?? page).screenshot({ path: png, ...(target ? {} : { fullPage: true }) });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const RUNNING = { id: 'gen_demo', status: 'running', provider: 'anthropic', model: 'claude-sonnet-5-5', source: null, funnelId: null, usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, degraded: false, error: null, createdAt: '', completedAt: null,
  assumptions: ['No tone was given, so the voice is friendly.', 'No specific offer was named, so the pages describe a placeholder offer.'],
  stages: [['understanding', 'Understanding your brief', 'done'], ['strategy', 'Choosing the funnel', 'done'], ['products', 'Suggesting products', 'done'], ['copy:s1', 'Writing "Sales page"', 'running'], ['copy:s2', 'Writing "One-click upsell"', 'pending'], ['copy:s3', 'Writing "Thank-you page"', 'pending'], ['assembly', 'Building the pages', 'pending'], ['validation', 'Checking the result', 'pending'], ['saving', 'Saving the funnel', 'pending']].map(([id, label, status]) => ({ id, label, status })) };
const only = process.env.SHOTS_ONLY;
const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
    await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, T]);
    const page = await ctx.newPage();
    const want = (n) => !only || n.includes(only);
    const prep = () => page.goto(`${BASE}/healthz`);
    const aiTab = async () => { await page.goto(`${BASE}/funnels/new`); await page.getByRole('button', { name: /Generate with AI/ }).click(); await page.waitForTimeout(500); };
    if (want('ai-wizard-form')) { await prep(); await page.evaluate(() => localStorage.removeItem('funnels.ai.build')); await aiTab(); await page.getByLabel(/Describe your business/).fill('We run a neighbourhood bakery in Austin. Families can request custom birthday cakes, from $40 to $120.'); await page.getByRole('button', { name: /More details/ }).click(); await shot(page, `ai-wizard-form-${size.id}-${theme}`); }
    if (want('ai-wizard-progress')) { await page.route('**/api/ai/builds/gen_demo', (r) => r.fulfill({ json: RUNNING })); await prep(); await page.evaluate(() => localStorage.setItem('funnels.ai.build', 'gen_demo')); await aiTab(); await shot(page, `ai-wizard-progress-${size.id}-${theme}`); await page.unroute('**/api/ai/builds/gen_demo'); }
    if (want('ai-wizard-result')) { await prep(); await page.evaluate((id) => localStorage.setItem('funnels.ai.build', id), build.id); await aiTab(); await page.waitForTimeout(400); await shot(page, `ai-wizard-result-${size.id}-${theme}`); }
    if (want('settings-google-reviews')) { await page.goto(`${BASE}/settings`); await page.waitForTimeout(700); await shot(page, `settings-google-reviews-${size.id}-${theme}`, page.getByRole('region', { name: 'Google reviews' })); }
    if (want('settings-pepper')) { await page.goto(`${BASE}/settings`); await page.waitForTimeout(700); await shot(page, `settings-pepper-${size.id}-${theme}`, page.getByRole('region', { name: 'API access' })); }
    if (size.id !== '390' && (want('builder-ai-panel') || want('builder-reviews'))) {
      await page.goto(`${BASE}/funnels/${lead.id}/builder/${lead.steps[0].id}`);
      await page.waitForSelector('[data-builder-ready="1"]');
      await page.waitForTimeout(600);
      if (want('builder-ai-panel')) {
        await page.getByRole('tab', { name: 'AI assistant' }).click();
        await page.getByLabel('What should change?').fill('Add an FAQ about shipping');
        await page.getByRole('button', { name: /Suggest changes/ }).click();
        await page.getByTestId('ai-proposal').waitFor();
        await page.getByRole('button', { name: 'Preview on the page' }).click();
        await page.waitForTimeout(500);
        await shot(page, `builder-ai-panel-${size.id}-${theme}`);
        await page.getByRole('button', { name: 'Undo changes' }).click();
      }
      if (want('builder-reviews')) {
        await page.getByRole('tab', { name: 'Blocks' }).click();
        await page.getByLabel('Search blocks').fill('google reviews');
        await page.locator('[data-block="google-reviews"]').click();
        await page.waitForTimeout(500);
        await page.evaluate(() => { const ed = window.__editor; const c = ed.getWrapper().findType('fn-reviews')[0]; ed.select(c); c.getEl()?.scrollIntoView(); });
        await page.waitForTimeout(300);
        const openInspector = page.getByRole('button', { name: 'Open style and settings' });
        if (await openInspector.count()) await openInspector.click();
        await page.getByRole('tab', { name: /Settings/ }).click();
        await page.waitForTimeout(400);
        await shot(page, `builder-reviews-${size.id}-${theme}`);
      }
    }
    await ctx.close();
  }
}
await browser.close();
stop();
console.log('written to', out);
