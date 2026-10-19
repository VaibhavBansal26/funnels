import type { ZodType } from 'zod';
import * as ai from '../ai/service.js';
import { AnalyticsQuery } from '../services/analytics.js';
import { DefaultPagesInput, DomainInput } from '../services/domains.js';
import { PublicEventInput } from '../services/events.js';
import { BulkTagInput, CreateFunnelInput, ListQuery, UpdateFunnelInput } from '../services/funnels.js';
import { LeadQuery, SubmitInput } from '../services/leads.js';
import { CheckoutInput, OrderQuery } from '../services/orders.js';
import { SaveInput } from '../services/pages.js';
import { ReorderInput, StepInput, StepPatch, ValidatePathInput } from '../services/steps.js';
import { TagInput } from '../services/tags.js';
import { CategoryInput, CustomBlockInput, TemplateCreate, TemplatePatch, TemplateQuery } from '../services/templates.js';
import { WebhookInput, WebhookPatch } from '../services/webhooks.js';
import { LoginInput, MemberInput, MemberPatch, RegisterInput, WorkspacePatch } from '../services/accounts.js';

/**
 * THE route declaration. One row per HTTP operation, read by:
 *  - the rate limiter (which policies apply, at which cost, scoped how),
 *  - the OpenAPI generator (`npm run docs:api` -> docs/openapi.json),
 *  - tests that fail when a route exists without a row, a row without a route, a non-public route that answers without credentials,
 *    a role-gated route that answers a lower role, or a route without a limiter policy.
 * Adding a route means adding its row here.
 */
export type Auth = 'public' | 'user' | 'admin' | 'owner' | 'platform' | 'edge' | 'infra';

export interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: Auth;
  tag: string;
  summary: string;
  body?: ZodType;
  query?: ZodType;
  /** Policy ids the middleware applies before the handler (principal/workspace layers run right after authentication). */
  limits: string[];
  /** Policies the handler or service applies itself because they need data only it has (body fields, model calls, held slots). */
  inHandler?: string[];
  /** Cost units charged to `api.workspace` (default 1). */
  cost?: number;
  /** Path param whose value scopes a composite key (`public.*`). */
  scope?: string;
  /** Set instead of `limits` for probes that must never be limited. */
  exempt?: string;
  status?: number;
  notes?: string;
}

const READ = ['ip.global', 'api.read', 'api.workspace'];
const WRITE = ['ip.global', 'api.write', 'api.workspace'];

type Extra = Partial<Pick<Operation, 'body' | 'query' | 'cost' | 'inHandler' | 'scope' | 'status' | 'notes'>> & { limits?: string[] };

const make = (method: Operation['method'], path: string, auth: Auth, tag: string, summary: string, x: Extra = {}): Operation => {
  const { limits, ...rest } = x;
  return { method, path, auth, tag, summary, limits: limits ?? (method === 'GET' ? READ : WRITE), ...rest };
};

const A = (m: Operation['method'], p: string, tag: string, s: string, x?: Extra) => make(m, p, 'user', tag, s, x);
const ADMIN = (m: Operation['method'], p: string, tag: string, s: string, x?: Extra) => make(m, p, 'admin', tag, s, x);
const OWNER = (m: Operation['method'], p: string, tag: string, s: string, x?: Extra) => make(m, p, 'owner', tag, s, x);
const PLATFORM = (m: Operation['method'], p: string, tag: string, s: string, x?: Extra) => make(m, p, 'platform', tag, s, { limits: ['ip.global', 'admin.platform', 'api.workspace'], ...x });

