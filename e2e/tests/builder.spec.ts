import { expect, test, type Page } from '@playwright/test';
import { addVerifiedDomain, canvas, createLeadMagnet, dragBlock, goLive, moreAction, openBuilder, readEditor, register, settledBox } from './helpers.js';

// The page builder is GrapesJS rendering the page into an iframe. Every action here is real mouse and keyboard input (drags are mouse down, move, up),
// and the assertions read what the user sees (the canvas, the panels) or what the server stored and published.

const topLevel = (page: Page) => readEditor(page, (ed) => ed.getWrapper().components().map((c: any) => c.getName() + ':' + ((c.find('h1,h2')[0]?.getEl()?.textContent as string) || '').slice(0, 20)));
const iframeBox = async (page: Page) => (await page.locator('iframe.gjs-frame').boundingBox())!;

async function start(page: Page) {
  await register(page);
  await createLeadMagnet(page);
  await openBuilder(page);
}

test('builder: selecting in the canvas fills the inspector; the canvas script is not blocked by any CSP', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await start(page);
  await expect(page.getByText('Select an element')).toBeVisible();
  await canvas(page).locator('h1').first().click();
  await expect(page.getByRole('tablist', { name: 'Inspector' })).toBeVisible();
  expect(await readEditor(page, (ed) => ed.getSelected()?.get('type'))).toBe('fn-heading');
  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p))).toEqual([]);
  // (Playwright's own injected scripts are refused inside the sandboxed preview frames; that message is the test tool, not the app)
  expect(problems.filter((p) => !/Content Security Policy|Refused to|Blocked script execution in 'about:srcdoc'/i.test(p))).toEqual([]);
});

test('builder: a block dragged from the panel lands where it is dropped, with a live placeholder, and undo takes it away', async ({ page }) => {
  await start(page);
  const before = await topLevel(page);
  const tile = page.locator('[data-block="section-faq"]');
  await page.getByLabel('Search blocks').fill('faq');
  const tb = (await tile.first().boundingBox())!;
  const fb = await iframeBox(page);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + 40, tb.y + 20, { steps: 4 });
  await page.mouse.move(fb.x + fb.width / 2, fb.y + 260, { steps: 15 });
  await expect(page.locator('.gjs-placeholder').first()).toBeVisible(); // the live drop indicator is shown while dragging
  await page.mouse.up();
  await expect.poll(async () => (await topLevel(page)).length).toBe(before.length + 1);
  await expect(canvas(page).getByText('Frequently asked questions')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await topLevel(page)).length).toBe(before.length);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => (await topLevel(page)).length).toBe(before.length + 1);
});

