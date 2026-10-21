import { expect, test, type Page } from '@playwright/test';
import { addVerifiedDomain, goLive, register } from './helpers.js';

// The fake Cloudflare of e2e/server.mjs (server/test/support/fakecf.ts): account id 32 x "a", token below. Not real credentials.
const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'cf-test-token-0123456789abcdef';

/** A funnel from the lead magnet template through the API (the template gallery now opens a wizard, which these tests are not about). */
async function createLeadMagnet(page: Page) {
  const id = await page.evaluate(async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    return (await (await fetch('/api/templates/lead-magnet/use', { method: 'POST', headers: h })).json()).id as string;
  });
  await page.goto(`/funnels/${id}/steps`);
  await expect(page.getByRole('list', { name: 'Funnel steps' })).toBeVisible();
  return { funnelId: id };
}

const token = (page: Page) => page.evaluate(() => localStorage.getItem('funnels.token'));

test('connect Cloudflare (fake), publish a funnel to Pages, see the deployment history, roll back', async ({ page }) => {
  test.setTimeout(90_000);
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await addVerifiedDomain(page, 'pages.e2e.test');
  await goLive(page, funnelId, 'pages.e2e.test');

  // Settings > Publishing: a wrong token is explained, the right one connects and is shown masked
  await page.goto('/settings');
  const conn = page.getByRole('region', { name: 'Publishing' });
  await conn.getByLabel('Account id').fill(ACCOUNT);
  await conn.getByLabel('API token').fill('wrong-token-0123456789abcdef');
  await conn.getByRole('button', { name: 'Connect' }).click();
  await expect(conn.getByRole('alert')).toContainText('Cloudflare Pages: Edit');
  await conn.getByLabel('API token').fill(TOKEN);
  await conn.getByRole('button', { name: 'Connect' }).click();
  await expect(conn.getByText('Connected', { exact: true })).toBeVisible();
  await expect(conn).toContainText('••••cdef');
  await expect(page.locator('body')).not.toContainText(TOKEN);

  // the funnel's Publishing card
  await page.goto(`/funnels/${funnelId}/settings`);
  const card = page.getByRole('region', { name: 'Publishing' });
  await expect(card).toContainText('This server');
  await card.getByRole('button', { name: 'Publish with Cloudflare Pages' }).click();
  await expect(card.getByRole('link', { name: /\.pages\.dev/ })).toBeVisible();
  await expect(card.getByRole('table', { name: /Deployments/ }).getByText('Live')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Current')).toBeVisible();
  await expect(card.getByText('pages.e2e.test').first()).toBeVisible();

  // a second version, then roll back to the first
  await card.getByRole('button', { name: 'Redeploy' }).click();
  await expect(card.getByRole('row', { name: /Redeploy/ })).toContainText('Live', { timeout: 30_000 });
  await card.getByRole('row').filter({ hasText: 'Published' }).getByRole('button', { name: 'Roll back' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back' }).click();
  await expect(card.getByText(/A rollback is in place/)).toBeVisible();
  await card.getByRole('row').nth(1).getByRole('button', { name: 'Log' }).click();
  await expect(page.getByRole('dialog', { name: 'Deployment log' })).toContainText('Rolling back');
  await page.keyboard.press('Escape');

  // unpublish replaces the site with a paused page
  await card.getByRole('button', { name: 'Unpublish…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause the site' }).click();
  await expect(card.getByText(/This site is unpublished/)).toBeVisible();
  expect(await token(page)).toBeTruthy();
});

test('Meta pixel and cookie consent on a preview: nothing fires before Accept, then the events do', async ({ page, context }) => {
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await page.goto(`/funnels/${funnelId}/settings`);
  const px = page.getByRole('region', { name: 'Tracking and ad pixels' });
  await px.getByLabel('Meta Pixel ID').fill('not-a-pixel');
  await expect(px.getByText(/Enter the Meta Pixel ID/)).toBeVisible();
  await expect(px.getByRole('button', { name: 'Save tracking' })).toBeDisabled();
  await px.getByLabel('Meta Pixel ID').fill('123456789012345');
  await px.getByLabel('Ask visitors before loading advertising pixels').check();
  await px.getByLabel('Send a Lead event').check().catch(async () => px.getByRole('checkbox', { name: /Lead/ }).check());
  await px.getByRole('button', { name: 'Save tracking' }).click();
  await expect(page.getByText('Tracking saved. Pages are being updated.', { exact: true })).toBeVisible();

  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open signed preview' }).click();
  const preview = await popup;
  await preview.waitForLoadState('domcontentloaded');
  const banner = preview.getByRole('dialog', { name: 'We value your privacy' });
  await expect(banner).toBeVisible();
  await expect(preview.locator('[data-fn-pixel-debug]')).toContainText('queued');
  expect(await preview.evaluate(() => (window as any).__fnAdsLog.filter((l: any) => l.network === 'meta').length)).toBe(0);
  await banner.getByRole('button', { name: 'Accept' }).click();
  await expect(preview.locator('[data-fn-pixel-debug]')).toContainText('meta: track PageView');
});

test('Ads: import ad spend from CSV, see it matched to attributed orders with ROAS, and the unmatched campaign', async ({ page }) => {
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

  // an attributed visit and a paid order (the mock payment provider) from a Meta campaign
  const made = await page.evaluate(async ({ pre }) => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const f = await (await fetch('/api/templates/sales-page-bump-upsell/use', { method: 'POST', headers: h })).json();
    const step = f.steps[0];
    const doc = (await (await fetch(`/api/funnels/${f.id}/steps/${step.id}/page`, { headers: h })).json()).doc;
    const main = doc.products.find((b: any) => b.type === 'checkout' && !b.orderBump && !b.oneClickUpsell);
    const ua = { 'content-type': 'application/json' };
    await fetch('/api/public/attribution', { method: 'POST', headers: ua, body: JSON.stringify({ funnelId: f.id, stepId: step.id, visitorId: 'e2e-visitor', touch: { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'Spring Sale' }, ids: { consent: 'na' } }) });
    const r = await fetch(`/api/public/checkout/${f.id}/${step.id}/${main.id}`, { method: 'POST', headers: ua, body: JSON.stringify({ email: 'buyer@example.com', name: 'Bea Buyer', visitorId: 'e2e-visitor' }) });
    void pre;
    return r.status;
  }, { pre: 1 });
  expect(made).toBe(200);

  await page.goto('/ads/spend');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  const csv = `date,source,campaign,currency,spend,clicks\n${day},facebook,Spring Sale,USD,100.00,250\n${day},google,Brand Search,USD,40.00,80\n${day},facebook,Bad,USD,abc,1\n`;
  await page.getByLabel('CSV file').setInputFiles({ name: 'spend.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Check file' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import ad spend from CSV' });
  await expect(dlg).toContainText('2 of 3 rows are valid');
  await expect(dlg.getByRole('row', { name: /spend/ })).toContainText('is not an amount');
  await dlg.getByLabel(/Import the valid rows/).check();
  await dlg.getByRole('button', { name: 'Import' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('table', { name: /Ad spend rows/ })).toContainText('Spring Sale');

  await page.goto('/ads/performance');
  const row = page.getByRole('row', { name: /Spring Sale/ });
  await expect(row).toContainText('$100.00');
  await expect(row).toContainText(/\d+\.\d+x/); // ROAS from the matched order
  await expect(page.getByRole('region', { name: 'Spend not matched to traffic' })).toContainText('Brand Search');
  await page.getByRole('link', { name: 'Attribution' }).click();
  await expect(page.getByRole('table', { name: /Attribution by/ })).toContainText('facebook');
  expect(funnelId).toBeTruthy();
});
