import { expect, test } from '@playwright/test';
import { register } from './helpers.js';

test('API access: create a key (shown once), use it against the analytics API, see the identity pepper, revoke the key', async ({ page, request }) => {
  await register(page);
  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'API access' });
  await section.getByRole('button', { name: 'New API key' }).click();
  const dlg = page.getByRole('dialog', { name: 'New API key' });
  await dlg.getByLabel('Name').fill('Intelligence service');
  await dlg.getByRole('checkbox', { name: /Export/ }).check();
  await dlg.getByRole('button', { name: 'Create key' }).click();
  const secret = (await page.getByLabel('API key', { exact: true }).textContent())!.trim();
  expect(secret).toMatch(/^fa_live_[\w-]{32}$/);
  await page.getByRole('button', { name: 'I copied it' }).click();

  // the key works against the API, with and without the export scope
  const auth = { authorization: `Bearer ${secret}` };
  const funnels = await request.get('/api/v1/analytics/funnels', { headers: auth });
  expect(funnels.status()).toBe(200);
  expect(await funnels.json()).toEqual({ data: [], next_cursor: null });
  expect((await request.get('/api/v1/analytics/export/events', { headers: auth })).status()).toBe(200);
  expect((await request.get('/api/v1/analytics/funnels')).status()).toBe(401);

  // the list shows the prefix and that it was used, never the secret
  await page.reload();
  const item = page.getByRole('list', { name: 'API keys' }).getByRole('listitem').filter({ hasText: 'Intelligence service' });
  await expect(item).toContainText(secret.slice(0, 12));
  await expect(item).toContainText('used');
  await expect(item).not.toContainText(secret);

  // the identity pepper is hidden until asked for
  await expect(page.getByLabel('Identity pepper')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show the pepper' }).click();
  const pepper = (await page.getByLabel('Identity pepper').textContent())!.trim();
  expect(pepper).toMatch(/^[0-9a-f]{64}$/);
  await page.getByRole('button', { name: 'Rotate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rotate' }).click();
  await expect(page.getByLabel('Identity pepper')).not.toHaveText(pepper);

  // revoking stops the key at once
  await item.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(item).toHaveCount(0);
  expect((await request.get('/api/v1/analytics/funnels', { headers: auth })).status()).toBe(401);
});
