import { expect, test } from '@playwright/test';
import { register } from './helpers.js';

// Templates, product catalog, the add-payments wizard and product analytics, through the real UI (the mock payment provider, as in development).

const api = (page: import('@playwright/test').Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const h: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const r = await fetch(p as string, { method: m as string, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [method, path, body] as const);

test('templates: search and filter the library, preview on a device, use a checkout template and bind its products', async ({ page }) => {
  await register(page);
  await page.goto('/templates');
  await expect(page.getByRole('status').filter({ hasText: /templates?$/ })).toContainText(/28 templates/);
  await page.getByLabel('Search templates').fill('dentist');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: /^Preview/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.locator('iframe')).toBeVisible();
  await dlg.getByRole('button', { name: 'mobile' }).click();
  await expect(dlg.locator('iframe')).toHaveCSS('width', '390px');
  await dlg.getByRole('button', { name: 'Close' }).first().click();
  await page.getByLabel('Search templates').fill('');
  await page.getByRole('button', { name: 'Has checkout' }).click();
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.getByLabel('Search templates').fill('bump');
  await page.getByRole('button', { name: 'Use template Sales page with order bump and upsell' }).click();
  const wiz = page.getByRole('dialog', { name: /Use "Sales page/ });
  await expect(wiz.getByText('Products this funnel sells')).toBeVisible();
  await wiz.getByLabel('Funnel name').fill('Masterclass funnel');
  await wiz.getByRole('button', { name: 'Create funnel' }).click();
  await expect(page.getByRole('heading', { name: 'Masterclass funnel', level: 1 })).toBeVisible();
  await page.goto('/products');
  await expect(page.getByRole('table', { name: 'Product catalog' }).getByRole('row')).toHaveCount(4); // header + three products created from the template slots
});

test('products: create, change the price (immutable: replaced), archive and restore', async ({ page }) => {
  await register(page);
  await page.goto('/products');
  await page.getByRole('button', { name: 'New product' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'New product' });
  await drawer.getByLabel('Name', { exact: true }).fill('Starter kit');
  await drawer.getByLabel('Price').fill('49.50');
  await drawer.getByRole('button', { name: 'Create product' }).click();
  const table = page.getByRole('table', { name: 'Product catalog' });
  await expect(table.getByRole('row', { name: /Starter kit/ })).toContainText('$49.50');
  await expect(table.getByRole('row', { name: /Starter kit/ })).toContainText('Not connected');
  await table.getByRole('button', { name: 'Open Starter kit' }).click();
  const edit = page.getByRole('dialog', { name: 'Starter kit' });
  await edit.getByRole('button', { name: /^Change the price/ }).click();
  await edit.getByLabel('Price').last().fill('59');
  await edit.getByRole('button', { name: 'Save new price' }).click();
  await expect(edit.getByText('Replaced')).toBeVisible();
  await expect(edit.getByText('$59.00', { exact: false }).first()).toBeVisible();
  await edit.getByRole('button', { name: 'Archive product' }).click();
  await page.getByRole('dialog', { name: 'Archive this product?' }).getByRole('button', { name: 'Archive' }).click();
  await expect(edit.getByText(/This product is archived/)).toBeVisible();
  await edit.getByRole('button', { name: 'Restore' }).click();
  await expect(edit.getByRole('button', { name: 'Archive product' })).toBeVisible();
});

test('payments wizard builds the checkout steps; a purchase shows up in product analytics and can be summarised', async ({ page }) => {
  await register(page);
  const f = (await api(page, 'POST', '/api/funnels', { name: 'Shop funnel' })).json as { id: string };
  await page.goto(`/funnels/${f.id}/steps`);
  await page.getByRole('button', { name: 'Add payments' }).click();
  const wiz = page.getByRole('dialog', { name: 'Add payments to this funnel' });
  await wiz.getByLabel('Name').fill('Poster');
  await wiz.getByLabel('Price', { exact: true }).fill('25');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click(); // layout: one step
  await wiz.getByLabel(/Offer an order bump/).check();
  await wiz.getByLabel('Name').fill('Frame');
  await wiz.getByLabel('Price', { exact: true }).fill('9');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click(); // no upsell
  await wiz.getByRole('button', { name: 'Add payments' }).click();
  const steps = page.getByRole('list', { name: 'Funnel steps' });
  await expect(steps.getByRole('listitem')).toHaveCount(3); // landing, checkout, thank you
  await expect(steps).toContainText('Checkout');

  const stepsApi = (await api(page, 'GET', `/api/funnels/${f.id}/steps`)).json as { data: { id: string; name: string }[] };
  const co = stepsApi.data.find((s) => s.name === 'Checkout')!;
  const doc = ((await api(page, 'GET', `/api/funnels/${f.id}/steps/${co.id}/page`)).json as { doc: { products: { id: string; orderBump?: boolean }[] } }).doc;
  const main = doc.products.find((p) => !p.orderBump)!;
  const buy = await page.evaluate(async ([fid, sid, bid]) => (await fetch(`/api/public/checkout/${fid}/${sid}/${bid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e-buyer@example.com' }) })).status, [f.id, co.id, main.id] as const);
  expect(buy).toBe(200);

  await page.goto(`/funnels/${f.id}/products`);
  await expect(page.getByRole('table', { name: /Performance per product/ })).toContainText('Poster');
  await expect(page.getByRole('table', { name: /Performance per product/ }).getByRole('img', { name: /Net revenue of Poster/ })).toBeVisible();
  await page.getByRole('button', { name: 'Open details of Poster in USD' }).click();
  await expect(page.getByRole('dialog', { name: /Poster/ })).toContainText('Net revenue');
  await page.getByRole('dialog', { name: /Poster/ }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Summarise this period' }).first().click();
  await expect(page.getByTestId('summary-narrative')).toContainText('1 order');
  await expect(page.getByText('Priority 1')).toBeVisible();
});
