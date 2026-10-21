import { expect, test, type Page } from '@playwright/test';
import { canvas, createLeadMagnet, openBuilder, register } from './helpers.js';

// The builder's Publish dialog: save, choose an address, go live, update the live page, take it offline. Real clicks and typing; the page is opened in a real browser tab.

async function setHeading(page: Page, text: string) {
  await canvas(page).locator('h1').first().dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.getByLabel('Search blocks').click(); // leave the text editing
}
const publish = (page: Page) => page.getByRole('button', { name: 'Publish', exact: true }).click();

test('publish from the builder: go live on the built-in address, open it, change the page, update the live page, take it offline', async ({ page, context }) => {
  test.setTimeout(90_000);
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);

  // 1. an unsaved change is saved first, then the free built-in address is preselected with its real URL
  await setHeading(page, 'Publish me first');
  await publish(page);
  const dlg = page.getByRole('dialog', { name: 'Publish' });
  await expect(dlg.getByText('Test mode is private to you; live is public.')).toBeVisible();
  await dlg.getByText('Test vs live', { exact: true }).click(); // the long explanation is behind a disclosure
  await expect(dlg.getByText(/In test mode only people with your preview link/)).toBeVisible();
  await expect(dlg.getByText('Everything is saved.')).toBeVisible();
  await expect(dlg.getByRole('radio', { name: /Built-in address \(free\)/ })).toBeChecked();
  await expect(dlg.getByTestId('final-url')).toContainText('/s/');
  await expect(dlg).not.toContainText(/connect a domain/i);

  // 2. one step: Go live, the URL is shown with Copy and Open
  await dlg.getByRole('button', { name: 'Go live' }).click();
  await expect(dlg.getByText('Your funnel is live.')).toBeVisible();
  await expect(dlg.getByText('Live', { exact: true })).toBeVisible();
  const url = (await dlg.getByTestId('final-url').textContent())!;
  expect(new URL(url).pathname).toMatch(/^\/s\/[a-z0-9-]+\/lead-magnet\/free-guide$/);
  await expect(dlg.getByRole('button', { name: /Copy link/ })).toBeVisible();
  const [tab] = await Promise.all([context.waitForEvent('page'), dlg.getByRole('link', { name: /Open/ }).click()]);
  await expect(tab.locator('h1').first()).toContainText('Publish me first');
  await tab.close();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();

  // 3. change the page; the dialog now offers to update the live page
  await setHeading(page, 'Second version');
  await publish(page);
  const dlg2 = page.getByRole('dialog'); // its title changes with the state
  await expect(dlg2.getByText('Everything is saved.')).toBeVisible();
  await expect(dlg2.locator('strong', { hasText: 'Built-in address (free)' })).toBeVisible();
  await dlg2.getByRole('button', { name: 'Update live page' }).click();
  await expect(dlg2.getByText('Saved. The live page is updated.')).toBeVisible();
  const visitor = await context.newPage();
  await visitor.goto(url);
  await expect(visitor.locator('h1').first()).toContainText('Second version');

  // 4. take it offline: the address stops answering
  await dlg2.getByRole('button', { name: 'Take offline' }).click();
  await expect(dlg2.getByText('The funnel is offline again (test mode).')).toBeVisible();
  const gone = await visitor.goto(url);
  expect(gone!.status()).toBe(404);
  await expect(dlg2.getByText('Test mode', { exact: true })).toBeVisible();
  await expect(dlg2.getByRole('button', { name: 'Go live' })).toBeEnabled();
});

test('publish dialog without a Cloudflare connection: the Pages option says what is missing and links to Settings', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  await publish(page);
  const dlg = page.getByRole('dialog', { name: 'Publish' });
  await expect(dlg.getByRole('radio', { name: /Cloudflare Pages address/ })).toBeDisabled();
  await expect(dlg.getByText('Connect Cloudflare first.')).toBeVisible();
  await expect(dlg.getByText(/Cloudflare Pages: Edit/)).toBeVisible();
  await expect(dlg.getByText('Experimental').first()).toBeVisible();
  const link = dlg.getByRole('link', { name: /Settings, Publishing card/ });
  await expect(link).toHaveAttribute('href', '/settings');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(dlg.getByRole('radio', { name: /Built-in address/ })).toBeChecked();
  await expect(dlg.getByRole('button', { name: 'Go live' })).toBeEnabled();
  // keyboard: Escape closes and the focus returns to the Publish button
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused();
});