test('builder: reorder an element on the canvas with the toolbar move handle', async ({ page }) => {
  await start(page);
  const kids = () => readEditor(page, (ed) => { const h = ed.getWrapper().find('h1')[0]; return h.parent().components().map((c: any) => c.get('type')); });
  const before = await kids();
  expect(before[0]).not.toBe('fn-heading');
  await canvas(page).locator('h1').first().click();
  const handle = page.locator('.gjs-toolbar-item[title="Drag to move"]');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  const fb = await iframeBox(page);
  const target = (await canvas(page).locator('h1').first().locator('xpath=following::p[1]').boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 10, hb.y + 10, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2, { steps: 14 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect.poll(kids).not.toEqual(before);
  expect(fb.width).toBeGreaterThan(300);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(kids).toEqual(before);
});

test('builder: nest a block into a column by dropping it on the column', async ({ page }) => {
  await start(page);
  await readEditor(page, (ed) => ed.Canvas.getFrameEl().contentWindow.scrollTo(0, 99999));
  const fb = await iframeBox(page);
  await dragBlock(page, 'row-2', { x: fb.x + 300, y: fb.y + 480 }, 'columns');
  // the two empty columns of the row that was just added
  const colBoxes = () => readEditor(page, (ed) => {
    const empties = ed.getWrapper().find('.fn-column').filter((c: any) => c.components().length === 0).slice(-2);
    empties[0].getEl().scrollIntoView({ block: 'center' });
    return empties.map((c: any) => { const r = c.getEl().getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  });
  expect((await colBoxes()).length).toBe(2);
  await page.waitForTimeout(300);
  const second = (await colBoxes())[1]!;
  await dragBlock(page, 'button', { x: fb.x + second.x + second.w / 2, y: fb.y + second.y + second.h / 2 }, 'button');
  const content = await readEditor(page, (ed) => {
    const cols = ed.getWrapper().find('.fn-column');
    const row = cols.filter((c: any) => c.components().length === 0 || c.components().at(0).get('type') === 'fn-button').slice(-2);
    return row.map((c: any) => c.components().map((k: any) => k.get('type')).join('+') || 'empty');
  });
  expect(content).toEqual(['empty', 'fn-button']);
});

test('builder: reorder sections by dragging in the Layers panel', async ({ page }) => {
  await start(page);
  await page.getByRole('tab', { name: 'Layers' }).click();
  const before = await topLevel(page);
  expect(before.length).toBeGreaterThan(2);
  const items = page.locator('[role=treeitem][aria-level="1"]');
  const a = (await items.nth(1).boundingBox())!;
  const t = (await items.nth(0).boundingBox())!;
  await page.mouse.move(a.x + 60, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 5, { steps: 5 });
  await page.mouse.move(t.x + 60, t.y + 3, { steps: 10 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect.poll(() => topLevel(page)).toEqual([before[1], before[0], ...before.slice(2)]);
});

test('builder: an image is resized by dragging its handle, and the width is stored as a percentage', async ({ page }) => {
  await start(page);
  await page.getByLabel('Search blocks').fill('image');
  await page.getByLabel(/^Add Image\./).first().click(); // keyboard alternative to dragging: Enter or click inserts after the selection
  await expect.poll(() => readEditor(page, (ed) => ed.getSelected()?.get('type'))).toBe('image');
  const width = () => readEditor(page, (ed) => Math.round(ed.getSelected().getEl().getBoundingClientRect().width));
  const w0 = await width();
  const handle = page.locator('.gjs-resizer-h-cr, .gjs-resizer-h-br').first();
  await expect(handle).toBeVisible();
  const hb = await settledBox(handle); // the canvas scrolls the new image into view smoothly: grab the handle where it has come to rest
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 60, hb.y - 10, { steps: 4 });
  await page.mouse.move(hb.x - 120, hb.y - 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(width).toBeLessThan(w0 - 40);
  const rule = await readEditor(page, (ed) => { const s = ed.getSelected(); return JSON.stringify(ed.Css.getRule('#' + s.getId())?.getStyle() ?? {}); });
  expect(rule).toMatch(/"width":"[\d.]+%"/);
});

test('builder: edit text in place, change a style, switch device, undo and redo, save, reload', async ({ page }) => {
  await start(page);
  const h1 = canvas(page).locator('h1').first();
  await h1.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('A brand new headline');
  await page.getByLabel('Search blocks').click(); // leave the text editor: the edit is committed
  await expect(h1).toHaveText('A brand new headline');
  await expect(page.getByRole('status').filter({ hasText: /Unsaved/ })).toBeVisible();

  // Style: centre the heading through the inspector (the rule goes on this element, the page CSS is untouched)
  await h1.click();
  await page.getByRole('tab', { name: 'Style' }).click();
  await page.getByRole('button', { name: 'Centre' }).click();
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).textAlign)).toBe('center');

  // Device: the canvas really resizes
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect.poll(async () => Math.round((await iframeBox(page)).width)).toBeLessThanOrEqual(400);
  await page.getByRole('button', { name: 'Tablet' }).click();
  await expect.poll(async () => Math.round((await iframeBox(page)).width)).toBe(768);
  await page.getByRole('button', { name: 'Desktop' }).click();

  // Undo / redo with the buttons
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).textAlign)).not.toBe('center');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).textAlign)).toBe('center');

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  await page.reload();
  await page.waitForSelector('[data-builder-ready="1"]');
  await expect(canvas(page).locator('h1').first()).toHaveText('A brand new headline');
  await expect.poll(() => canvas(page).locator('h1').first().evaluate((el) => getComputedStyle(el).textAlign)).toBe('center');
});

