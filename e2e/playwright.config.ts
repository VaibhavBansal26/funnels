import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4180);
const BASE = `http://127.0.0.1:${PORT}`;
export const MAIL = `http://127.0.0.1:${PORT + 1}`;

// The suite drives the BUILT server (server/dist) serving the BUILT web app (web/dist), the way it is deployed, with an in-memory SQLite database
// (nothing to clean up). Build first: `npm run build` (the root script `npm run e2e` does). One worker: the tests share one server and register their own users.
export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0, // a retry would hide the flakiness this suite exists to expose
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1360, height: 900 } },
  // *.e2e.test resolves to the local server, so a verified domain can be opened in the browser with its own Host header.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 }, launchOptions: { args: ['--host-resolver-rules=MAP *.e2e.test 127.0.0.1'] } } }],
  webServer: {
    command: 'node server.mjs',
    url: `${BASE}/readyz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_PATH: ':memory:',
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-123456',
      WEB_DIST: fileURLToPath(new URL('../web/dist', import.meta.url)),
      APP_PUBLIC_URL: BASE,
      APP_PUBLIC_CNAME_TARGET: 'sites.e2e.test',
      LOG_LEVEL: 'error',
      TRUST_PROXY: 'true',
      IP_GUARD_PER_MINUTE: '1000000',
      PUBLIC_FORMS_PER_MINUTE: '100000',
      AUTH_ATTEMPTS_PER_MINUTE: '100000',
      API_USER_PER_MINUTE: '1000000',
      API_WORKSPACE_PER_MINUTE: '1000000',
      EVENT_BUFFER_MS: '0',
      MAIL_PORT: String(PORT + 1),
    },
  },
});
