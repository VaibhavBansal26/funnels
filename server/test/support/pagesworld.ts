import { documentOf, createBuilder } from '../../src/blocks/index.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from '../helpers.js';
import { FakeCloudflarePages } from './fakecf.js';

/** A workspace with a live funnel (two steps) on an active domain, a Cloudflare connection to the fake, and helpers to run the job queue to quiescence. */
export async function pagesWorld(opts: { env?: Record<string, string>; connect?: boolean; target?: boolean; live?: boolean } = {}) {
  const cf = new FakeCloudflarePages();
  const h: Harness = await makeHarness({ env: { PAGES_POLL_INTERVAL_MS: '0', PAGES_DEBOUNCE_SECONDS: '0', API_PUBLIC_URL: 'https://api.funnels.test', ...opts.env }, deps: { outbound: cf.fetch } });
  const owner = await h.register();
  const f = await makeFunnel(h, owner.token, { name: 'Promo', base_path: '/promo' });
  const stepId = f.steps[0].id as string;
  const page = (headline: string) => h.call('PUT', `/api/funnels/${f.id}/steps/${stepId}/page`, { token: owner.token, body: { doc: documentOf([createBuilder('s').heading(headline)]) } });
  await page('Version one');
  const second = await h.call('POST', `/api/funnels/${f.id}/steps`, { token: owner.token, body: { name: 'Thanks', base_path: '/thanks' } });
  const hostname = 'promo.example.com';
  const domainId = await activeDomain(h, owner.token, hostname);
  const call = (m: string, p: string, body?: unknown, token = owner.token) => h.call(m, p, { token, body });

  const pending = async () => Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type LIKE 'publish.%' AND status IN ('queued', 'running')"))!.n);
  /** Runs the worker until no publishing job is left, moving the clock past any retry delay. */
  const drain = async (max = 200) => {
    for (let i = 0; i < max; i++) {
      const n = await h.worker.tick();
      if ((await pending()) === 0) return;
      if (n === 0) h.clock.advance(31_000);
    }
    throw new Error('publishing jobs did not settle');
  };

  const w = {
    cf, h, owner, f, stepId, secondStepId: second.json.id as string, hostname, domainId, call, drain, pending, page,
    connect: () => call('PUT', '/api/publishing/connection', { accountId: cf.accountId, token: cf.token }),
    go: () => call('PATCH', `/api/funnels/${f.id}`, { status: 'live', domain_id: domainId }),
    target: (body: Record<string, unknown> = {}) => call('PUT', `/api/funnels/${f.id}/publishing`, { target: 'cloudflare-pages', ...body }),
    settings: () => call('GET', `/api/funnels/${f.id}/publishing`),
    deployments: async () => (await call('GET', `/api/funnels/${f.id}/publishing/deployments`)).json.data as any[],
    project: () => `fn-${(w.settingsSync?.project ?? '')}`,
    settingsSync: null as null | { project: string },
    async projectName() {
      return (await w.settings()).json.project?.name as string;
    },
  };
  if (opts.connect !== false) expectOk(await w.connect());
  if (opts.live !== false) expectOk(await w.go());
  if (opts.target !== false) {
    expectOk(await w.target());
    await drain();
  }
  return w;
}

function expectOk(r: { status: number; text: string }) {
  if (r.status >= 300) throw new Error(`setup call failed: ${r.status} ${r.text.slice(0, 300)}`);
}