test('builder: copy, paste, duplicate and delete with the keyboard; shift-click selects several', async ({ page }) => {
  await start(page);
  const count = () => canvas(page).locator('p').count();
  const n0 = await count();
  await canvas(page).locator('p').first().click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(count).toBe(n0 + 1);
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(count).toBe(n0 + 2);
  await page.keyboard.press('Delete');
  await expect.poll(count).toBe(n0 + 1);
  await canvas(page).locator('h1').first().click();
  await canvas(page).locator('p').first().click({ modifiers: ['Shift'] });
  expect(await readEditor(page, (ed) => ed.getSelectedAll().length)).toBeGreaterThanOrEqual(2); // shift-click selects the range between the two
  await page.keyboard.press('Delete');
  await expect(canvas(page).locator('h1')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(canvas(page).locator('h1')).toHaveCount(1);
});

test('builder: the context menu and the shortcuts dialog open; Escape closes them', async ({ page }) => {
  await start(page);
  await canvas(page).locator('h1').first().click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await moreAction(page, /Keyboard shortcuts/);
  await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('publish: unsafe input is refused or stays text, and the published page equals the editor with no editor chrome', async ({ page, context }) => {
  await start(page);
  // a javascript: address typed into a button is refused by the editor itself: saving is blocked until it is fixed
  await canvas(page).locator('a.fn-btn').first().click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'When clicked' }).click();
  await page.getByRole('option', { name: /Open a web address/ }).click();
  await page.getByLabel('Link address').fill('javascript:alert(document.domain)');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('alert')).toContainText(/Invalid or unsafe URL/);
  await page.getByLabel('Link address').fill('https://example.com/offer');
  // markup typed into text stays text
  const h1 = canvas(page).locator('h1').first();
  await h1.dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('<img src=x onerror=alert(1)> Safe headline');
  await page.getByLabel('Search blocks').click();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();

  const editorText = (await canvas(page).locator('h1').first().innerText()).replace(/\s+/g, ' ').trim();
  const [preview] = await Promise.all([context.waitForEvent('page'), moreAction(page, 'View saved page')]);
  await preview.waitForLoadState();
  expect((await preview.locator('h1').first().innerText()).replace(/\s+/g, ' ').trim()).toBe(editorText);
  const html = await preview.content();
  expect(html).toContain('https://example.com/offer');
  expect(html).not.toMatch(/gjs-|data-gjs|contenteditable|__editor/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/<img[^>]+onerror/i);
  expect(await preview.evaluate(() => [...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))))).toBe(false); // no inline event handler on any element
  // the headline with markup characters is shown as text
  await expect(preview.locator('h1').first()).toContainText('<img src=x onerror=alert(1)> Safe headline');
});

test('publish: a form built in the editor creates a lead for a visitor, and a checkout shows the price the server stored', async ({ page, context }) => {
  const host = `built${Date.now()}.e2e.test`;
  await register(page);
  const { funnelId } = await createLeadMagnet(page);
  await openBuilder(page);
  // add a checkout at the bottom of the page and set its price through the inspector
  await readEditor(page, (ed) => ed.Canvas.getFrameEl().contentWindow.scrollTo(0, 99999));
  const fb = await iframeBox(page);
  await dragBlock(page, 'checkout', { x: fb.x + 300, y: fb.y + 480 }, 'checkout');
  await expect(canvas(page).locator('[data-fn-checkout]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible(); // the dropped block is selected
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Price', { exact: true }).fill('79');
  await page.getByLabel('Product name').fill('Growth plan');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  await page.goto(`/funnels/${funnelId}/steps`);
  await addVerifiedDomain(page, host);
  await goLive(page, funnelId, host);

  const visitor = await context.newPage();
  await visitor.goto(`http://${host}:${new URL(page.url()).port}/free-guide`);
  await expect(visitor.locator('.fn-offer h3')).toHaveText('Growth plan');
  await expect(visitor.locator('.fn-offer .fn-price')).toHaveText('$79.00');
  await visitor.getByLabel('First name').fill('Grace Hopper');
  await visitor.getByLabel('Email address').first().fill('grace@example.com');
  await visitor.getByRole('checkbox').first().check();
  await visitor.getByRole('button', { name: /Send me the (free )?guide/ }).click();
  await expect(visitor.getByRole('heading', { name: 'Check your inbox!' })).toBeVisible();
  await page.goto(`/funnels/${funnelId}/leads`);
  await expect(page.getByText('grace@example.com').first()).toBeVisible();
});

test('builder: Save keeps the replaced version; History lists it and Restore brings it back', async ({ page }) => {
  await start(page);
  const heading = () => canvas(page).locator('h1').first();
  const original = (await heading().innerText()).trim();
  await heading().dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Version two headline');
  await page.getByLabel('Search blocks').click();
  await page.keyboard.press('ControlOrMeta+s'); // explicit save: autosave would not keep a history entry
  await expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();
  await moreAction(page, 'Version history');
  const drawer = page.getByRole('dialog', { name: /history/i });
  await expect(drawer.getByRole('listitem')).toHaveCount(1);
  await drawer.getByRole('button', { name: /^Preview/ }).click();
  await expect(drawer.locator('iframe')).toBeVisible();
  await drawer.getByRole('button', { name: /^Restore/ }).click();
  await expect(heading()).toHaveText(original);
});

test('builder: layout adapts, panels become drawers at tablet width and preview hides the tools', async ({ page }) => {
  await start(page);
  await page.setViewportSize({ width: 1024, height: 768 }); // tablet: blocks stay inline, the inspector is a drawer
  await expect(page.getByLabel('Search blocks')).toBeVisible();
  await page.getByRole('button', { name: 'Open style and settings' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.setViewportSize({ width: 700, height: 900 }); // small: both panels are drawers
  await expect(page.getByRole('button', { name: 'Open blocks, layers and pages' })).toBeVisible();
  await page.getByRole('button', { name: 'Open blocks, layers and pages' }).click();
  await expect(page.getByLabel('Search blocks')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Preview/ }).first().click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await page.getByRole('button', { name: /Edit/ }).first().click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
});
