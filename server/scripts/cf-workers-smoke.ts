// Checks publish/cfworkers.ts (EXPERIMENTAL) against REAL Cloudflare with your own API token. Nothing here runs in CI and the repository has never run it.
//
//   CF_ACCOUNT_ID=<32 hex> CF_API_TOKEN=<token with Workers Scripts: Edit> npx tsx scripts/cf-workers-smoke.ts
//   (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are accepted as aliases; the variable names used are printed, never the token)
//   optional: KEEP=1   (do not delete the Worker afterwards)
//
// It deploys a tiny static site as a Worker with static assets (fn-smoke-<random>), enables its workers.dev address, fetches the pages (this is what catches a wrong asset
// hash or a wrong upload shape), deploys a second version, rolls back to the first, and deletes the Worker. If the account has no workers.dev subdomain it says so and
// stops after the upload checks. The token is read from the environment only. Free plan: it uses 1 of your 100 Workers while it runs.
import { randomBytes } from 'node:crypto';
import { buildBundle } from '../src/publish/bundle.js';
import { CloudflareApiError } from '../src/publish/cfclient.js';
import { CloudflareWorkersClient, type WorkersFile } from '../src/publish/cfworkers.js';

const accountVar = process.env.CF_ACCOUNT_ID ? 'CF_ACCOUNT_ID' : 'CLOUDFLARE_ACCOUNT_ID';
const tokenVar = process.env.CF_API_TOKEN ? 'CF_API_TOKEN' : 'CLOUDFLARE_API_TOKEN';
const accountId = process.env[accountVar] ?? '';
const token = process.env[tokenVar] ?? '';
if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20) {
  console.error('Set CF_ACCOUNT_ID (32 hex characters) and CF_API_TOKEN (a token with "Workers Scripts: Edit"). Never paste a token into a chat, a file or a commit.');
  process.exit(2);
}
console.log(`Using ${accountVar} and ${tokenVar} from the environment (the token is never printed).`);
const base = process.env.CF_API_BASE ?? 'https://api.cloudflare.com/client/v4';
const client = new CloudflareWorkersClient({ accountId, token, base }, fetch, 60_000);
const name = `fn-smoke-${randomBytes(4).toString('hex')}`;
const results: [string, boolean, string][] = [];
const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await fn();
    results.push([label, true, '']);
    console.log(`  ok   ${label}`);
    return r;
  } catch (e) {
    const msg = (e instanceof CloudflareApiError ? `HTTP ${e.status} code ${e.code}: ${e.message}` : (e as Error).message).split(token).join('[token]');
    results.push([label, false, msg]);
    console.log(`  FAIL ${label}: ${msg}`);
    return undefined;
  }
};

const page = (n: number) => `<!doctype html><html><head><meta charset="utf-8"><title>Smoke ${n}</title></head><body><main>Funnels workers smoke test version ${n}</main></body></html>`;
const site = (n: number): WorkersFile[] =>
  buildBundle({
    steps: [{ id: 's1', basePath: '/', html: page(n), knownInline: [], vendors: { script: [], connect: [], img: [], frame: [] } }, { id: 's2', basePath: '/thanks', html: page(n + 100), knownInline: [], vendors: { script: [], connect: [], img: [], frame: [] } }],
    assets: new Map(), beaconJs: 'x', apiOrigin: 'https://app.example.com', limits: { maxFiles: 20_000, maxFileBytes: 25 * 1024 * 1024 },
  }).files.map((f) => ({ path: f.path, hash: f.hash, size: f.bytes.length, bytes: f.bytes, contentType: f.contentType }));

const until = async (label: string, check: () => Promise<boolean>) => {
  for (let i = 0; i < 30; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label}: not true after 90 seconds`);
};

console.log(`Cloudflare Workers static assets smoke test (EXPERIMENTAL), Worker ${name}`);
await step('token can read Workers scripts (verify)', () => client.verify());
const sub = await step('account workers.dev subdomain', async () => {
  const s = await client.accountSubdomain();
  console.log(s ? `       ${s}.workers.dev` : '       none registered: register one in the dashboard (Workers & Pages > your Worker > Settings > Domains & Routes) or the free address cannot be used');
  return s;
});
const first = await step('deploy version 1 (assets-upload-session, upload, script upload)', () => client.deploy(name, site(1), 'smoke 1'));
if (first) {
  await step('enable workers.dev for the Worker', () => client.enableWorkersDev(name));
  if (sub) {
    const get = async (path: string) => {
      const res = await fetch(`https://${name}.${sub}.workers.dev${path}`, { headers: { 'cache-control': 'no-cache' } });
      return { status: res.status, text: await res.text() };
    };
    await step('version 1 is served at / (proves the asset hash and upload shape)', () => until('page', async () => (await get('/')).text.includes('version 1')));
    await step('/thanks/ is served', async () => {
      const r = await get('/thanks/');
      if (!r.text.includes('version 101')) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 100)}`);
    });
    const second = await step('deploy version 2', () => client.deploy(name, site(2), 'smoke 2'));
    await step('version 2 is served', () => until('page', async () => (await get('/')).text.includes('version 2')));
    if (first.versionId && second) {
      await step('roll back to version 1', () => client.rollback(name, first.versionId!));
      await step('version 1 is served again', () => until('page', async () => (await get('/')).text.includes('version 1')));
    } else console.log('  skip rollback: the deployments list did not return version ids');
  }
  if (process.env.KEEP !== '1') await step('delete the Worker', () => client.deleteScript(name));
  else console.log(`  kept: delete ${name} yourself in the dashboard`);
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed${failed.length ? '; failed:\n' + failed.map((f) => `  - ${f[0]}: ${f[2]}`).join('\n') : ''}`);
process.exit(failed.length ? 1 : 0);
