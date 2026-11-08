import { expect, test, type Page } from '@playwright/test';
import { gradientPng } from '../png.mjs';
import { canvas, register } from './helpers.js';

// The Product catalog block end to end, with the built-in test payments (PAYMENTS_PROVIDER=mock): built in the builder, filled from the catalog when the page is
// rendered, two products added from its cards, seen in the Cart, paid on the page with the TEST card.

const token = (page: Page) => page.evaluate(() => localStorage.getItem('funnels.token'));

test('a Product catalog built in the builder lists the catalog; two of its products go to the cart and are paid with the TEST card', async ({ page, context }) => {
  test.setTimeout(120_000);
  await register(page);
  const h = { authorization: `Bearer ${await token(page)}` };
  const json = { ...h, 'content-type': 'application/json' };
  // The "Store with cart" template gives the Cart, Checkout and Thank you steps (and creates its teas); our own products join the catalog.
  const made = await page.request.post('/api/templates/store-with-cart/use', { headers: json, data: {} });
  expect(made.status()).toBe(201);
  const f = await made.json();
  const img = await page.request.post('/api/assets?name=apron.png', { headers: { ...h, 'content-type': 'image/png' }, data: gradientPng(160, 120, '#fde68a', '#f97316') });
  expect(img.status(), await img.text()).toBe(201);
  const apron = await page.request.post('/api/products', { headers: json, data: { name: 'Linen apron', description: 'Stone-washed linen with deep pockets.', images: [(await img.json()).url], imageAlt: 'An orange linen apron', price: { currency: 'USD', amount: 32 } } });
  expect(apron.status()).toBe(201);
  expect((await page.request.post('/api/products', { headers: json, data: { name: 'Tea club', type: 'subscription', price: { currency: 'USD', amount: 9, interval: 'month' } } })).status()).toBe(201);
  const gone = await (await page.request.post('/api/products', { headers: json, data: { name: 'Retired teapot', price: { currency: 'USD', amount: 50 } } })).json();
  await page.request.post(`/api/products/${gone.id}/archive`, { headers: json });

  // Builder: replace the template's catalog with a new Product catalog block from the block library, and set it up.
  await page.goto(`/funnels/${f.id}/builder/${f.steps[0].id}`);
  await page.waitForSelector('[data-builder-ready="1"]');
  await canvas(page).locator('.fn-catalog').first().click();
  await page.keyboard.press('Delete');
  await expect(canvas(page).locator('.fn-catalog')).toHaveCount(0);
  await canvas(page).locator('h1').first().click();
  await page.getByLabel('Search blocks').fill('catalog');
  await page.getByLabel(/^Add Product catalog\./).click();
  // The canvas previews the real catalog: active one-time products only.
  const grid = canvas(page).getByRole('list', { name: 'Products' });
  await expect(grid.getByRole('heading', { name: 'Linen apron' })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Morning green tea' })).toBeVisible();
  await expect(grid.getByRole('heading', { name: 'Tea club' })).toHaveCount(0);
  await expect(grid.getByRole('heading', { name: 'Retired teapot' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Sort products' }).click();
  await page.getByRole('option', { name: 'Price: low to high' }).click();
  await page.getByRole('switch', { name: 'Let buyers choose a quantity' }).click();
  await page.getByLabel('Most products shown').fill('4');
  await expect.poll(() => grid.getByRole('heading').allTextContents()).toEqual(['Bamboo tea infuser', 'Calm herbal blend', 'Morning green tea', 'Smoky black tea']);
  await page.getByLabel('Most products shown').fill('8');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();

  const live = await page.request.post(`/api/funnels/${f.id}/go-live`, { headers: json, data: { address: { kind: 'builtin' } } });
  expect(live.ok()).toBeTruthy();
  const base = ((await live.json()).funnel.address.base as string).replace(/\/$/, '');

  // The published page: cards from the catalog, buttons named with the product, the image with its alt text.
  const shop = await context.newPage();
  const cardNumbersSent: string[] = [];
  shop.on('request', (r) => { if (/4242/.test(r.postData() ?? '')) cardNumbersSent.push(r.url()); });
  await shop.goto(`${base}/shop`);
  const products = shop.getByRole('list', { name: 'Products' });
  await expect(products.getByRole('heading')).toHaveText(['Bamboo tea infuser', 'Calm herbal blend', 'Morning green tea', 'Smoky black tea', 'Linen apron']);
  await expect(products.getByRole('img', { name: 'An orange linen apron' })).toBeVisible();
  const apronCard = shop.getByRole('form', { name: 'Add Linen apron to the cart' });
  await apronCard.getByLabel('Quantity').selectOption('2');
  await apronCard.getByRole('button', { name: 'Add to cart: Linen apron' }).click();
  await expect(apronCard.getByRole('status')).toHaveText('Added to your cart.');
  await shop.getByRole('button', { name: 'Add to cart: Morning green tea' }).click();
  await expect(shop.getByRole('link', { name: 'Cart, 3 items' })).toBeVisible();

  await shop.getByRole('link', { name: 'View your cart' }).click();
  await expect(shop).toHaveURL(/\/shop-cart$/);
  const lines = shop.getByRole('list', { name: 'Items in your cart' });
  await expect(lines.getByRole('listitem')).toHaveCount(2);
  await expect(lines).toContainText('Linen apron');
  await expect(lines).toContainText('$64.00');
  await expect(lines).toContainText('Morning green tea');
  await expect(shop.locator('.fn-total')).toHaveText(/Total\s*\$78\.00/);
  await shop.getByRole('link', { name: 'Continue to payment' }).click();

  await expect(shop).toHaveURL(/\/shop-checkout$/);
  await expect(shop.getByRole('list', { name: 'Your order' })).toContainText('Linen apron × 2');
  await shop.getByLabel('Email').fill('catalog-buyer@example.com');
  const form = shop.getByRole('form', { name: 'Your order' });
  await form.getByLabel('Test card number').fill('4242 4242 4242 4242');
  await form.getByLabel('Test card expiry').fill('12 / 34');
  await form.getByLabel('Test card security code').fill('123');
  await form.getByRole('button', { name: /^Pay now/ }).click();
  await expect(shop).toHaveURL(/\/shop-thanks(\?|$)/);
  expect(cardNumbersSent).toEqual([]);

  await page.goto(`/funnels/${f.id}/orders`);
  await expect(page.getByText('catalog-buyer@example.com').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Linen apron', exact: false }).first()).toBeVisible();
});
