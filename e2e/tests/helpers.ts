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
  await page.getByRole('article', { name: 'Lead magnet' }).getByRole('button', { name: 'Use template' }).click();
  await expect(page.getByRole('heading', { name: 'Lead magnet', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Funnel steps' })).toBeVisible();
  const funnelId = /\/funnels\/(fn_[^/]+)/.exec(page.url())![1]!;
  return { funnelId };
}

/** Opens the builder for the first step of the current funnel and waits until the canvas has rendered. */
export async function openBuilder(page: Page) {
  await page.getByRole('link', { name: 'Edit page' }).first().click();
  await expect(page.getByRole('toolbar', { name: 'Builder' })).toBeVisible();
  await expect(canvas(page).getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export const canvas = (page: Page) => page.frameLocator('iframe[title^="Live preview"]');

/** Texts of the top-level children of the first section in the Structure tree, in order. */
export async function outlineLabels(page: Page): Promise<string[]> {
  return page.getByRole('tree', { name: 'Page structure' }).getByRole('treeitem').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').replace(/^[\s⋮]+/, '').trim()));
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
