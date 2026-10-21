import { expect, type Page } from '@playwright/test';

let counter = 0;

/** Registers a fresh user (unique email) through the UI and waits for the funnels list. */
export async function register(page: Page, name = 'E2E Owner', fixedEmail?: string) {
  const email = fixedEmail ?? `e2e${Date.now()}${++counter}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My Funnels' })).toBeVisible();
  return { email, name };
}

/** New funnel from the "Lead magnet" template (2 steps: landing page with an opt-in form, thank-you). Ends on the funnel's Steps tab. */
export async function createLeadMagnet(page: Page) {
  await page.goto('/funnels/new');
  await page.getByRole('button', { name: /From a template/ }).click();
  await page.getByRole('article', { name: 'Lead magnet', exact: true }).getByRole('button', { name: 'Use template Lead magnet', exact: true }).click();
  await page.getByRole('dialog', { name: 'Use "Lead magnet"' }).getByRole('button', { name: 'Create funnel' }).click(); // the use-template wizard
  await expect(page.getByRole('heading', { name: 'Lead magnet', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Funnel steps' })).toBeVisible();
  const funnelId = /\/funnels\/(fn_[^/]+)/.exec(page.url())![1]!;
  return { funnelId };
}

/** Opens the builder for the first step of the current funnel and waits until the editor and the canvas are ready. */
export async function openBuilder(page: Page) {
  await page.getByRole('link', { name: 'Edit page' }).first().click();
  await page.waitForSelector('[data-builder-ready="1"]');
  await expect(page.getByRole('toolbar', { name: 'Builder' })).toBeVisible();
  await expect(canvas(page).locator('h1').first()).toBeVisible();
}

/** The editing canvas: GrapesJS renders the page into this iframe. */
export const canvas = (page: Page) => page.frameLocator('iframe.gjs-frame');

/** The editor instance, for READING state in assertions (every action in the tests goes through real mouse and keyboard input). */
export const readEditor = <T>(page: Page, fn: (ed: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__editor)`) as Promise<T>;

/** Names of the top-level sections in the Layers tree, in order. */
export async function layerLabels(page: Page): Promise<string[]> {
  return page.getByRole('tree', { name: 'Page layers' }).getByRole('treeitem').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()));
}

/** Real-mouse drag of a block tile from the Blocks panel to a point inside the canvas (page coordinates), with the live placeholder in between. */
export async function dragBlock(page: Page, blockId: string, to: { x: number; y: number }, search = '') {
  if (search) await page.getByLabel('Search blocks').fill(search);
  const tile = page.locator(`[data-block="${blockId}"]`);
  // only the first category is expanded by default: open collapsed ones until the tile exists
  for (const header of await page.locator('[role="region"][aria-label="Blocks"] button[aria-expanded="false"]').all()) {
    if (await tile.count()) break;
    await header.click();
  }
  await tile.scrollIntoViewIfNeeded();
  const tb = (await tile.boundingBox())!;
  // The very first synthesised drag after the editor loads is ignored when the pointer has never been over the canvas (the second one always works);
  // a person's pointer has always crossed it. Move over it once before pressing, as a user would.
  const frame = (await page.locator('iframe.gjs-frame').boundingBox())!;
  await page.mouse.move(frame.x + frame.width / 2, frame.y + 40);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 30, tb.y + 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 18 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** Adds a domain on the Domains page and verifies it (the e2e server answers DNS for *.e2e.test). */
export async function addVerifiedDomain(page: Page, hostname: string) {
  await page.goto('/domains');
  await page.getByRole('button', { name: 'Add domain' }).first().click();
  await page.getByLabel('Hostname').fill(hostname);
  await page.getByRole('dialog').getByRole('button', { name: 'Add domain' }).click();
  await page.getByRole('article', { name: hostname }).getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('article', { name: hostname }).getByText('✓ TXT ownership record found')).toBeVisible();
}

/** Connects the funnel to a verified domain and sets it live (Settings tab). */
export async function goLive(page: Page, funnelId: string, hostname: string) {
  await page.goto(`/funnels/${funnelId}/settings`);
  await page.getByLabel('Status').selectOption('live');
  await page.getByLabel('Domain', { exact: true }).selectOption({ label: hostname });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(hostname).first()).toBeVisible();
}

/** The last mail the e2e server "sent" to `to` (see server.mjs), and the first link in it. */
export async function linkFromMail(to: string): Promise<string> {
  const port = Number(process.env.E2E_PORT ?? 4180) + 1;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/mail?to=${encodeURIComponent(to)}`);
    if (res.ok) return ((await res.json()) as { text: string }).text.match(/https?:\/\/\S+/)![0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail arrived for ${to}`);
}

/** Signs the current user out through the account menu. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

/** The bounding box of an element once it has stopped moving (the canvas scrolls smoothly to a newly inserted block, and a drag must start where the handle really is). */
export async function settledBox(locator: import('@playwright/test').Locator) {
  let last = (await locator.boundingBox())!;
  for (let i = 0; i < 40; i++) {
    await locator.page().waitForTimeout(150);
    const now = (await locator.boundingBox())!;
    if (now && last && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5) return now;
    last = now;
  }
  return last;
}

/** Picks an action from the builder top bar's "More actions" menu (view saved page, version history, page settings, add payments, keyboard shortcuts). */
export async function moreAction(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}
