import { z } from 'zod';
import { can, type Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden } from '../errors.js';
import { listSteps, requireFunnel } from '../repos/funnels.js';
import type { DomainRow } from '../repos/types.js';
import { addressFrom, ensurePagesDomain, pagesHostOf, workspaceSlugOf } from './addresses.js';
import { getConnection, getSettings, platformAvailable, platformProjectName, schedulePublish, updateSettings } from './publishing.js';
import { updateFunnel } from './funnels.js';

/**
 * "Go live": choose WHERE the funnel is reachable, see the final URL, publish. Three kinds of address (services/addresses.ts):
 *   builtin  free, on this app (no DNS)                    custom  a verified domain of the workspace       pages  the funnel's <project>.pages.dev
 * `options` lists them with what is missing for each; `goLive` attaches the chosen one and sets the funnel live in one step, starting the first deployment when
 * the address is a Cloudflare one. Taking a funnel offline is the normal PATCH with `status: "test"`.
 */
export const GoLiveInput = z.object({
  address: z.object({ kind: z.enum(['pages', 'custom']), domainId: z.string().max(64).optional() }),
  conflicts: z.array(z.object({ path: z.string().max(300), resolved_path: z.string().max(300) })).max(500).optional(),
});

export interface AddressOption {
  kind: 'builtin' | 'pages' | 'custom';
  /** Domain record to attach; null for the Pages address before the project exists. */
  domainId: string | null;
  label: string;
  /** What the first step's URL will be (or is). Null while it cannot be known yet. */
  url: string | null;
  host: string | null;
  available: boolean;
  /** Why it is not available, in words for the person. */
  reason: string | null;
  status: 'active' | 'pending' | 'failed' | null;
  selected: boolean;
}

export async function addressOptions(deps: Deps, ws: string, funnelId: string) {
  const funnel = await requireFunnel(deps.db, ws, funnelId);
  const steps = await listSteps(deps.db, ws, funnelId);
  const first = steps[0]?.base_path ?? funnel.base_path;
  const wsSlug = await workspaceSlugOf(deps, ws);
  const options: AddressOption[] = [];

  // Cloudflare Pages
  const conn = await getConnection(deps, ws);
  const pub = await deps.db.get<{ target: string; pages_host: string | null }>('SELECT target, pages_host FROM funnel_publish WHERE funnel_id = ?', funnelId);
  const pagesDomain = await deps.db.get<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'pages' AND system_funnel_id = ?", ws, funnelId);
  const onPages = pub?.target === 'cloudflare-pages';
  const canPages = conn.connected || (await platformAvailable(deps));
  // Before the project exists the default name is shown (Cloudflare may add a suffix if the name is taken; the real address appears once it is created).
  const host = onPages ? pub!.pages_host : canPages ? `${platformProjectName(deps, funnelId)}.pages.dev` : null;
  options.push({
    kind: 'pages', domainId: pagesDomain?.id ?? null, label: 'Cloudflare Pages address (free)', host,
    url: host ? `https://${host}${first === '/' ? '/' : first}` : null,
    available: canPages, reason: canPages ? null : 'Connect a Cloudflare account first (Settings > Publishing).',
    status: pagesDomain ? (pagesDomain.status === 'active' ? 'active' : 'pending') : null, selected: !!funnel.domain_id && funnel.domain_id === pagesDomain?.id,
  });

  // Customer domains
  for (const d of await deps.db.all<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'custom' ORDER BY created_at, id", ws)) {
    const a = addressFrom(deps, funnel, d, { workspaceSlug: wsSlug, pagesHost: null })!;
    options.push({
      kind: 'custom', domainId: d.id, label: d.hostname, host: d.hostname, url: a.base + (first === '/' ? '/' : first),
      available: d.status === 'active', reason: d.status === 'active' ? null : d.status === 'pending' ? 'DNS is not verified yet (Domains page).' : 'Verification failed (Domains page).',
      status: d.status, selected: funnel.domain_id === d.id,
    });
  }
  const settings = await getSettings(deps, ws, funnelId);
  return { options, state: settings.state, funnelStatus: funnel.status, currentDomainId: funnel.domain_id };
}

export async function goLive(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof GoLiveInput>, ip: string | null) {
  const ws = auth.workspaceId;
  await requireFunnel(deps.db, ws, funnelId);
  const { kind, domainId } = input.address;
  if (kind === 'custom') {
    if (!domainId) throw badRequest('DOMAIN_REQUIRED', 'Choose one of your verified domains');
    return { funnel: await updateFunnel(deps, auth, funnelId, { status: 'live', domain_id: domainId, conflicts: input.conflicts }), publishing: await getSettings(deps, ws, funnelId) };
  }
  // Cloudflare Pages: the project is created on the way, which needs the publishing permission.
  if (!can(auth, 'publishing:manage')) throw forbidden('Publishing to Cloudflare Pages requires the "publishing:manage" permission');
  const current = await deps.db.get<{ target: string }>('SELECT target FROM funnel_publish WHERE funnel_id = ?', funnelId);
  if (current?.target !== 'cloudflare-pages') await updateSettings(deps, auth, funnelId, { target: 'cloudflare-pages' }, ip);
  const domain = await ensurePagesDomain(deps, ws, funnelId);
  if (!(await pagesHostOf(deps, funnelId))) throw conflict('NOT_PUBLISHED_TO_PAGES', 'The Cloudflare Pages project could not be set up');
  const detail = await updateFunnel(deps, auth, funnelId, { status: 'live', domain_id: domain.id });
  await schedulePublish(deps, ws, funnelId, 'publish', auth.userId, true); // start now instead of after the save debounce
  return { funnel: detail, publishing: await getSettings(deps, ws, funnelId) };
}
