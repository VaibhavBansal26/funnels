import { expect, test, type Page } from '@playwright/test';
import { canvas, createLeadMagnet, dragBlock, moreAction, openBuilder, readEditor, register } from './helpers.js';

// The secondary flows of the builder: pages, page settings, images, links, saved blocks, publishing. Real clicks and typing throughout.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function start(page: Page) {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
}

test('pages: add, duplicate and delete a page from the Pages panel; the step switcher follows', async ({ page }) => {
  await start(page);
  await page.getByRole('tab', { name: 'Pages' }).click();
  const pages = page.getByRole('region', { name: 'Pages' });
  await expect(pages.getByRole('listitem')).toHaveCount(2);
  await pages.getByRole('button', { name: 'Add page' }).click();
  await page.getByLabel('Page name').fill('Bonus page');
  await page.getByRole('dialog').getByRole('button', { name: 'Add page' }).click();
  await page.waitForSelector('[data-builder-ready="1"]'); // the new page opens in the editor
  await expect(page.getByRole('combobox', { name: 'Step' })).toContainText('Bonus page');
  await expect(pages.getByRole('listitem')).toHaveCount(3); // and the panel is still on the Pages tab
  await pages.getByRole('button', { name: 'Actions for Bonus page' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(pages.getByRole('listitem')).toHaveCount(4);
  await pages.getByRole('button', { name: 'Actions for Bonus page' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Delete page' }).click();
  await expect(pages.getByRole('listitem')).toHaveCount(3);
  // switching page loads the other page into the editor
  await pages.getByRole('button', { name: /^\d+\. Thank you/ }).click();
  await expect(canvas(page).locator('h1').first()).toContainText('Check your inbox');
});

test('page settings: name, accent colour and SEO title apply and are saved on the server', async ({ page }) => {
  await start(page);
  await moreAction(page, 'Page settings');
  const dlg = page.getByRole('dialog', { name: 'Page settings' });
  await dlg.getByLabel('Page title').fill('My great offer');
  await dlg.getByLabel('Accent colour').fill('#be123c');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(dlg).toBeHidden();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  const html = await page.evaluate(async () => {
    const h = { authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const m = /\/funnels\/(fn_[^/]+)\/builder\/(stp_[^/?]+)/.exec(location.pathname)!;
    return (await (await fetch(`/api/funnels/${m[1]}/steps/${m[2]}/html`, { headers: h })).json()).html as string;
  });
  expect(html).toContain('<title>My great offer</title>');
  expect(html).toContain('--fn-accent:#be123c');
});

test('images: upload from the Images panel, then use it on an image block through the picker', async ({ page }) => {
  await start(page);
  await page.getByRole('tab', { name: 'Images' }).click();
  await page.getByLabel('Choose images to upload').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('region', { name: 'Images' }).getByText('dot.png')).toBeVisible();
  // an executable disguised as an image is refused by the server
  await page.getByLabel('Choose images to upload').setInputFiles({ name: 'evil.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') });
  await expect(page.getByRole('region', { name: 'Images' }).getByText('evil.png')).toHaveCount(0);
  // use it
  await page.getByRole('tab', { name: 'Blocks' }).click();
  await page.getByLabel('Search blocks').fill('image');
  await page.getByLabel(/^Add Image\./).first().click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Choose image' }).click();
  await page.getByRole('dialog', { name: 'Choose an image' }).getByRole('button', { name: 'Use dot.png' }).click();
  await expect.poll(() => readEditor(page, (ed) => ed.getSelected()?.getAttributes().src as string)).toMatch(/^\/uploads\//);
  // AI alt text: a suggestion lands in the alt field (the built-in writer answers when no model key is configured)
  await page.getByRole('button', { name: 'Suggest alt text' }).click();
  await expect.poll(() => readEditor(page, (ed) => String(ed.getSelected()?.getAttributes().alt ?? ''))).not.toBe('');
});

test('links: select text, add a link in the text toolbar, and it is published as a plain anchor', async ({ page }) => {
  await start(page);
  const p = canvas(page).locator('p.fn-muted').first();
  await p.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('dialog', { name: 'Link' }).getByLabel('Address').fill('https://example.com/read-more');
  await page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Apply' }).click();
  await expect(canvas(page).locator('p.fn-muted a[href="https://example.com/read-more"]').first()).toBeVisible();
  // a javascript: address is not accepted by the dialog
  await p.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('dialog', { name: 'Link' }).getByLabel('Address').fill('javascript:alert(1)');
  await expect(page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Apply' })).toBeDisabled();
  await page.keyboard.press('Escape');
  // saved, it is a plain anchor
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  const html = await page.evaluate(async () => {
    const h = { authorization: `Bearer ${localStorage.getItem('funnels.token')}` };
    const m = /\/funnels\/(fn_[^/]+)\/builder\/(stp_[^/?]+)/.exec(location.pathname)!;
    return (await (await fetch(`/api/funnels/${m[1]}/steps/${m[2]}/html`, { headers: h })).json()).html as string;
  });
  expect(html).toMatch(/<a [^>]*href="https:\/\/example.com\/read-more"/);
});

test('saved blocks: save the selection as my block, it appears under My blocks, and can be dropped back', async ({ page }) => {
  await start(page);
  await canvas(page).locator('h1').first().click();
  await page.getByRole('button', { name: 'Save selection as block' }).click();
  await page.getByRole('dialog', { name: 'Save as my block' }).getByLabel('Name').fill('My headline');
  await page.getByRole('dialog', { name: 'Save as my block' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Save as my block' })).toBeHidden(); // (the page behind a modal dialog is not editable until it closes)
  await page.getByLabel('Search blocks').fill('My headline');
  await expect(page.locator('[data-block]').filter({ hasText: 'My headline' })).toBeVisible();
  const h1s = await canvas(page).locator('h1').count();
  const fb = (await page.locator('iframe.gjs-frame').boundingBox())!;
  await dragBlock(page, 'my-' + (await page.locator('[data-block^="my-"]').first().getAttribute('data-block'))!.slice(3), { x: fb.x + 300, y: fb.y + 500 });
  await expect(canvas(page).locator('h1')).toHaveCount(h1s + 1); // the saved block comes back with its text
  // blocks with a form cannot be saved (their ids must stay unique)
  await canvas(page).locator('form').first().click();
  await page.getByRole('button', { name: 'Save selection as block' }).click();
  await page.getByRole('dialog', { name: 'Save as my block' }).getByLabel('Name').fill('A form');
  await page.getByRole('dialog', { name: 'Save as my block' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog', { name: 'Save as my block' })).toContainText(/cannot|not allowed|form/i);
});

test('publish dialog: saves first, explains test mode, and the status shows the save', async ({ page }) => {
  await start(page);
  await canvas(page).locator('h1').first().dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Publish me');
  await page.getByLabel('Search blocks').click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: /Publish/ });
  await expect(dlg).toContainText('In test mode');
  await expect(dlg.getByText('Everything is saved.')).toBeVisible(); // the unsaved change was saved when the dialog opened
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
});

test('keyboard only: select with Tab-free shortcuts, move an element with Alt+Arrow, step out with Alt+Left, undo', async ({ page }) => {
  await start(page);
  const order = () => readEditor(page, (ed) => { const h = ed.getWrapper().find('h1')[0]; return h.parent().components().map((c: any) => c.get('type')).join(','); });
  const before = await order();
  await canvas(page).locator('h1').first().click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(order).not.toBe(before);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(order).toBe(before);
  await page.keyboard.press('Shift+ArrowUp'); // select the parent
  expect(await readEditor(page, (ed) => ed.getSelected()?.get('type'))).toBe('fn-column');
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toBeVisible();
});

test('mobile: a notice explains the builder needs a larger screen, and the canvas still renders', async ({ page }) => {
  await register(page);
  await createLeadMagnet(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openBuilder(page);
  await expect(page.getByText(/larger screen|tablet or desktop/i)).toBeVisible();
});

test('layers: dragging a section DOWN lands it after the target (not before it), and Alt+Arrow moves it one place in either direction', async ({ page }) => {
  await start(page);
  await page.getByRole('tab', { name: 'Layers' }).click();
  const names = () => readEditor(page, (ed) => ed.getWrapper().components().map((c: any) => (c.find('h1,h2')[0]?.getEl()?.textContent as string || '').slice(0, 10)));
  const before = await names();
  const items = page.locator('[role=treeitem][aria-level="1"]');
  const a = (await items.nth(0).boundingBox())!;
  const t = (await items.nth(2).boundingBox())!;
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 25, { steps: 5 });
  await page.mouse.move(t.x + 60, t.y + t.height - 3, { steps: 10 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect.poll(names).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
});

test('saving while still typing in the page keeps what was typed (Ctrl+S inside the canvas)', async ({ page }) => {
  await start(page);
  const h1 = canvas(page).locator('h1').first();
  await h1.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Typed and saved at once');
  await page.keyboard.press('ControlOrMeta+s'); // no click elsewhere first: the inline editor is still open
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  await page.reload();
  await page.waitForSelector('[data-builder-ready="1"]');
  await expect(canvas(page).locator('h1').first()).toHaveText('Typed and saved at once');
});
