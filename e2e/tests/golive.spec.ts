import { expect, test, type Page } from '@playwright/test';
import { register } from './helpers.js';

// The fake Cloudflare of e2e/server.mjs (server/test/support/fakecf.ts). Not real credentials.
const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cf-test-token-0123456789abcdef';

const authed = (page: Page) => page.evaluate(() => localStorage.getItem('funnels.token'));

async function leadMagnet(page: Page) {
  return page.evaluate(async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    return (await (await fetch('/api/templates/lead-magnet/use', { method: 'POST', headers: h })).json()).id as string;
  });
}

test('go live on the free pages.dev address without a domain, then take it offline', async ({ page }) => {
  test.setTimeout(90_000);
  await register(page);
  const id = await leadMagnet(page);
  const token = await authed(page);
  const conn = await page.request.put('/api/publishing/connection', { headers: { authorization: `Bearer ${token}` }, data: { accountId: ACCOUNT, token: TOKEN } });
  expect(conn.ok()).toBeTruthy();

  await page.goto(`/funnels/${id}/settings`);
  const panel = page.getByRole('region', { name: 'Go live' });
  await expect(panel.getByText('Test vs live.')).toBeVisible();
  await expect(panel.getByText('Test mode', { exact: true })).toBeVisible();
  await panel.getByRole('radio', { name: /Cloudflare Pages address/ }).check();
  await expect(panel.getByTestId('final-url')).toContainText('.pages.dev');
  await panel.getByRole('button', { name: /Go live/ }).click();
  await expect(panel.getByText('Live', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('final-url')).toContainText(/https:\/\/fn-[0-9a-f]{8}\.pages\.dev\//);
  await expect(panel.getByRole('link', { name: /Open/ })).toHaveAttribute('href', /\.pages\.dev\//);
  await expect(page.getByRole('heading', { name: 'Lead magnet', level: 1 }).locator('..')).toContainText('.pages.dev');

  await panel.getByRole('button', { name: /Take offline/ }).click();
  await expect(panel.getByText('Test mode', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Publishing' }).first()).toBeVisible();
});

test('without a Cloudflare connection the Pages address explains what is missing and the built-in address still works', async ({ page }) => {
  await register(page);
  const id = await leadMagnet(page);
  await page.goto(`/funnels/${id}/settings`);
  const panel = page.getByRole('region', { name: 'Go live' });
  await expect(panel.getByText(/Connect a Cloudflare account first/).first()).toBeVisible();
  await expect(panel.getByRole('radio', { name: /Cloudflare Pages address/ })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Go live/ })).toBeEnabled();
});

test('go live on the free built-in address with no account and no domain; the opt-in form continues under the prefix; the address can be renamed', async ({ page }) => {
  test.setTimeout(90_000);
  await register(page);
  const id = await leadMagnet(page);
  await page.goto(`/funnels/${id}/settings`);
  const panel = page.getByRole('region', { name: 'Go live' });
  await expect(panel.getByRole('radio', { name: /Built-in address \(free\)/ })).toBeChecked();
  await expect(panel.getByTestId('final-url')).toContainText('/s/');
  await panel.getByRole('button', { name: /Go live/ }).click();
  await expect(panel.getByText('Live', { exact: true })).toBeVisible();
  const url = (await panel.getByTestId('final-url').textContent())!;
  expect(new URL(url).pathname).toMatch(/^\/s\/[a-z0-9-]+\/lead-magnet\/free-guide$/);

  // a visitor opens it, fills the opt-in form and lands on the next step, still under the prefix
  await page.goto(url);
  await expect(page.locator('form[data-fn-form]')).toBeVisible();
  const base = new URL(url).pathname.replace(/\/free-guide$/, '');
  await page.locator('form[data-fn-form] input[type=email]').fill('visitor@example.test');
  await page.locator('form[data-fn-form] input[name=name]').fill('Vera Visitor').catch(() => undefined);
  const consent = page.locator('form[data-fn-form] input[name=_consent]');
  if (await consent.count()) await consent.check();
  await page.locator('form[data-fn-form] button[type=submit]').click();
  await page.waitForURL((u) => u.pathname !== new URL(url).pathname && u.pathname.startsWith(`${base}/`), { timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText('Not found');
  // cookies are scoped to the workspace prefix
  const cookies = await page.context().cookies();
  expect(cookies.filter((c) => ['visitor_id', 'funnel_id', 'step_id'].includes(c.name)).every((c) => c.path === base.split('/').slice(0, 3).join('/'))).toBe(true);

  // rename the address: the old one stops answering
  await page.goto(`/funnels/${id}/settings`);
  const p2 = page.getByRole('region', { name: 'Go live' });
  await p2.getByLabel('Address name').fill('my-offer');
  await p2.getByRole('button', { name: 'Save name' }).click();
  await expect(p2.getByTestId('final-url')).toContainText('/my-offer/', { timeout: 15_000 });
  expect((await page.request.get(url)).status()).toBe(404);
  expect((await page.request.get(url.replace('/lead-magnet/free-guide', '/my-offer/free-guide'))).status()).toBe(200);
});

test('a built-in page with owner-authored code runs in a CSP sandbox: its script works, but it is not the app (no cookies, no session) and the beacon still reports the visit', async ({ page }) => {
  test.setTimeout(60_000);
  await register(page);
  const id = await leadMagnet(page);
  const token = await authed(page);
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  expect((await page.request.patch('/api/workspace', { headers: h, data: { allowCustomScripts: true } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/funnels/${id}`, { headers: h, data: { header_tracking_code: '<script>window.__owner = 42;</script>' } })).ok()).toBeTruthy();
  const live = await page.request.post(`/api/funnels/${id}/go-live`, { headers: h, data: { address: { kind: 'builtin' } } });
  const url = (await live.json()).funnel.address.url as string;

  const events = page.waitForResponse((r) => r.url().endsWith('/api/public/events') && r.request().method() === 'POST');
  const res = await page.goto(url);
  expect(res!.headers()['content-security-policy']).toContain('sandbox allow-scripts');
  expect(await page.evaluate(() => (window as unknown as { __owner: number }).__owner)).toBe(42); // the owner's script ran
  expect(await page.evaluate(() => window.origin)).toBe('null'); // opaque origin: it can never act as the app
  expect(await page.evaluate(() => { try { return document.cookie; } catch { return 'blocked'; } })).toBe('blocked');
  const calledApp = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      return r.status;
    } catch {
      return 'blocked';
    }
  });
  expect([401, 'blocked']).toContain(calledApp); // never answered as the signed-in user
  expect((await events).status()).toBe(202); // the beacon works without cookies
});
