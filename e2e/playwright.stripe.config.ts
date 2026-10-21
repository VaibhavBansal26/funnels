import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The Stripe suite: the same built server, but PAYMENTS_PROVIDER=stripe against the in-process fake Stripe (fakestripe.mjs): the connect flow and a test-mode
// purchase through the hosted checkout page. Run with `npm run test:stripe`. Not real Stripe: see docs/STRIPE.md for what is unverified.
const PORT = Number(process.env.E2E_STRIPE_PORT ?? 4280);
const FAKE = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests-stripe',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results-stripe',
  use: { baseURL: BASE, trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1360, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 }, launchOptions: { args: ['--host-resolver-rules=MAP *.e2e.test 127.0.0.1'] } } }],
  webServer: {
    command: 'node --import ../server/node_modules/tsx/dist/esm/index.mjs server.mjs',
    url: `${BASE}/readyz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'production', PORT: String(PORT), DATABASE_PATH: ':memory:', JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-123456', DATA_ENCRYPTION_KEY: 'e2e-data-key-e2e-data-key-e2e-data-key-1234',
      WEB_DIST: fileURLToPath(new URL('../web/dist', import.meta.url)), APP_PUBLIC_URL: BASE, APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test', LOG_LEVEL: 'error', TRUST_PROXY: 'true',
      IP_GUARD_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', AUTH_ATTEMPTS_PER_MINUTE: '100000', API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', EVENT_BUFFER_MS: '0', MAIL_PORT: String(PORT + 1),
      PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_e2efake1234', STRIPE_WEBHOOK_SECRET: 'whsec_e2e_platform', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_e2e_connect', STRIPE_API_BASE: `http://127.0.0.1:${FAKE}`, E2E_FAKE_STRIPE_PORT: String(FAKE),
    },
  },
});