export const OPERATIONS: Operation[] = [
  // infrastructure
  { method: 'GET', path: '/healthz', auth: 'infra', tag: 'ops', summary: 'Liveness probe', limits: [], exempt: 'Orchestrator probe; no data, must answer under any load' },
  { method: 'GET', path: '/readyz', auth: 'infra', tag: 'ops', summary: 'Readiness: database reachable, buffer depth, migrations applied', limits: [], exempt: 'Orchestrator probe' },
  { method: 'GET', path: '/metrics', auth: 'infra', tag: 'ops', summary: 'Prometheus metrics (Bearer METRICS_TOKEN when set)', limits: [], exempt: 'Scraper; protected by METRICS_TOKEN' },
  { method: 'GET', path: '/beacon.js', auth: 'public', tag: 'public', summary: 'Tracking beacon script (cacheable)', limits: ['ip.global'] },
  { method: 'GET', path: '/internal/edge/resolve', auth: 'edge', tag: 'edge', summary: 'Signed resolve call from the Cloudflare worker', limits: ['edge.resolve'], notes: 'HMAC over timestamp, nonce, method and path; fails closed without EDGE_SHARED_SECRET.' },
  { method: 'GET', path: '/preview/:funnelId', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel (first step)', limits: ['ip.global', 'public.preview'], notes: 'Authorised by a short-lived token in ?token=.' },
  { method: 'GET', path: '/preview/:funnelId/*', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel step', limits: ['ip.global', 'public.preview'] },
  // public ingestion
  { method: 'POST', path: '/api/public/events', auth: 'public', tag: 'public', summary: 'Record a page view or opt-in (accepted into a write-behind buffer)', body: PublicEventInput, limits: ['ip.global'], inHandler: ['public.events'], status: 202, notes: 'Keyed by IP and the funnelId in the body.' },
  { method: 'POST', path: '/api/public/forms/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Submit a lead form', body: SubmitInput, limits: ['ip.global', 'public.forms'], scope: 'funnelId' },
  { method: 'POST', path: '/api/public/checkout/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Checkout (main offer, bumps, one-click upsell)', body: CheckoutInput, limits: ['ip.global', 'public.checkout'], scope: 'funnelId' },
  // auth and account
  make('POST', '/api/auth/register', 'public', 'auth', 'Create an account and its workspace', { body: RegisterInput, limits: ['ip.global', 'auth.attempts'], status: 201 }),
  make('POST', '/api/auth/login', 'public', 'auth', 'Log in', { body: LoginInput, limits: ['ip.global', 'auth.attempts'], inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  A('GET', '/api/auth/me', 'auth', 'Current user and workspace'),
  A('POST', '/api/events/ticket', 'events', 'Short-lived ticket for the SSE stream', { limits: READ }),
  A('GET', '/api/events/stream', 'events', 'Server-sent events for the workspace', { inHandler: ['api.stream'], notes: 'Bearer header or ?ticket=.' }),
  A('GET', '/api/workspace', 'workspace', 'Workspace details'),
  OWNER('PATCH', '/api/workspace', 'workspace', 'Rename the workspace, toggle custom scripts', { body: WorkspacePatch }),
  A('GET', '/api/members', 'workspace', 'List members'),
  OWNER('POST', '/api/members', 'workspace', 'Add a member with a one-time password', { body: MemberInput, status: 201 }),
  OWNER('PATCH', '/api/members/:id', 'workspace', 'Change a member role', { body: MemberPatch }),
  OWNER('DELETE', '/api/members/:id', 'workspace', 'Remove a member', { status: 204 }),
  // funnels
  A('GET', '/api/funnels', 'funnels', 'List funnels (page/limit, search, filters)', { query: ListQuery }),
  A('GET', '/api/funnels/filters', 'funnels', 'Filter counts'),
  A('GET', '/api/funnels/trash', 'funnels', 'Funnels in the trash'),
  A('POST', '/api/funnels', 'funnels', 'Create a funnel', { body: CreateFunnelInput, status: 201 }),
  A('POST', '/api/funnels/validate-path', 'funnels', 'Check a step path for format and collisions', { body: ValidatePathInput }),
  A('POST', '/api/funnels/bulk-tag', 'funnels', 'Add/remove tags on several funnels', { body: BulkTagInput }),
  A('GET', '/api/funnels/:id', 'funnels', 'Funnel with steps and stats'),
  A('PATCH', '/api/funnels/:id', 'funnels', 'Update a funnel (status, domain, tags, tracking code)', { body: UpdateFunnelInput }),
  A('PUT', '/api/funnels/:id', 'funnels', 'Same as PATCH', { body: UpdateFunnelInput }),
  ADMIN('DELETE', '/api/funnels/:id', 'funnels', 'Move a funnel to the trash', { status: 204 }),
  ADMIN('POST', '/api/funnels/:id/restore', 'funnels', 'Restore from the trash'),
  OWNER('DELETE', '/api/funnels/:id/purge', 'funnels', 'Permanently delete a trashed funnel', { status: 204 }),
  A('POST', '/api/funnels/:id/duplicate', 'funnels', 'Duplicate a funnel', { status: 201, cost: 3 }),
  A('POST', '/api/funnels/:id/preview-token', 'funnels', 'Mint a signed preview token'),
  A('GET', '/api/funnels/:id/analytics', 'analytics', 'Funnel analytics for a date range and time zone', { query: AnalyticsQuery }),
  A('GET', '/api/funnels/:id/steps', 'steps', 'Steps of a funnel'),
  A('POST', '/api/funnels/:id/steps', 'steps', 'Add a step', { body: StepInput, status: 201 }),
  A('PUT', '/api/funnels/:id/steps/order', 'steps', 'Reorder all steps', { body: ReorderInput }),
  A('PATCH', '/api/funnels/:id/steps/:sid', 'steps', 'Update step settings', { body: StepPatch }),
  A('DELETE', '/api/funnels/:id/steps/:sid', 'steps', 'Delete a step', { status: 204 }),
  A('POST', '/api/funnels/:id/steps/:sid/duplicate', 'steps', 'Duplicate a step', { status: 201 }),
  A('GET', '/api/funnels/:id/steps/:sid/analytics', 'analytics', 'Step analytics', { query: AnalyticsQuery }),
  A('GET', '/api/funnels/:id/steps/:sid/page', 'pages', 'Page document and version'),
  A('PUT', '/api/funnels/:id/steps/:sid/page', 'pages', 'Save the page document (optimistic concurrency on `version`)', { body: SaveInput, cost: 2 }),
  A('GET', '/api/funnels/:id/steps/:sid/backups', 'pages', 'Page backups'),
  A('GET', '/api/funnels/:id/steps/:sid/backups/:bid', 'pages', 'One backup'),
  A('POST', '/api/funnels/:id/steps/:sid/backups/:bid/restore', 'pages', 'Restore a backup', { cost: 2 }),
  // tags
  A('GET', '/api/tags', 'tags', 'List tags'),
  A('POST', '/api/tags', 'tags', 'Create a tag', { body: TagInput, status: 201 }),
  A('PUT', '/api/tags/:id', 'tags', 'Rename a tag', { body: TagInput }),
  A('DELETE', '/api/tags/:id', 'tags', 'Delete a tag', { status: 204 }),
  A('DELETE', '/api/tags', 'tags', 'Delete several tags (?ids=a,b)'),
  // domains
  A('GET', '/api/domains', 'domains', 'List domains'),
  A('GET', '/api/domains/:id', 'domains', 'One domain with DNS instructions'),
  A('GET', '/api/domains/:id/routes', 'domains', 'Step paths served on the domain'),
  ADMIN('POST', '/api/domains', 'domains', 'Add a domain', { body: DomainInput, status: 201 }),
  ADMIN('POST', '/api/domains/:id/verify', 'domains', 'Run the DNS check now', { cost: 5 }),
  ADMIN('PUT', '/api/domains/:id/default-pages', 'domains', 'Set the domain home and 404 steps', { body: DefaultPagesInput }),
  ADMIN('DELETE', '/api/domains/:id', 'domains', 'Delete a domain (funnels revert to test)', { status: 204 }),
  // leads, orders
  A('GET', '/api/leads', 'leads', 'List leads', { query: LeadQuery }),
  A('GET', '/api/leads/export', 'leads', 'CSV export (streamed, newest first)', { query: LeadQuery, cost: 5, inHandler: ['api.export'] }),
  A('GET', '/api/orders', 'orders', 'List orders', { query: OrderQuery }),
  A('GET', '/api/orders/export', 'orders', 'CSV export (streamed)', { query: OrderQuery, cost: 5, inHandler: ['api.export'] }),
  A('GET', '/api/orders/:id', 'orders', 'One order'),
  // webhooks
  ADMIN('GET', '/api/webhooks', 'webhooks', 'List webhooks'),
  ADMIN('POST', '/api/webhooks', 'webhooks', 'Create a webhook (secret shown once)', { body: WebhookInput, status: 201 }),
  ADMIN('PATCH', '/api/webhooks/:id', 'webhooks', 'Update a webhook', { body: WebhookPatch }),
  ADMIN('DELETE', '/api/webhooks/:id', 'webhooks', 'Delete a webhook', { status: 204 }),
  ADMIN('POST', '/api/webhooks/:id/rotate-secret', 'webhooks', 'Rotate the signing secret'),
  ADMIN('POST', '/api/webhooks/:id/test', 'webhooks', 'Queue a test delivery', { status: 202 }),
  ADMIN('GET', '/api/webhooks/:id/deliveries', 'webhooks', 'Delivery log'),
  ADMIN('POST', '/api/webhooks/deliveries/:did/retry', 'webhooks', 'Retry a delivery'),
  // notifications
  A('GET', '/api/notifications', 'notifications', 'Notification feed'),
  A('POST', '/api/notifications/read-all', 'notifications', 'Mark all read', { status: 204 }),
  A('POST', '/api/notifications/:id/read', 'notifications', 'Mark one read', { status: 204 }),
  // templates and blocks
  A('GET', '/api/templates', 'templates', 'List templates', { query: TemplateQuery }),
  A('GET', '/api/templates/categories', 'templates', 'Template categories'),
  A('GET', '/api/templates/:id', 'templates', 'One template with step documents'),
  A('POST', '/api/templates/:id/use', 'templates', 'Create a funnel from a template', { status: 201, cost: 3 }),
  A('GET', '/api/blocks', 'blocks', 'Saved custom blocks'),
  A('POST', '/api/blocks', 'blocks', 'Save a custom block', { body: CustomBlockInput, status: 201 }),
  A('DELETE', '/api/blocks/:id', 'blocks', 'Delete a custom block', { status: 204 }),
  PLATFORM('POST', '/api/admin/templates', 'admin', 'Publish a funnel as a global template (PLATFORM_ADMIN_EMAILS)', { body: TemplateCreate, status: 201 }),
  PLATFORM('PATCH', '/api/admin/templates/:id', 'admin', 'Edit a template', { body: TemplatePatch }),
  PLATFORM('DELETE', '/api/admin/templates/:id', 'admin', 'Delete a template', { status: 204 }),
  PLATFORM('POST', '/api/admin/template-categories', 'admin', 'Create a template category', { body: CategoryInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/template-categories/:id', 'admin', 'Delete a template category', { status: 204 }),
  // AI
  A('GET', '/api/ai/status', 'ai', 'Provider and daily usage'),
  A('POST', '/api/ai/funnel', 'ai', 'Generate a funnel', { body: ai.FunnelRequest, status: 201, limits: ['ip.global', 'api.write', 'api.workspace'], inHandler: ['ai.minute'] }),
  A('POST', '/api/ai/rewrite', 'ai', 'Rewrite copy', { body: ai.RewriteRequest, inHandler: ['ai.minute'] }),
  A('POST', '/api/ai/headlines', 'ai', 'Headline variants', { body: ai.HeadlineRequest, inHandler: ['ai.minute'] }),
  A('POST', '/api/ai/insights', 'ai', 'Analytics insights', { body: ai.InsightRequest, inHandler: ['ai.minute'] }),
  A('POST', '/api/ai/alt-text', 'ai', 'Alt text for an image', { body: ai.AltTextRequest, inHandler: ['ai.minute'] }),
];

const key = (m: string, p: string) => `${m} ${p}`;
export const OPERATION_BY_KEY = new Map(OPERATIONS.map((o) => [key(o.method, o.path), o]));

interface Matcher {
  op: Operation;
  re: RegExp;
}
const MATCHERS: Matcher[] = OPERATIONS.map((op) => ({
  op,
  re: new RegExp(`^${op.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '([^/]+)').replace(/\*/g, '.*')}/?$`),
})).sort((a, b) => (a.op.path.includes(':') ? 1 : 0) - (b.op.path.includes(':') ? 1 : 0)); // literal paths win over parameterised ones

/** Finds the declaration for a request, with its path parameters. */
export function matchOperation(method: string, pathname: string): { op: Operation; params: Record<string, string> } | null {
  for (const { op, re } of MATCHERS) {
    if (op.method !== method) continue;
    const m = re.exec(pathname);
    if (!m) continue;
    const names = [...op.path.matchAll(/:([A-Za-z]+)/g)].map((x) => x[1]!);
    return { op, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? '')])) };
  }
  return null;
}
