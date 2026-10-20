import { expect, test } from '@playwright/test';
import { signOut, addVerifiedDomain, createLeadMagnet, goLive, register } from './helpers.js';

// Every test starts from a freshly registered user, so tests do not depend on each other or on order.

test('register lands on an empty funnel list; sign out and back in works', async ({ page }) => {
  const u = await register(page);
  await expect(page.getByRole('heading', { name: 'No funnels yet' })).toBeVisible();
  await signOut(page);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Funnels' })).toBeVisible();
});

test('create a funnel from a template; steps reorder with the keyboard (Alt+Arrow)', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  const steps = page.getByRole('list', { name: 'Funnel steps' }).getByRole('listitem');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText('Landing page');
  await steps.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(steps.nth(0)).toContainText('Thank you');
  await expect(steps.nth(1)).toContainText('Landing page');
  await page.reload(); // the order was saved on the server, not only in the page
  await expect(steps.nth(0)).toContainText('Thank you');
});

test('live funnel on a verified domain: visitor submits the form, the lead and the analytics show up in the app', async ({ page, context }) => {
  const host = `offers${Date.now()}.e2e.test`;
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await addVerifiedDomain(page, host);
  await goLive(page, funnelId, host);

  const visitor = await context.newPage();
  await visitor.goto(`http://${host}:${new URL(page.url()).port}/free-guide`);
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('7 ways to double your email list');
  await visitor.getByLabel('First name').fill('Ada Lovelace');
  await visitor.getByLabel('Email address').fill('ada@example.com');
  await visitor.getByRole('checkbox').check();
  await visitor.getByRole('button', { name: /Send me the (free )?guide/ }).click();
  await expect(visitor.getByRole('heading', { name: 'Check your inbox!' })).toBeVisible();

  await page.goto(`/funnels/${funnelId}/leads`);
  await expect(page.getByText('ada@example.com').first()).toBeVisible();
  await page.goto(`/funnels/${funnelId}/analytics`);
  await expect(page.getByRole('main')).toContainText(/Opt-ins/i);
});

test('analytics tab renders its summary and charts without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Blocked script execution in 'about:srcdoc'/.test(m.text()) && errors.push(m.text())); // (that message is Playwright's own script refused by a sandboxed preview frame)
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await page.getByRole('link', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(new RegExp(`/funnels/${funnelId}/analytics`));
  await expect(page.getByRole('main').getByText(/Page views|Visitors/i).first()).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0); // no spinner left behind
  expect(errors).toEqual([]);
});
