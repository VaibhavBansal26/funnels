import { expect, test } from '@playwright/test';
import { canvas, createLeadMagnet, openBuilder, register } from './helpers.js';

// AI funnel builder (built-in writer: the suite has no model key), the builder assistant, and the Google reviews block. Nothing here reaches Google or a model.

test('AI funnel builder: describe a business, watch the stages, get a test-status funnel with assumptions, open it', async ({ page }) => {
  await register(page);
  await page.goto('/funnels/new');
  await page.getByRole('button', { name: /Generate with AI/ }).click();
  await page.getByRole('button', { name: 'Build my funnel' }).click();
  await expect(page.getByText('Describe your business in a sentence or two')).toBeVisible();
  await page.getByLabel(/Describe your business/).fill('We run a neighbourhood bakery in Austin. We want local families to request custom birthday cakes. Friendly tone.');
  await page.getByRole('button', { name: 'Build my funnel' }).click();
  const result = page.getByTestId('build-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result.getByText(/Your funnel is ready/)).toBeVisible();
  await expect(result.getByRole('region', { name: 'Assumptions' })).toBeVisible();
  await expect(result.getByRole('region', { name: 'Strategy' })).toContainText('Landing page');
  await expect(result.getByRole('region', { name: 'Checks' })).toContainText('checks passed');
  // a refresh keeps the result (the build lives on the server)
  await page.reload();
  await page.getByRole('button', { name: /Generate with AI/ }).click();
  await expect(page.getByTestId('build-result')).toBeVisible();
  // rewrite one page, then open the funnel
  await page.getByTestId('build-result').getByRole('button', { name: 'Rewrite Landing page' }).click();
  await expect(page.getByText(/rewritten/).first()).toBeVisible();
  await page.getByTestId('build-result').getByRole('button', { name: 'Open the funnel' }).click();
  await expect(page.getByRole('list', { name: 'Funnel steps' })).toBeVisible();
  await expect(page.getByText('test', { exact: false }).first()).toBeVisible();
});

test('builder assistant: preview an AI edit on the canvas, undo it as one step, then keep another', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  await page.getByRole('tab', { name: 'AI assistant' }).click();
  const panel = page.getByTestId('ai-panel');
  await panel.getByLabel('What should change?').fill('add an FAQ about shipping');
  await panel.getByRole('button', { name: /Suggest changes/ }).click();
  const proposal = page.getByTestId('ai-proposal');
  await expect(proposal).toContainText('Suggested by the built-in assistant');
  await expect(proposal.getByRole('list', { name: 'Changes' })).toContainText('Add a section');
  await proposal.getByRole('button', { name: 'Preview on the page' }).click();
  await expect(canvas(page).getByText('What should I know about shipping?')).toBeVisible();
  await proposal.getByRole('button', { name: 'Undo changes' }).click();
  await expect(canvas(page).getByText('What should I know about shipping?')).toHaveCount(0);
  // keep: the edit stays and a single editor undo removes all of it
  await panel.getByLabel('What should change?').fill('add an FAQ about shipping');
  await panel.getByRole('button', { name: /Suggest changes/ }).click();
  await page.getByTestId('ai-proposal').getByRole('button', { name: 'Preview on the page' }).click();
  await page.getByTestId('ai-proposal').getByRole('button', { name: 'Keep changes' }).click();
  await expect(canvas(page).getByText('What should I know about shipping?')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas(page).getByText('What should I know about shipping?')).toHaveCount(0);
  // an instruction the built-in assistant cannot do says so instead of guessing
  await panel.getByLabel('What should change?').fill('translate to Spanish');
  await panel.getByRole('button', { name: /Suggest changes/ }).click();
  await expect(page.getByTestId('ai-proposal')).toContainText('cannot translate');
});

test('Google reviews: settings hide the key, the block appears with the author\'s testimonials, the page stores a reviews endpoint', async ({ page, request }) => {
  await register(page);
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Google reviews' });
  await expect(card).toContainText('No key');
  await card.getByLabel(/Places API key/).fill('AIzaSyD-e2e-0000000000000000000000000');
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(card.getByLabel('Key hint')).toHaveText('…0000');
  await expect(page.locator('body')).not.toContainText('AIzaSyD-e2e');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Google reviews' }).getByLabel('Key hint')).toBeVisible();

  const { funnelId } = await createLeadMagnet(page);
  await openBuilder(page);
  await page.getByLabel('Search blocks').fill('google reviews');
  await page.locator('[data-block="google-reviews"]').click();
  await expect(canvas(page).getByText('Sample reviewer 1')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(/Saved/).first()).toBeVisible();
  const funnel = await (await request.get(`/api/funnels/${funnelId}`, { headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('funnels.token'))}` } })).json();
  const { html } = (await (await request.get(`/api/funnels/${funnelId}/steps/${funnel.steps[0].id}/html`, { headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('funnels.token'))}` } })).json()) as { html: string };
  expect(html).toContain('data-fn-reviews');
  const token = /data-token="(rv[A-Za-z0-9_-]{24})"/.exec(html)![1]!;
  const pub = await request.get(`/public/reviews/${token}`);
  expect(pub.status()).toBe(200);
  expect((await pub.json()).source).toBe('fallback');
  expect(html).not.toMatch(/itemprop|ld\+json|AggregateRating/);
});
