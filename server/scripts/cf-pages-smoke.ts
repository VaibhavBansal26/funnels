// Checks publish/cfclient.ts against REAL Cloudflare with your own API token. It is the only thing that can turn "verified against the documented shapes with a fake"
// into "verified". Nothing here runs in CI and the repository has never run it.
//
//   CF_ACCOUNT_ID=<32 hex> CF_API_TOKEN=<token with Cloudflare Pages: Edit> npx tsx scripts/cf-pages-smoke.ts
//   optional: CF_SMOKE_DOMAIN=smoke.example.com   (a hostname on a zone in this account: also tests custom domains)
//             KEEP=1                              (do not delete the project afterwards)
//
// It creates a throwaway project (fn-smoke-<random>), deploys two tiny sites, proves a page is served (this is what catches a wrong asset hash, which Cloudflare
// accepts silently), rolls back to the first, optionally attaches the domain, and deletes everything it created. The token is read from the environment only and is
// never printed. Expect about a minute. Free plan: it uses 1 of your 100 projects while it runs.
import { randomBytes } from 'node:crypto';
import { buildBundle, beaconPath } from '../src/publish/bundle.js';
import { batches, CloudflareApiError, CloudflarePagesClient, deploymentState, domainState, type PagesDeployment } from '../src/publish/cfclient.js';

const accountId = process.env.CF_ACCOUNT_ID ?? '';
const token = process.env.CF_API_TOKEN ?? '';
if (!/^[a-f0-9]{32}$/i.test(accountId) || token.length < 20) {
  console.error('Set CF_ACCOUNT_ID (32 hex characters) and CF_API_TOKEN (a token with "Cloudflare Pages: Edit").');
  process.exit(2);
}
const base = process.env.CF_API_BASE ?? 'https://api.cloudflare.com/client/v4';
const client = new CloudflarePagesClient({ accountId, token, base }, fetch, 60_000);
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

const page = (n: number) => `<!doctype html><html><head><meta charset="utf-8"><title>Smoke ${n}</title></head><body><main>Funnels smoke test version ${n}</main><script async src="${beaconPath('x')}"></script></body></html>`;
const site = (n: number) =>
  buildBundle({
    steps: [{ id: 's1', basePath: '/', html: page(n), knownInline: [], vendors: { script: [], connect: [], img: [], frame: [] } }, { id: 's2', basePath: '/thanks', html: page(n + 100), knownInline: [], vendors: { script: [], connect: [], img: [], frame: [] } }],
    assets: new Map(), beaconJs: 'x', apiOrigin: 'https://app.example.com', limits: { maxFiles: 20_000, maxFileBytes: 25 * 1024 * 1024 },
  });

async function deploy(n: number): Promise<PagesDeployment> {
  const bundle = site(n);
  const jwt = await client.uploadToken(name);
  const hashes = bundle.files.map((f) => f.hash);
  const missing = new Set(await client.checkMissing(jwt, hashes));
  for (const b of batches(bundle.files.filter((f) => missing.has(f.hash)).map((f) => ({ hash: f.hash, base64: Buffer.from(f.bytes).toString('base64'), contentType: f.contentType })))) await client.upload(jwt, b);
  await client.upsertHashes(jwt, hashes);
  let d = await client.createDeployment(name, { manifest: bundle.manifest, headers: bundle.headers, redirects: bundle.redirects, commitHash: bundle.versionId, commitMessage: `smoke ${n}` });
  for (let i = 0; i < 60; i++) {
    const s = deploymentState(d);
    if (s.state === 'succeeded') return d;
    if (s.state === 'failed') throw new Error(s.message ?? 'deployment failed');
    await new Promise((r) => setTimeout(r, 2000));
    d = await client.getDeployment(name, d.id);
  }
  throw new Error('deployment did not finish in two minutes');
}

const fetchText = async (path: string) => {
  const res = await fetch(`https://${name}.pages.dev${path}`, { headers: { 'cache-control': 'no-cache' } });
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const until = async (label: string, check: () => Promise<boolean>) => {
  for (let i = 0; i < 30; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label}: not true after 90 seconds`);
};

console.log(`Cloudflare Pages smoke test, project ${name}`);
await step('token can read Pages (verify)', () => client.verify());
const project = await step('create project', () => client.createProject(name));
if (project) {
  console.log(`  project host: ${project.subdomain}`);
  const first = await step('deploy version 1 (upload-token, check-missing, upload, upsert-hashes, deployment, poll)', () => deploy(1));
  await step('version 1 is served at / (proves the asset hash algorithm)', () => until('page', async () => (await fetchText('/')).text.includes('version 1')));
  await step('/thanks/ is served from thanks/index.html', async () => {
    const r = await fetchText('/thanks/');
    if (!r.text.includes('version 101')) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 100)}`);
  });
  await step('_headers applied (X-Content-Type-Options and a Content-Security-Policy)', async () => {
    const r = await fetchText('/');
    if (r.headers.get('x-content-type-options') !== 'nosniff' || !r.headers.get('content-security-policy')) throw new Error(`got ${JSON.stringify([...r.headers.entries()].filter(([k]) => /content-|x-/.test(k)))}`);
  });
  await step('unknown path answers 404', async () => {
    const r = await fetchText('/definitely-not-here/');
    if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
  });
  await step('deploy version 2', () => deploy(2));
  await step('version 2 is served', () => until('page', async () => (await fetchText('/')).text.includes('version 2')));
  if (first) {
    await step('roll back to version 1', () => client.rollback(name, first.id));
    await step('version 1 is served again', () => until('page', async () => (await fetchText('/')).text.includes('version 1')));
  }
  const domain = process.env.CF_SMOKE_DOMAIN;
  if (domain) {
    await step(`add custom domain ${domain}`, () => client.addDomain(name, domain));
    await step('read custom domain status', async () => console.log(`       status: ${domainState(await client.getDomain(name, domain)).status}`));
    await step('delete custom domain', () => client.deleteDomain(name, domain));
  }
  if (process.env.KEEP !== '1') await step('delete project (and its deployments)', () => client.deleteProject(name));
  else console.log(`  kept: delete ${name} yourself in the dashboard`);
}
const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed${failed.length ? '; failed:\n' + failed.map((f) => `  - ${f[0]}: ${f[2]}`).join('\n') : ''}`);
process.exit(failed.length ? 1 : 0);
