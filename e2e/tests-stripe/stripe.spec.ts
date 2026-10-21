import { expect, test } from '@playwright/test';
import { addVerifiedDomain, register } from '../tests/helpers.js';

const PORT = Number(process.env.E2E_STRIPE_PORT ?? 4280);

const api = (page: import('@playwright/test').Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const h: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const r = await fetch(p as string, { method: m as string, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [method, path, body] as const);

test('connect Stripe from Settings, build a checkout with the wizard, and buy with a test card on the hosted page (fake Stripe)', async ({ page }) => {
  await register(page);

  // Settings > Payments: test mode banner, not connected, then the onboarding round trip
  await page.goto('/settings');
  const pay = page.getByRole('region', { name: 'Payments' });
  await expect(pay).toContainText('Test mode');
  await expect(pay).toContainText('Not connected');
  await expect(pay.getByRole('table', { name: 'Stripe test cards' })).toContainText('4242 4242 4242 4242');
  await pay.getByRole('button', { name: 'Connect Stripe' }).click();
  await page.getByRole('button', { name: 'Finish onboarding' }).click(); // the fake's hosted onboarding page
  await expect(page).toHaveURL(/\/settings\?connect=return/);
  await expect(pay).toContainText('Connected');
  await expect(pay).toContainText('E2E STORE');
  await expect(pay).toContainText('card');

  // a funnel with the wizard (API) on a verified domain, live
  const f = (await api(page, 'POST', '/api/funnels', { name: 'Poster shop', base_path: '/poster' })).json as { id: string };
  const built = await api(page, 'POST', `/api/funnels/${f.id}/payments`, { product: { create: { name: 'Poster', amount: 25, currency: 'USD' } } });
  expect(built.status).toBe(201);
  await addVerifiedDomain(page, 'shop.e2e.test');
  const domain = ((await api(page, 'GET', '/api/domains')).json as { data: { id: string }[] }).data[0]!;
  expect((await api(page, 'PATCH', `/api/funnels/${f.id}`, { status: 'live', domain_id: domain.id })).status).toBe(200);

  // the product was pushed to the (fake) Stripe account
  await page.goto('/products');
  await expect(page.getByRole('table', { name: 'Product catalog' }).getByRole('row', { name: /Poster/ })).toContainText('Synced to Stripe');

  // After payment the app redirects to the https address of the domain; the e2e domain is only served over plain http on the test port, so that one hop is rewritten.
  await page.route('**/api/public/checkout/return**', async (route) => {
    const r = await route.fetch({ maxRedirects: 0 });
    const to = (r.headers().location ?? '').replace('https://shop.e2e.test', `http://shop.e2e.test:${PORT}`);
    await route.fulfill({ status: 302, headers: { location: to } });
  });
  const checkoutPath = (built.json as { added: { path: string }[] }).added[0]!.path;
  // buyer: declined card first (back on the page, no order), then a successful one
  await page.goto(`http://shop.e2e.test:${PORT}${checkoutPath}`);
  await page.getByLabel('Email').first().fill('buyer@example.com');
  await page.getByRole('button', { name: /^Buy now/ }).click();
  await expect(page.getByRole('heading', { name: /Pay 25\.00 USD/ })).toBeVisible();
  await page.getByRole('button', { name: /declined/ }).click();
  await expect(page).toHaveURL(/purchase=cancelled/);
  await page.getByLabel('Email').first().fill('buyer@example.com');
  await page.getByRole('button', { name: /^Buy now/ }).click();
  await page.getByRole('button', { name: 'Pay with 4242 4242 4242 4242' }).click();
  await expect(page.getByRole('heading', { name: /Thank you for your order/ })).toBeVisible(); // the return URL finished the order and sent the buyer to the thank-you step

  await page.goto(`/funnels/${f.id}/orders`);
  const rows = page.getByRole('row', { name: /buyer@example\.com/ });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Poster');
  await expect(rows.first()).toContainText('$25.00');
});
