import { expect, test } from '@playwright/test';
import { linkFromMail, register } from './helpers.js';
import { totp } from './totp.js';

test('invite a viewer by email: they accept, sign in with the role, and the UI and the server both hold them to it', async ({ page, browser }) => {
  await register(page, 'Owner Olivia');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Invite member' }).click();
  const email = `viewer${Date.now()}@example.test`;
  await page.getByRole('dialog').getByLabel('Email').fill(email);
  await page.getByRole('dialog').getByLabel('Role').selectOption({ label: 'Viewer' });
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('list', { name: 'Pending invitations' }).getByText(email)).toBeVisible();

  const guest = await browser.newContext({ baseURL: page.url().replace(/\/settings.*/, '') });
  const g = await guest.newPage();
  await g.goto(await linkFromMail(email));
  await expect(g.getByRole('heading', { name: /^Join / })).toBeVisible();
  await expect(g.getByText(email)).toBeVisible();
  await g.getByLabel('Your name').fill('Vera Viewer');
  await g.getByLabel('Choose a password').fill('correct horse battery');
  await g.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(g.getByRole('heading', { name: 'My Funnels' })).toBeVisible();
  await expect(g.getByText('Viewer', { exact: true }).first()).toBeVisible();

  // the interface follows the role...
  await g.goto('/domains');
  await expect(g.getByText('domains:manage')).toBeVisible();
  await expect(g.getByRole('button', { name: 'Add domain' })).toHaveCount(0);
  await g.goto('/settings');
  await expect(g.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
  // ...and the server enforces it even when the UI is bypassed
  const denied = await g.evaluate(async () => {
    const token = localStorage.getItem('funnels.token');
    const r = await fetch('/api/funnels', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'sneaky' }) });
    return { status: r.status, body: (await r.json()) as { error: { message: string } } };
  });
  expect(denied.status).toBe(403);
  expect(denied.body.error.message).toContain('funnels:write');
  await guest.close();

  // the owner sees the new member and the audit trail
  await page.goto('/settings');
  await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Viewer');
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'invitation.accepted' })).toBeVisible();
});

test('custom role: build it with a permission picker, assign it, and it grants exactly those permissions', async ({ page, browser }) => {
  await register(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'New role' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name', { exact: true }).fill('Domain manager');
  await dlg.getByRole('checkbox', { name: /domains:read/ }).check();
  await dlg.getByRole('checkbox', { name: /domains:manage/ }).check();
  await dlg.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByRole('row', { name: /Domain manager/ })).toBeVisible();

  const email = `dm${Date.now()}@example.test`;
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByLabel('Email').fill(email);
  await page.getByRole('dialog').getByLabel('Role').selectOption({ label: 'Domain manager' });
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  const guest = await browser.newContext({ baseURL: page.url().replace(/\/settings.*/, '') });
  const g = await guest.newPage();
  await g.goto(await linkFromMail(email));
  await g.getByLabel('Your name').fill('Dana Domains');
  await g.getByLabel('Choose a password').fill('correct horse battery');
  await g.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(g.getByRole('heading', { name: 'My Funnels' })).toBeVisible();
  await g.goto('/domains');
  await expect(g.getByRole('button', { name: 'Add domain' })).toBeVisible(); // has domains:manage
  await g.goto('/webhooks');
  await expect(g.getByText('webhooks:manage')).toBeVisible(); // does not have webhooks:manage
  await guest.close();
});

test('two-factor authentication: enrol with an authenticator code, sign out, sign in needs the code, a recovery code also works once', async ({ page }) => {
  const u = await register(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await page.getByLabel('Setup key', { exact: true }).textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel('Code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const codesDialog = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await expect(codesDialog).toBeVisible();
  const recovery = (await codesDialog.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allTextContents()).map((t) => t.trim());
  expect(recovery).toHaveLength(10);
  await codesDialog.getByRole('button', { name: 'I saved them' }).click();
  await expect(page.getByText('Two-factor authentication is on', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not correct');
  await page.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000)); // the enrolment step is spent: the next one is fresh
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible(); // back where they were before signing out

  // a recovery code signs in once
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill(recovery[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible(); // back where they were before signing out
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill(recovery[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not correct');
});

test('forgotten password: the emailed link sets a new one, the old one stops working, and sessions elsewhere end', async ({ page, browser }) => {
  const u = await register(page);
  const other = await browser.newContext({ baseURL: page.url().replace(/\/funnels.*/, '') });
  const o = await other.newPage();
  await o.goto('/login');
  await o.getByLabel('Email').fill(u.email);
  await o.getByLabel('Password').fill('correct horse battery');
  await o.getByRole('button', { name: 'Sign in' }).click();
  await expect(o.getByRole('heading', { name: 'My Funnels' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill(u.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();
  await page.goto(await linkFromMail(u.email));
  await page.getByLabel('New password', { exact: true }).fill('a completely new password');
  await page.getByLabel('Repeat the new password').fill('a completely new password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed. Sign in with your new password.')).toBeVisible();

  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await page.getByLabel('Password').fill('a completely new password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Funnels' })).toBeVisible();

  // the other browser's session was ended by the reset: its next request signs it out
  await o.reload();
  await expect(o.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await other.close();
});

test('an expired access token is renewed in the background: the user stays signed in', async ({ page }) => {
  await register(page);
  await page.evaluate(() => localStorage.setItem('funnels.token', 'garbage-that-the-server-rejects')); // what an expired token looks like to the server
  await page.goto('/funnels');
  await expect(page.getByRole('heading', { name: 'My Funnels' })).toBeVisible(); // the 401 triggered a refresh and a retry
  expect(await page.evaluate(() => localStorage.getItem('funnels.token'))).not.toBe('garbage-that-the-server-rejects');
});
