import { expect, test } from '@playwright/test';
import { register } from './helpers.js';
import { totp } from './totp.js';

// Two browser contexts: the platform administrator (listed in PLATFORM_ADMIN_EMAILS for this server, NODE_ENV=production so two-factor is required)
// and a customer. Each run uses a fresh customer, so the tests do not depend on each other.
test('admin: two-factor is required, then suspend a workspace (the customer is locked out and told why), unsuspend, announce, act as the owner', async ({ browser }) => {
  const customerCtx = await browser.newContext();
  const customer = await customerCtx.newPage();
  const stamp = Date.now();
  const customerEmail = `cora${stamp}@example.test`;
  await register(customer, `Cora${stamp}`, customerEmail);
  await customer.goto('/settings');
  await expect(customer.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' })).toHaveCount(0); // not an administrator: no link
  await customer.goto('/admin');
  await expect(customer.getByText('This area is for platform administrators.')).toBeVisible();

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const adminEmail = 'admin@e2e.test';
  await admin.goto('/register');
  await admin.getByLabel('Your name').fill('Platform Admin');
  await admin.getByLabel('Email').fill(adminEmail);
  await admin.getByLabel('Password').fill('correct horse battery');
  await admin.getByRole('button', { name: 'Create account' }).click();
  await expect(admin.getByRole('heading', { name: 'My Funnels' })).toBeVisible();

  // mandatory two-factor: the admin area asks for it first
  await admin.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' }).click();
  await expect(admin.getByRole('alert')).toContainText('Two-factor authentication is required');
  await admin.getByRole('link', { name: 'Turn it on in Settings' }).click();
  await admin.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await admin.getByLabel('Setup key', { exact: true }).textContent())!.trim();
  await admin.getByLabel('Code from the app').fill(totp(secret));
  await admin.getByRole('button', { name: 'Turn on' }).click();
  await admin.getByRole('dialog', { name: 'Save your recovery codes' }).getByRole('button', { name: 'I saved them' }).click();
  await admin.goto('/admin');
  await expect(admin.getByRole('heading', { name: 'Admin', level: 1 })).toBeVisible();
  await expect(admin.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();

  // find the customer's workspace by member email, suspend it with a reason
  await admin.getByLabel('Search').fill(customerEmail);
  const row = admin.getByRole('row', { name: new RegExp(customerEmail) });
  await expect(row).toBeVisible();
  await row.getByRole('button').click();
  const detail = admin.getByRole('dialog');
  await expect(detail).toContainText('Active');
  await detail.getByRole('button', { name: 'Suspend' }).click();
  const reason = admin.getByRole('dialog', { name: 'Suspend workspace' });
  const confirm = reason.getByRole('button', { name: 'Suspend', exact: true });
  await expect(confirm).toBeDisabled(); // a reason is required
  await reason.getByLabel(/Reason/).fill('Chargeback fraud, ticket 77');
  await confirm.click();
  await expect(admin.getByRole('dialog').getByText('Suspended: Chargeback fraud, ticket 77')).toBeVisible();
  await admin.keyboard.press('Escape');

  // the customer's session was ended; signing in shows the suspension and nothing else
  await customer.reload();
  await customer.getByLabel('Email').fill(customerEmail);
  await customer.getByLabel('Password').fill('correct horse battery');
  await customer.getByRole('button', { name: 'Sign in' }).click();
  await expect(customer.getByRole('alert')).toContainText('This account is suspended');
  await expect(customer.getByRole('alert')).toContainText('Chargeback fraud, ticket 77');
  await expect(customer.getByRole('heading', { name: 'My Funnels' })).toHaveCount(0);

  // unsuspend: the same browser works again after a reload
  await admin.getByRole('row', { name: new RegExp(customerEmail) }).getByRole('button').click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Unsuspend' }).click();
  await expect(admin.getByRole('dialog').getByText('Active', { exact: true })).toBeVisible();
  await admin.keyboard.press('Escape');
  await customer.goto('/funnels');
  await expect(customer.getByRole('heading', { name: 'My Funnels' })).toBeVisible();

  // error monitoring is optional: off on this server (no SENTRY_DSN), and the page says how to turn it on
  await admin.getByRole('link', { name: 'Monitoring' }).click();
  await expect(admin.getByRole('region', { name: 'Error monitoring' })).toContainText('Monitoring is not configured');
  await expect(admin.getByRole('button', { name: 'Send test error' })).toBeDisabled();

  // an announcement reaches the customer and can be dismissed
  await admin.getByRole('link', { name: 'Announcements' }).click();
  await admin.getByLabel('Title').fill('Planned maintenance');
  await admin.getByLabel('Message').fill('Saturday 02:00 UTC');
  await admin.getByRole('button', { name: 'Publish now' }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'Planned maintenance' })).toBeVisible();
  await customer.reload();
  await expect(customer.getByRole('status').filter({ hasText: 'Planned maintenance' })).toBeVisible();
  await customer.getByRole('button', { name: 'Dismiss Planned maintenance' }).click();
  await expect(customer.getByText('Planned maintenance')).toHaveCount(0);
  await customer.reload();
  await expect(customer.getByText('Planned maintenance')).toHaveCount(0);
  // announcements are global and the server is shared by every test: take it down again so no other test sees it
  await admin.getByRole('listitem').filter({ hasText: 'Planned maintenance' }).getByRole('button', { name: 'Delete' }).click();
  await expect(admin.getByRole('listitem').filter({ hasText: 'Planned maintenance' })).toHaveCount(0);

  // the other sections render: queues, flags (and an override that really switches a feature off), audit, personal data
  await admin.getByRole('link', { name: 'Queues' }).click();
  await expect(admin.getByText(/Outbox: \d+ unpublished/)).toBeVisible();
  await admin.getByRole('link', { name: 'Feature flags' }).click();
  await expect(admin.getByRole('row', { name: /ai_assistant/ })).toBeVisible();
  const wsId = (await (await adminCtx.request.get(`/api/admin/workspaces?search=${encodeURIComponent(customerEmail)}`, { headers: { authorization: `Bearer ${await admin.evaluate(() => localStorage.getItem('funnels.token'))}` } })).json()).data[0].id as string;
  await admin.getByLabel('Flag', { exact: true }).selectOption('ai_assistant');
  await admin.getByLabel('Workspace id').fill(wsId);
  await admin.getByRole('button', { name: 'Force off' }).click();
  await expect.poll(async () => (await customer.evaluate(async () => (await fetch('/api/workspace/flags', { headers: { authorization: `Bearer ${localStorage.getItem('funnels.token')}` } })).json())).flags.ai_assistant).toBe(false);
  await admin.getByRole('button', { name: 'Remove override' }).click();
  await expect.poll(async () => (await customer.evaluate(async () => (await fetch('/api/workspace/flags', { headers: { authorization: `Bearer ${localStorage.getItem('funnels.token')}` } })).json())).flags.ai_assistant).toBe(true);
  await admin.getByRole('link', { name: 'Audit', exact: true }).click();
  await expect(admin.getByRole('row', { name: /admin\.workspace\.suspended/ })).toBeVisible();
  await admin.getByRole('link', { name: 'Personal data' }).click();
  await admin.getByLabel('Email address').fill(customerEmail);
  await admin.getByRole('button', { name: 'Look up' }).click();
  await expect(admin.getByLabel('Data held')).toContainText('"leads": []');

  // support access: act as the owner (banner, no admin area, credentials off limits), then end it
  await admin.getByRole('link', { name: 'Workspaces' }).click();
  await admin.getByLabel('Search').fill(customerEmail);
  await admin.getByRole('row', { name: new RegExp(customerEmail) }).getByRole('button').click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Act as owner' }).click();
  await admin.getByRole('dialog', { name: 'Act as the owner' }).getByLabel(/Reason/).fill('Ticket 4711: cannot publish');
  await admin.getByRole('dialog', { name: 'Act as the owner' }).getByRole('button', { name: 'Start support session' }).click();
  const banner = admin.getByRole('status').filter({ hasText: 'Support access' });
  await expect(banner).toContainText(customerEmail);
  await expect(banner).toContainText('read-only'); // support sessions cannot change anything unless a superadmin opted in
  await expect(admin.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await admin.goto('/funnels');
  await expect(banner).toBeVisible(); // survives a reload: it is the session
  await banner.getByRole('button', { name: 'End session' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Support access' })).toHaveCount(0);
  await expect(admin.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' })).toBeVisible(); // back as the administrator

  // the customer's own audit log shows who looked and why
  await customer.goto('/audit');
  await expect(customer.getByRole('main')).toContainText('admin.impersonation.started');
  await expect(customer.getByRole('main')).toContainText('Support access started');
  await expect(customer.getByRole('main')).toContainText('Ticket 4711: cannot publish');
  await customerCtx.close();
  await adminCtx.close();
});
