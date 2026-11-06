import { expect, test, type Page } from '@playwright/test';
import { register } from './helpers.js';

// Cart and the on-page Payment form in a real browser, with the built-in test payments (PAYMENTS_PROVIDER=mock): the TEST card form never sends card numbers.

const token = (page: Page) => page.evaluate(() => localStorage.getItem('funnels.token'));

/** A live "Store with cart" funnel on its built-in address. Returns the address of the shop step and the funnel id. */
async function liveStore(page: Page) {
  await register(page);
  const h = { authorization: `Bearer ${await token(page)}`, 'content-type': 'application/json' };
  const made = await page.request.post('/api/templates/store-with-cart/use', { headers: h, data: {} });
  expect(made.status()).toBe(201);
  const f = await made.json();
  const live = await page.request.post(`/api/funnels/${f.id}/go-live`, { headers: h, data: { address: { kind: 'builtin' } } });
  expect(live.ok()).toBeTruthy();
  const base = ((await live.json()).funnel.address.base as string).replace(/\/$/, '');
  return { id: f.id as string, base };
}

async function payWith(page: Page, card: string) {
  const form = page.getByRole('form', { name: 'Your order' });
  await form.getByLabel('Test card number').fill(card);
  await form.getByLabel('Test card expiry').fill('12 / 34');
  await form.getByLabel('Test card security code').fill('123');
  await form.getByRole('button', { name: /^Pay now/ }).click();
  return form;
}

test('a visitor fills a cart with two products, changes a quantity, pays on the page with the TEST card and the orders show up', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { id, base } = await liveStore(page);
  const shop = await context.newPage();
  const cardNumbersSent: string[] = [];
  shop.on('request', (r) => { if (/4242/.test(r.postData() ?? '')) cardNumbersSent.push(r.url()); });
  await shop.goto(`${base}/shop`);
  const green = shop.getByRole('form', { name: 'Add Morning green tea to the cart' });
  await green.getByLabel('Quantity').selectOption('2');
  await green.getByRole('button', { name: 'Add to cart' }).click();
  await expect(green.getByRole('status')).toHaveText('Added to your cart.');
  await shop.getByRole('form', { name: 'Add Smoky black tea to the cart' }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(shop.getByRole('link', { name: 'Cart, 3 items' })).toBeVisible();

  await shop.getByRole('link', { name: 'View your cart' }).click();
  await expect(shop).toHaveURL(/\/shop-cart$/);
  const lines = shop.getByRole('list', { name: 'Items in your cart' });
  await expect(lines.getByRole('listitem')).toHaveCount(2);
  await shop.getByRole('button', { name: 'One more Smoky black tea' }).click();
  await expect(lines.getByRole('listitem').nth(1)).toContainText('$32.00');
  await expect(shop.locator('.fn-total')).toHaveText(/Total\s*\$60\.00/);
  await shop.getByRole('checkbox').check(); // the checkout step's order bump, offered in the cart
  await expect(shop.locator('.fn-total')).toHaveText(/Total\s*\$66\.00/);
  await shop.getByRole('link', { name: 'Continue to payment' }).click();

  await expect(shop).toHaveURL(/\/shop-checkout$/);
  const order = shop.getByRole('list', { name: 'Your order' });
  await expect(order).toContainText('Morning green tea × 2');
  await expect(order).toContainText('Smoky black tea × 2');
  await expect(order).toContainText('Bamboo tea infuser');
  await expect(shop.getByRole('note').filter({ hasText: 'TEST MODE' })).toBeVisible();
  await shop.getByLabel('Email').fill('cart-buyer@example.com');
  await payWith(shop, '4242 4242 4242 4242');
  await expect(shop).toHaveURL(/\/shop-thanks(\?|$)/);
  expect(cardNumbersSent).toEqual([]);

  await page.goto(`/funnels/${id}/orders`);
  await expect(page.getByText('cart-buyer@example.com').first()).toBeVisible();
  for (const name of ['Morning green tea', 'Smoky black tea', 'Bamboo tea infuser']) await expect(page.getByRole('cell', { name, exact: false }).first()).toBeVisible();
  await page.goto('/products');
  await page.getByRole('tab', { name: 'Performance' }).click();
  await expect(page.getByRole('table', { name: /Performance per product/ })).toContainText('Morning green tea');
  await expect(page.getByRole('table', { name: /Performance per product/ })).toContainText('Smoky black tea');
});

test('a declined test card shows the reason inline and the buyer can retry; a card that needs authentication opens the test challenge', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { base } = await liveStore(page);
  const shop = await context.newPage();
  await shop.goto(`${base}/shop`);
  await shop.getByRole('form', { name: 'Add Calm herbal blend to the cart' }).getByRole('button', { name: 'Add to cart' }).click();
  await expect(shop.getByRole('link', { name: 'Cart, 1 item' })).toBeVisible();
  await shop.goto(`${base}/shop-checkout`);
  await shop.getByLabel('Email').fill('retry-buyer@example.com');
  let form = await payWith(shop, '4000 0000 0000 0002');
  await expect(form.getByRole('status')).toHaveText('Your card was declined. Please try another card.');
  await expect(form.getByRole('button', { name: /^Pay now/ })).toBeEnabled();

  form = await payWith(shop, '4000 0025 0000 3155');
  const challenge = shop.getByRole('dialog', { name: 'Test authentication' });
  await expect(challenge).toBeVisible();
  await challenge.getByRole('button', { name: 'Fail authentication' }).click();
  await expect(form.getByRole('status')).toHaveText(/could not be authenticated/);

  await payWith(shop, '4000 0025 0000 3155');
  await shop.getByRole('dialog', { name: 'Test authentication' }).getByRole('button', { name: 'Complete authentication' }).click();
  await expect(shop).toHaveURL(/\/shop-thanks(\?|$)/);
});
