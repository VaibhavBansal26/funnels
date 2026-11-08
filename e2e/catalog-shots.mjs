// Screenshots of the Product catalog block for docs/design/ (and for design review): the published Shop step of "Store with cart" (whose teas are a Product
// catalog) with product images, the builder with the block selected and its settings open, the builder preview of an empty catalog, and the product drawer with
// the image alt text, at 1440, 1024 and 390 px, light and dark. The "dark" published pages use dark section themes (pages do not follow the visitor's colour
// scheme); the app and the builder follow the colour scheme.
//   npm run build (repo root), then: node catalog-shots.mjs [outDir]
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { gradientPng } from './png.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] ?? join(root, 'docs/design');
const dir = join(tmpdir(), `funnels-catalog-shots-${process.pid}`);
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SHOTS_PORT ?? 4000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: ':memory:', JWT_SECRET: 'shots-secret-shots-secret-shots-secret-12', DATA_ENCRYPTION_KEY: 'shots-data-key-shots-data-key-shots-data-12', APP_PUBLIC_URL: BASE, APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test', WEB_DIST: join(root, 'web/dist'), LOG_LEVEL: 'error', IP_GUARD_PER_MINUTE: '1000000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000', EVENT_BUFFER_MS: '0', MAIL_PORT: String(PORT + 1), ACCESS_TOKEN_TTL_SECONDS: '3600' };
const server = spawn('node', ['--import', '../server/node_modules/tsx/dist/esm/index.mjs', 'server.mjs'], { cwd: join(root, 'e2e'), env, stdio: 'ignore' });
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }

const call = async (method, path, body, token, raw) => {
  const headers = { ...(raw ? { 'content-type': 'image/png' } : body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120' };
  const res = await fetch(`${BASE}${path}`, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const reg = await call('POST', '/api/auth/register', { email: 'shots@example.test', password: 'correct horse battery', name: 'Ada Founder' });
const T = reg.token;
const empty = (await call('POST', '/api/auth/register', { email: 'shots-empty@example.test', password: 'correct horse battery', name: 'Ben Newshop' })).token;

/** A live store with product photos; `dark` turns every section of its pages into a dark section. */
const PHOTOS = { 'Morning green tea': ['#d9f99d', '#16a34a', 'A tin of loose green tea leaves'], 'Smoky black tea': ['#fde68a', '#9a3412', 'Dark twisted black tea leaves'], 'Calm herbal blend': ['#f5d0fe', '#7c3aed', 'Dried chamomile and lavender flowers'] };
async function store(dark) {
  const f = await call('POST', '/api/templates/store-with-cart/use', undefined, T);
  if (!dark) {
    const list = await call('GET', '/api/products?limit=100', undefined, T);
    for (const p of list.data) {
      const photo = PHOTOS[p.name];
      if (!photo || p.images.length) continue;
      const a = await call('POST', `/api/assets?name=${encodeURIComponent(p.name)}.png`, undefined, T, gradientPng(480, 360, photo[0], photo[1]));
      await call('PATCH', `/api/products/${p.id}`, { images: [a.url], imageAlt: photo[2] }, T);
    }
  }
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
// Light first: it adds the photos to the shared catalog, so the dark store (same workspace, bound to the same teas) shows them too.
const stores = { light: await store(false) };
stores.dark = await store(true);
// A funnel with a Product catalog and no products yet (the builder shows labelled samples).
const emptyFunnel = await call('POST', '/api/funnels', { name: 'New shop' }, empty);
const emptyStep = (await call('GET', `/api/funnels/${emptyFunnel.id}/steps`, undefined, empty)).data[0];

const hasWebp = spawnSync('cwebp', ['-version']).status === 0;
async function shot(page, name, full = true) {
  const png = join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: full });
  if (hasWebp && spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', png, '-o', join(out, `${name}.webp`)]).status === 0) return;
  copyFileSync(png, join(out, `${name}.png`));
}
const selectCatalog = (page) => page.evaluate(() => { const ed = window.__editor; const c = ed.getWrapper().findType('fn-catalog')[0]; if (c) { ed.select(c); c.getEl()?.scrollIntoView({ block: 'start' }); } });
const SIZES = [{ id: '1440', width: 1440, height: 900 }, { id: '1024', width: 1024, height: 768 }, { id: '390', width: 390, height: 844 }];
const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const { f, base } = stores[theme];
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme });
    await ctx.addInitScript(([t, tok]) => { localStorage.setItem('funnels.theme', t); localStorage.setItem('funnels.token', tok); }, [theme, T]);
    const page = await ctx.newPage();
    // Published: the shop with one product just added (the card's status line and the cart badge).
    await page.goto(`${base}/shop`);
    await page.getByRole('list', { name: 'Products' }).waitFor();
    const green = page.getByRole('form', { name: 'Add Morning green tea to the cart' });
    await green.getByLabel('Quantity').selectOption('2');
    await green.getByRole('button', { name: /Add to cart/ }).click();
    await page.getByRole('link', { name: 'Cart, 2 items' }).waitFor();
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    await shot(page, `catalog-shop-${size.id}-${theme}`);
    // Builder: the shop step with the Product catalog selected and its settings open.
    await page.goto(`${BASE}/funnels/${f.id}/builder/${f.steps[0].id}`);
    await page.waitForSelector('[data-builder-ready="1"]');
    await page.waitForTimeout(800);
    await selectCatalog(page);
    const settingsTab = page.getByRole('tab', { name: /Settings/ });
    if (await settingsTab.count()) await settingsTab.first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await shot(page, `catalog-builder-${size.id}-${theme}`, false);
    if (size.id !== '390') {
      // The product drawer with the image and its alt text.
      await page.goto(`${BASE}/products`);
      await page.getByRole('button', { name: 'Open Morning green tea' }).click();
      await page.getByRole('dialog', { name: 'Morning green tea' }).waitFor();
      await page.waitForTimeout(400);
      await shot(page, `catalog-product-image-${size.id}-${theme}`, false);
    }
    await ctx.close();
  }
}
// The builder preview of an empty catalog: labelled samples.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await ctx.addInitScript(([tok]) => { localStorage.setItem('funnels.theme', 'light'); localStorage.setItem('funnels.token', tok); }, [empty]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/funnels/${emptyFunnel.id}/builder/${emptyStep.id}`);
  await page.waitForSelector('[data-builder-ready="1"]');
  await page.getByLabel('Search blocks').fill('catalog');
  await page.getByLabel(/^Add Product catalog\./).click();
  await page.waitForTimeout(800);
  await selectCatalog(page);
  await page.waitForTimeout(400);
  await shot(page, 'catalog-builder-empty-1440-light', false);
  await ctx.close();
}
await browser.close();
stop();
console.log('written to', out);
