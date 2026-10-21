// Boots the BUILT server for the e2e suite exactly like server/dist/index.js, with one difference: DNS is answered by a fake resolver, so a domain such as
// offers.e2e.test can be verified without real DNS. The records it returns are the ones the app asks the user to create (CNAME to the app's target, TXT with the
// domain's verification token, read back from the database). Nothing in the product code knows about this.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The e2e package has its own node_modules; the server's dependencies are resolved from the server package.
const { serve } = await import(pathToFileURL(createRequire(join(import.meta.dirname, '../server/package.json')).resolve('@hono/node-server')).href);

const dist = (f) => import(pathToFileURL(join(import.meta.dirname, '../server/dist', f)).href);
const { createApp } = await dist('app.js');
const { createDeps, createWorker } = await dist('bootstrap.js');
const { loadConfig } = await dist('config.js');

// Stripe suite (playwright.stripe.config.ts): a fake Stripe API and its hosted pages, reached through STRIPE_API_BASE.
if (process.env.E2E_FAKE_STRIPE_PORT) {
  const { startFakeStripe } = await import('./fakestripe.mjs');
  await startFakeStripe({ port: Number(process.env.E2E_FAKE_STRIPE_PORT), appBase: process.env.APP_PUBLIC_URL, connectSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET });
}
const config = loadConfig();
let deps;
const dns = {
  async resolveCname(host) {
    return host.endsWith('.e2e.test') ? [config.APP_PUBLIC_CNAME_TARGET] : [];
  },
  async resolveTxt(host) {
    const hostname = host.replace(/^_funnels-challenge\./, '');
    const row = await deps.db.get('SELECT verification_token AS t FROM domains WHERE hostname = ?', hostname);
    return row ? [`funnels-verify=${row.t}`] : [];
  },
};
// A capturing mailer instead of a real transport, readable at http://127.0.0.1:<MAIL_PORT>/mail?to=<address> (the last message to that address, as JSON),
// so a test can follow an invitation or password reset link like a user following the email would.
const inbox = new Map();
const mailer = { kind: 'capture', async send(m) { inbox.set(m.to, m); return true; } };
const { createServer } = await import('node:http');
createServer((req, res) => {
  const to = new URL(req.url, 'http://x').searchParams.get('to') ?? '';
  const m = inbox.get(to);
  res.writeHead(m ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(m ?? { error: 'no mail for ' + to }));
}).listen(Number(process.env.MAIL_PORT ?? 4181), '127.0.0.1');
// Cloudflare Pages is answered by the in-memory fake of the test suite (server/test/support/fakecf.ts, loaded through tsx): the connection, the deployments and the
// history screens run for real, against the documented API shapes only.
const { FakeCloudflarePages } = await import(pathToFileURL(join(import.meta.dirname, '../server/test/support/fakecf.ts')).href);
const cf = new FakeCloudflarePages();
cf.pollsToFinish = 1;
deps = await createDeps(config, { dns, mailer, outbound: cf.fetch });
// The job worker (deployments to Cloudflare Pages, conversions, webhooks) runs in this process like in production.
createWorker(deps).start(config.JOB_POLL_MS);
const server = serve({ fetch: createApp(deps).fetch, port: config.PORT, hostname: config.HOST });
const stop = () => server.close(() => deps.db.close().finally(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
