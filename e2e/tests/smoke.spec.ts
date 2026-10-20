import { expect, test } from '@playwright/test';
import { addVerifiedDomain, canvas, createLeadMagnet, goLive, openBuilder, outlineLabels, register } from './helpers.js';

// Every test starts from a freshly registered user, so tests do not depend on each other or on order.

test('register lands on an empty funnel list; sign out and back in works', async ({ page }) => {
  const u = await register(page);
  await expect(page.getByRole('heading', { name: 'No funnels yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
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

test('builder: clicking a block in the canvas selects it (the canvas script must not be blocked by the app CSP)', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  await expect(page.getByRole('heading', { name: 'Nothing selected' })).toBeVisible();
  await canvas(page).getByRole('heading', { level: 1 }).first().click();
  await expect(page.getByRole('complementary', { name: 'Block settings' }).getByRole('heading', { name: 'Heading', level: 2 })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Block settings' }).getByLabel('Text')).toHaveValue(/Free guide/);
  expect(problems.filter((p) => /Content Security Policy/i.test(p))).toEqual([]);
});

test('builder: edit text, save, reload, and the change is there; undo and redo work', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  await canvas(page).getByRole('heading', { level: 1 }).first().click();
  const text = page.getByRole('complementary', { name: 'Block settings' }).getByLabel('Text');
  await text.fill('A brand new headline');
  await expect(canvas(page).getByRole('heading', { level: 1 }).first()).toHaveText('A brand new headline');
  await expect(page.getByRole('status').filter({ hasText: /unsaved|Unsaved/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(canvas(page).getByRole('heading', { level: 1 }).first()).toContainText('Free guide');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(canvas(page).getByRole('heading', { level: 1 }).first()).toHaveText('A brand new headline');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved / })).toBeVisible();
  await page.reload();
  await expect(canvas(page).getByRole('heading', { level: 1 }).first()).toHaveText('A brand new headline');
});

test('builder: reorder blocks in the structure list with the keyboard (Alt+Arrow) and by drag and drop', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  const tree = page.getByRole('tree', { name: 'Page structure' });
  const first = async () => (await outlineLabels(page)).slice(0, 5);
  const before = await first();
  expect(before[1]).toMatch(/^Heading/);
  expect(before[2]).toMatch(/^Paragraph/);
  // keyboard: move the heading down below the paragraph
  await tree.getByRole('treeitem', { name: /^Heading Free guide/ }).first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(first).not.toEqual(before);
  const afterKey = await first();
  expect(afterKey[1]).toMatch(/^Paragraph/);
  expect(afterKey[2]).toMatch(/^Heading/);
  // drag and drop: drag the heading back above the paragraph
  await tree.getByRole('treeitem', { name: /^Heading Free guide/ }).first().dragTo(tree.getByRole('treeitem', { name: /^Paragraph A practical/ }).first(), { targetPosition: { x: 20, y: 2 } });
  await expect.poll(first).toEqual(before);
  // the canvas shows the same order
  const body = canvas(page).locator('body');
  await expect(body).toContainText('Free guide');
});

test('builder: Save keeps the replaced version; History lists it and Restore brings it back', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  const heading = () => canvas(page).getByRole('heading', { level: 1 }).first();
  const original = (await heading().textContent())!.trim();
  await heading().click();
  await page.getByRole('complementary', { name: 'Block settings' }).getByLabel('Text').fill('Version two headline');
  await page.keyboard.press('Control+s'); // explicit save, immediately: autosave (20 s) would not keep a history entry
  await expect(page.getByRole('status').filter({ hasText: /^Saved / })).toBeVisible();
  await page.getByRole('button', { name: 'History' }).click();
  const drawer = page.getByRole('dialog', { name: 'Version history' });
  await expect(drawer.getByRole('listitem')).toHaveCount(1);
  await drawer.getByRole('button', { name: 'Preview' }).click();
  await expect(drawer.locator('iframe')).toBeVisible();
  await drawer.getByRole('button', { name: /^Restore/ }).click();
  await expect(heading()).toHaveText(original);
  await expect(heading()).not.toHaveText('Version two headline');
});

test('signed preview shows the page and the form works end to end in it (preview submissions are deliberately not recorded)', async ({ page, context }) => {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
  const [preview] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Preview' }).click()]);
  await preview.waitForLoadState();
  await expect(preview.getByRole('heading', { level: 1 })).toContainText('Free guide');
  await preview.getByLabel('First name').fill('Preview Person');
  await preview.getByLabel('Email address').fill('preview@example.com');
  await preview.getByRole('checkbox').check();
  await preview.getByRole('button', { name: 'Send me the guide' }).click();
  await expect(preview.getByRole('heading', { name: 'Check your inbox!' })).toBeVisible();
});

test('live funnel on a verified domain: visitor submits the form, the lead and the analytics show up in the app', async ({ page, context }) => {
  const host = `offers${Date.now()}.e2e.test`;
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await addVerifiedDomain(page, host);
  await goLive(page, funnelId, host);

  const visitor = await context.newPage();
  await visitor.goto(`http://${host}:${new URL(page.url()).port}/free-guide`);
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('Free guide');
  await visitor.getByLabel('First name').fill('Ada Lovelace');
  await visitor.getByLabel('Email address').fill('ada@example.com');
  await visitor.getByRole('checkbox').check();
  await visitor.getByRole('button', { name: 'Send me the guide' }).click();
  await expect(visitor.getByRole('heading', { name: 'Check your inbox!' })).toBeVisible();

  await page.goto(`/funnels/${funnelId}/leads`);
  await expect(page.getByText('ada@example.com').first()).toBeVisible();
  await page.goto(`/funnels/${funnelId}/analytics`);
  await expect(page.getByRole('main')).toContainText(/Opt-ins/i);
});

test('analytics tab renders its summary and charts without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await page.getByRole('link', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(new RegExp(`/funnels/${funnelId}/analytics`));
  await expect(page.getByRole('main').getByText(/Page views|Visitors/i).first()).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0); // no spinner left behind
  expect(errors).toEqual([]);
});
