import { expect, test } from '@playwright/test';
import { register } from './helpers.js';

test('Settings shows plan, usage and payment status; an order from a sales funnel can be partly refunded from the Orders tab', async ({ page }) => {
  await register(page);

  await page.goto('/settings');
  const billing = page.getByRole('region', { name: 'Billing' });
  await expect(billing).toContainText('Plan: Free');
  await expect(billing.getByRole('row', { name: /Funnels\s+0\s+3/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payments' })).toContainText('test mode');

  // A sales funnel from a template, and a purchase through the public checkout endpoint (the mock payment provider, as in development).
  const made = await page.evaluate(async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const f = await (await fetch('/api/templates/sales-page-bump-upsell/use', { method: 'POST', headers: h })).json();
    const step = f.steps[0];
    const doc = (await (await fetch(`/api/funnels/${f.id}/steps/${step.id}/page`, { headers: h })).json()).doc;
    const found: { id: string; type: string; orderBump?: boolean; oneClickUpsell?: boolean }[] = doc.products; // derived by the server from the page's checkout blocks
    const main = found.find((b) => b.type === 'checkout' && !b.orderBump && !b.oneClickUpsell)!;
    const r = await fetch(`/api/public/checkout/${f.id}/${step.id}/${main.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'buyer@example.com', name: 'Bea Buyer' }) });
    return { funnelId: f.id as string, status: r.status };
  });
  expect(made.status).toBe(200);

  await page.goto(`/funnels/${made.funnelId}/orders`);
  const row = page.getByRole('row', { name: /buyer@example\.com/ });
  await expect(row).toContainText('Paid');
  await row.getByRole('button', { name: 'Refund' }).click();
  const dlg = page.getByRole('dialog', { name: 'Refund order' });
  await dlg.getByLabel(/Amount/).fill('1.00');
  await dlg.getByRole('button', { name: /^Refund/ }).click();
  await expect(dlg).toBeHidden();
  await expect(row).toContainText('Refunded');
  await expect(row).toContainText('$1.00');
  // the audit log recorded it
  await page.goto('/audit');
  await expect(page.getByRole('main')).toContainText('order.refunded');
});
