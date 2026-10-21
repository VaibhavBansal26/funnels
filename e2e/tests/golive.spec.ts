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

test('without a Cloudflare connection the Pages address explains what is missing', async ({ page }) => {
  await register(page);
  const id = await leadMagnet(page);
  await page.goto(`/funnels/${id}/settings`);
  const panel = page.getByRole('region', { name: 'Go live' });
  await expect(panel.getByText(/Connect a Cloudflare account first/)).toBeVisible();
  await expect(panel.getByRole('button', { name: /Go live/ })).toBeDisabled();
});
