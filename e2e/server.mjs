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
const { createDeps } = await dist('bootstrap.js');
const { loadConfig } = await dist('config.js');

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
deps = await createDeps(config, { dns });
const server = serve({ fetch: createApp(deps).fetch, port: config.PORT, hostname: config.HOST });
const stop = () => server.close(() => deps.db.close().finally(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
