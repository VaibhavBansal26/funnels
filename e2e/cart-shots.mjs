// Screenshots of the cart and Payment form blocks for docs/design/ (and for design review): the published Shop, Cart and Checkout steps of the "Store with cart"
// template (with items in the cart and the TEST card form) and the builder with the Payment form selected, at 1440, 1024 and 390 px, light and dark. The "dark"
// published pages use dark section themes (pages do not follow the visitor's colour scheme); the app and the builder follow the colour scheme.
//   npm run build (repo root), then: node cart-shots.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-cart-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: ':memory:', JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', DATA_ENCRYPTION_KEY: 'shots-data-key-shots-data-key-shots-data-12', APP_PUBLIC_URL: BASE, APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test', WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000', EVENT_BUFFER_MS: '0', MAIL_PORT: String(PORT + 1), ACCESS_TOKEN_TTL_SECONDS: '3600' };
const server = spawn('node', ['--import', '../server/node_modules/tsx/dist/esm/index.mjs', 'server.mjs'], { cwd: join(root, 'e2e'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const call = async (method, path, body, token) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const reg = await call('POST', '/api/auth/register', { email: 'shots@example.test', password: 'correct horse battery', name: 'Ada Founder' });
const T = reg.token;

/** A live store; `dark` turns every section of its pages into a dark section. */
async function store(dark) {
  const f = await call('POST', '/api/templates/store-with-cart/use', undefined, T);
  if (dark) {
    await call('PATCH', `/api/funnels/${f.id}`, { name: 'Dark store' }, T);
    for (const s of f.steps) {
      const page = await call('GET', `/api/funnels/${f.id}/steps/${s.id}/page`, undefined, T);
      const walk = (n) => { if (n.type === 'fn-section') n.classes = [...(n.classes ?? []).filter((c) => !['fn-soft', 'fn-light', 'fn-dark', 'fn-accent-bg'].includes(c)), 'fn-dark']; for (const c of n.components ?? []) walk(c); };
      walk(page.doc.project.pages[0].frames[0].component);
      await call('PUT', `/api/funnels/${f.id}/steps/${s.id}/page`, { doc: page.doc, version: page.version }, T);
    }
  }
  const live = await call('POST', `/api/funnels/${f.id}/go-live`, { address: { kind: 'builtin' } }, T);
  return { f, base: live.funnel.address.base.replace(/\/$/, '') };
}
const stores = { light: await store(false), dark: await store(true) };

const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name, full = true) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: full });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const { f, base } = stores[theme];
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
    await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, T]);
    const page = await ctx.newPage();
    // Published: shop with two products added, the cart, the checkout with the TEST card form and a declined card message.
    await page.goto(`${base}/shop`);
    await page.getByRole('form', { name: 'Add Morning green tea to the cart' }).getByLabel('Quantity').selectOption('2');
    await page.getByRole('form', { name: 'Add Morning green tea to the cart' }).getByRole('button', { name: 'Add to cart' }).click();
    await page.getByRole('form', { name: 'Add Smoky black tea to the cart' }).getByRole('button', { name: 'Add to cart' }).click();
    await page.getByRole('link', { name: 'Cart, 3 items' }).waitFor();
    await shot(page, `cart-shop-${size.id}-${theme}`);
    await page.goto(`${base}/shop-cart`);
    await page.getByRole('list', { name: 'Items in your cart' }).waitFor();
    await page.getByRole('checkbox').check();
    await page.waitForTimeout(300);
    await shot(page, `cart-cart-${size.id}-${theme}`);
    await page.goto(`${base}/shop-checkout`);
    await page.getByRole('note').filter({ hasText: 'TEST MODE' }).waitFor();
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Test card number').fill('4000 0000 0000 0002');
    await page.getByLabel('Test card expiry').fill('12 / 34');
    await page.getByLabel('Test card security code').fill('123');
    await page.getByRole('button', { name: /^Pay now/ }).click();
    await page.getByText('Your card was declined').waitFor();
    await shot(page, `cart-checkout-${size.id}-${theme}`);
    // Builder: the checkout step with the Payment form selected and its settings open.
    await page.goto(`${BASE}/funnels/${f.id}/builder/${f.steps[2].id}`);
    await page.waitForSelector('[data-builder-ready="1"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const ed = window.__editor; const c = ed.getWrapper().find('[data-gjs-type="fn-payment"]')[0] ?? ed.getWrapper().findType('fn-payment')[0]; ed.select(c); c.getEl()?.scrollIntoView({ block: 'start' }); });
    const settingsTab = page.getByRole('tab', { name: /Settings/ });
    if (await settingsTab.count()) await settingsTab.first().click().catch(() => undefined);
    await page.waitForTimeout(600);
    await shot(page, `cart-builder-payment-${size.id}-${theme}`, false);
    await page.goto(`${BASE}/funnels/${f.id}/builder/${f.steps[0].id}`);
    await page.waitForSelector('[data-builder-ready="1"]');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const ed = window.__editor; const c = ed.getWrapper().findType('fn-cart-add')[0] ?? ed.getWrapper().findType('fn-catalog')[0]; ed.select(c); c.getEl()?.scrollIntoView({ block: 'center' }); });
    if (await settingsTab.count()) await settingsTab.first().click().catch(() => undefined);
    await page.waitForTimeout(600);
    await shot(page, `cart-builder-addtocart-${size.id}-${theme}`, false);
    if (theme === 'light') {
      await page.goto(`${BASE}/settings`);
      await page.getByRole('group', { name: 'Payment form on your pages' }).waitFor();
      await page.getByRole('group', { name: 'Payment form on your pages' }).scrollIntoViewIfNeeded();
      await shot(page, `cart-settings-payments-${size.id}-${theme}`, false);
    }
    await ctx.close();
  }
}
await browser.close();
stop();
console.log('written to', out);
