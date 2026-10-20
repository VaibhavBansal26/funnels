import type { ZodType } from 'zod';
import type { Permission } from '../auth/permissions.js';
import * as ai from '../ai/service.js';
import { AnalyticsQuery } from '../services/analytics.js';
import { DefaultPagesInput, DomainInput } from '../services/domains.js';
import { PublicEventInput } from '../services/events.js';
import { BulkTagInput, CreateFunnelInput, ListQuery, UpdateFunnelInput } from '../services/funnels.js';
import { LeadQuery, SubmitInput } from '../services/leads.js';
import { CheckoutInput, OrderQuery } from '../services/orders.js';
import { SaveInput } from '../services/pages.js';
import { LimitedQuery, ListEntryInput, TierInput, WhoInput } from './ratelimits.js';
import { ReorderInput, StepInput, StepPatch, ValidatePathInput } from '../services/steps.js';
import { TagInput } from '../services/tags.js';
import { CategoryInput, CustomBlockInput, TemplateCreate, TemplatePatch, TemplateQuery } from '../services/templates.js';
import { WebhookInput, WebhookPatch } from '../services/webhooks.js';
import { LoginInput, MemberPatch, PasswordChange, RegisterInput, WorkspacePatch } from '../services/accounts.js';
import { ApiKeyInput, ApiKeyPatch } from '../services/apikeys.js';
import { ApiListQuery, ApiRangeQuery, ExportQuery, TimeseriesQuery } from '../services/analyticsapi.js';
import { AuditQuery } from '../services/audit.js';
import { AcceptInput, InvitationInput, LookupQuery } from '../services/invitations.js';
import { ForgotInput, ResetInput } from '../services/recovery.js';
import { RoleInput, RolePatch } from '../services/roles.js';
import { CodeInput, ConfirmInput, VerifyLoginInput } from '../services/twofactor.js';
import { RefreshInput } from './auth.js';

/**
 * THE route declaration. One row per HTTP operation, read by:
 *  - the rate limiter (which policies apply, at which cost, scoped how),
 *  - the OpenAPI generator (`npm run docs:api` -> docs/openapi.json),
 *  - tests that fail when a route exists without a row, a row without a route, a non-public route that answers without credentials,
 *    a role-gated route that answers a lower role, or a route without a limiter policy.
 * Adding a route means adding its row here.
 */
export type Auth = 'public' | 'user' | 'apikey' | 'platform' | 'edge' | 'infra';

export interface Operation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: Auth;
  /** Required for `auth: 'user'` rows (see auth/permissions.ts). Absent on public, edge, infra and platform rows. */
  permission?: Permission | 'any';
  /** Further permissions the route needs on top of `permission` (all are required; enforced centrally). */
  also?: Permission[];
  /** For `auth: 'apikey'` rows: the scope the API key must carry. */
  apiScope?: 'analytics:read' | 'analytics:export';
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
const KEY_READ = ['ip.global', 'analytics.read', 'analytics.workspace'];
const KEY_EXPORT = ['ip.global', 'analytics.export', 'analytics.workspace'];
const WRITE = ['ip.global', 'api.write', 'api.workspace'];

type Extra = Partial<Pick<Operation, 'body' | 'query' | 'cost' | 'inHandler' | 'scope' | 'status' | 'notes' | 'also'>> & { limits?: string[] };

const make = (method: Operation['method'], path: string, auth: Auth, tag: string, summary: string, x: Extra = {}): Operation => {
  const { limits, ...rest } = x;
  return { method, path, auth, tag, summary, limits: limits ?? (method === 'GET' ? READ : WRITE), ...rest };
};

/** An authenticated route. `permission` is the one permission it needs (`any`: every signed-in member), enforced centrally by authenticate(). */
const A = (m: Operation['method'], p: string, permission: Permission | 'any', tag: string, s: string, x?: Extra): Operation => ({ ...make(m, p, 'user', tag, s, x), permission });
const PLATFORM = (m: Operation['method'], p: string, tag: string, s: string, x?: Extra) => make(m, p, 'platform', tag, s, { limits: ['ip.global', 'admin.platform', 'api.workspace'], ...x });

/** A route called with an API key (not a user session): `apiScope` is the scope the key must carry. */
const K = (path: string, apiScope: 'analytics:read' | 'analytics:export', summary: string, x: Extra = {}): Operation => ({ ...make('GET', path, 'apikey', 'analytics-api', summary, { limits: apiScope === 'analytics:export' ? KEY_EXPORT : KEY_READ, ...x }), apiScope });

export const OPERATIONS: Operation[] = [
  // infrastructure
  { method: 'GET', path: '/healthz', auth: 'infra', tag: 'ops', summary: 'Liveness probe', limits: [], exempt: 'Orchestrator probe; no data, must answer under any load' },
  { method: 'GET', path: '/readyz', auth: 'infra', tag: 'ops', summary: 'Readiness: database reachable, buffer depth, migrations applied', limits: [], exempt: 'Orchestrator probe' },
  { method: 'GET', path: '/metrics', auth: 'infra', tag: 'ops', summary: 'Prometheus metrics (Bearer METRICS_TOKEN when set)', limits: [], exempt: 'Scraper; protected by METRICS_TOKEN' },
  { method: 'GET', path: '/beacon.js', auth: 'public', tag: 'public', summary: 'Tracking beacon script (cacheable)', limits: ['ip.global'] },
  { method: 'GET', path: '/internal/edge/resolve', auth: 'edge', tag: 'edge', summary: 'Signed resolve call from the Cloudflare worker', limits: ['edge.resolve'], notes: 'HMAC over timestamp, nonce, method and path; fails closed without EDGE_SHARED_SECRET.' },
  { method: 'POST', path: '/internal/edge/events', auth: 'edge', tag: 'edge', summary: 'Batch of beacon events forwarded by the edge queue consumer (up to 500)', limits: ['edge.resolve'], inHandler: ['ingest.workspace'], status: 200, notes: 'Events of a workspace over its ingest quota are counted in `limited` and dropped; the rest of the batch is unaffected. Signed like /internal/edge/resolve. Body `{events:[{id,at,ua,body}]}`; each `body` is validated as a public event. Replays of the same `id`/`at` are dropped. 503 INGEST_BACKPRESSURE tells the queue to retry later.' },
  { method: 'GET', path: '/preview/:funnelId', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel (first step)', limits: ['ip.global', 'public.preview'], notes: 'Authorised by a short-lived token in ?token=.' },
  { method: 'GET', path: '/preview/:funnelId/*', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel step', limits: ['ip.global', 'public.preview'] },
  // public ingestion
  { method: 'POST', path: '/api/public/events', auth: 'public', tag: 'public', summary: 'Record a page view or opt-in (accepted into a write-behind buffer)', body: PublicEventInput, limits: ['ip.global'], inHandler: ['public.events', 'ingest.workspace'], status: 202, notes: 'Keyed by IP and the funnelId in the body.' },
  { method: 'POST', path: '/api/public/forms/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Submit a lead form', body: SubmitInput, limits: ['ip.global', 'public.forms'], scope: 'funnelId' },
  { method: 'POST', path: '/api/public/checkout/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Checkout (main offer, bumps, one-click upsell)', body: CheckoutInput, limits: ['ip.global', 'public.checkout'], scope: 'funnelId' },
  // auth and account
  make('POST', '/api/auth/register', 'public', 'auth', 'Create an account and its workspace', { body: RegisterInput, limits: ['ip.global', 'auth.attempts'], status: 201 }),
  make('POST', '/api/auth/login', 'public', 'auth', 'Log in', { body: LoginInput, limits: ['ip.global', 'auth.attempts'], inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  make('POST', '/api/auth/refresh', 'public', 'auth', 'Exchange a refresh token for a new access and refresh token (rotation; reuse revokes the session)', { body: RefreshInput, limits: ['ip.global', 'auth.refresh'] }),
  make('POST', '/api/auth/2fa/verify', 'public', 'auth', 'Complete a sign-in with a TOTP or recovery code', { body: VerifyLoginInput, limits: ['ip.global', 'auth.attempts'], inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  make('POST', '/api/auth/password/forgot', 'public', 'auth', 'Request a password reset mail (same answer for unknown addresses)', { body: ForgotInput, limits: ['ip.global', 'auth.reset'], inHandler: ['auth.reset.email'] }),
  make('POST', '/api/auth/password/reset', 'public', 'auth', 'Set a new password with a reset token; ends all sessions', { body: ResetInput, limits: ['ip.global', 'auth.reset'] }),
  make('GET', '/api/auth/invitations/lookup', 'public', 'auth', 'What an invitation link is for (email, workspace, role)', { query: LookupQuery, limits: ['ip.global', 'auth.attempts'] }),
  make('POST', '/api/auth/invitations/accept', 'public', 'auth', 'Accept an invitation: creates the account and signs it in', { body: AcceptInput, limits: ['ip.global', 'auth.attempts'], status: 201 }),
  A('GET', '/api/auth/me', 'any', 'auth', 'Current user, role, permissions and workspace'),
  A('POST', '/api/auth/logout', 'any', 'auth', 'Sign out: ends this session', { status: 204 }),
  A('GET', '/api/auth/sessions', 'any', 'auth', 'Your active sessions'),
  A('DELETE', '/api/auth/sessions/:id', 'any', 'auth', 'End one of your sessions', { status: 204 }),
  A('POST', '/api/auth/sessions/revoke-others', 'any', 'auth', 'End all your other sessions'),
  A('POST', '/api/auth/password', 'any', 'auth', 'Change your password (ends your other sessions)', { body: PasswordChange, inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  A('POST', '/api/auth/2fa/setup', 'any', 'auth', 'Start TOTP enrolment: secret and otpauth URI'),
  A('POST', '/api/auth/2fa/enable', 'any', 'auth', 'Confirm enrolment with the first code; returns recovery codes once', { body: CodeInput }),
  A('POST', '/api/auth/2fa/disable', 'any', 'auth', 'Turn 2FA off (password and a code required)', { body: ConfirmInput, inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  A('POST', '/api/auth/2fa/recovery-codes', 'any', 'auth', 'Replace the recovery codes (password and a code required)', { body: ConfirmInput, inHandler: ['auth.failures.account', 'auth.failures.ip'] }),
  A('POST', '/api/events/ticket', 'any', 'events', 'Short-lived ticket for the SSE stream', { limits: READ }),
  A('GET', '/api/events/stream', 'any', 'events', 'Server-sent events for the workspace', { inHandler: ['api.stream'], notes: 'Bearer header or ?ticket=.' }),
  A('GET', '/api/workspace', 'any', 'workspace', 'Workspace details'),
  A('PATCH', '/api/workspace', 'workspace:manage', 'workspace', 'Rename the workspace, toggle custom scripts', { body: WorkspacePatch }),
  A('GET', '/api/members', 'members:read', 'workspace', 'List members'),
  A('PATCH', '/api/members/:id', 'members:manage', 'workspace', 'Change a member role (you can only grant permissions you hold; a workspace keeps at least one owner)', { body: MemberPatch }),
  A('POST', '/api/members/:id/reset-2fa', 'members:manage', 'workspace', 'Remove a member second factor and end their sessions (account recovery)'),
  A('GET', '/api/invitations', 'members:read', 'workspace', 'Invitations with status'),
  A('POST', '/api/invitations', 'members:manage', 'workspace', 'Invite an email address with a role; the one-time link is mailed (returned to you when no mail transport delivers it)', { body: InvitationInput, status: 201 }),
  A('POST', '/api/invitations/:id/resend', 'members:manage', 'workspace', 'New link and expiry for a pending invitation'),
  A('DELETE', '/api/invitations/:id', 'members:manage', 'workspace', 'Revoke an invitation', { status: 204 }),
  A('GET', '/api/permissions', 'any', 'workspace', 'The permission catalogue'),
  A('GET', '/api/roles', 'members:read', 'workspace', 'Built-in and custom roles with their permissions and member counts'),
  A('POST', '/api/roles', 'roles:manage', 'workspace', 'Create a custom role (only permissions you hold)', { body: RoleInput, status: 201 }),
  A('PATCH', '/api/roles/:id', 'roles:manage', 'workspace', 'Edit a custom role (you must hold all its old and new permissions)', { body: RolePatch }),
  A('DELETE', '/api/roles/:id', 'roles:manage', 'workspace', 'Delete an unused custom role', { status: 204 }),
  A('GET', '/api/audit', 'audit:read', 'workspace', 'Audit log, newest first (cursor pagination)', { query: AuditQuery }),
  A('DELETE', '/api/members/:id', 'members:manage', 'workspace', 'Remove a member', { status: 204 }),
  // funnels
  A('GET', '/api/funnels', 'funnels:read', 'funnels', 'List funnels (page/limit, search, filters)', { query: ListQuery }),
  A('GET', '/api/funnels/filters', 'funnels:read', 'funnels', 'Filter counts'),
  A('GET', '/api/funnels/trash', 'funnels:read', 'funnels', 'Funnels in the trash'),
  A('POST', '/api/funnels', 'funnels:write', 'funnels', 'Create a funnel', { body: CreateFunnelInput, status: 201 }),
  A('POST', '/api/funnels/validate-path', 'funnels:write', 'funnels', 'Check a step path for format and collisions', { body: ValidatePathInput }),
  A('POST', '/api/funnels/bulk-tag', 'funnels:write', 'funnels', 'Add/remove tags on several funnels', { body: BulkTagInput }),
  A('GET', '/api/funnels/:id', 'funnels:read', 'funnels', 'Funnel with steps and stats'),
  A('PATCH', '/api/funnels/:id', 'funnels:write', 'funnels', 'Update a funnel (status, domain, tags, tracking code)', { body: UpdateFunnelInput }),
  A('PUT', '/api/funnels/:id', 'funnels:write', 'funnels', 'Same as PATCH', { body: UpdateFunnelInput }),
  A('DELETE', '/api/funnels/:id', 'funnels:delete', 'funnels', 'Move a funnel to the trash', { status: 204 }),
  A('POST', '/api/funnels/:id/restore', 'funnels:delete', 'funnels', 'Restore from the trash'),
  A('DELETE', '/api/funnels/:id/purge', 'funnels:purge', 'funnels', 'Permanently delete a trashed funnel', { status: 204 }),
  A('POST', '/api/funnels/:id/duplicate', 'funnels:write', 'funnels', 'Duplicate a funnel', { status: 201, cost: 3 }),
  A('POST', '/api/funnels/:id/preview-token', 'funnels:read', 'funnels', 'Mint a signed preview token'),
  A('GET', '/api/funnels/:id/analytics', 'analytics:read', 'analytics', 'Funnel analytics for a date range and time zone', { query: AnalyticsQuery }),
  A('GET', '/api/funnels/:id/steps', 'funnels:read', 'steps', 'Steps of a funnel'),
  A('POST', '/api/funnels/:id/steps', 'funnels:write', 'steps', 'Add a step', { body: StepInput, status: 201 }),
  A('PUT', '/api/funnels/:id/steps/order', 'funnels:write', 'steps', 'Reorder all steps', { body: ReorderInput }),
  A('PATCH', '/api/funnels/:id/steps/:sid', 'funnels:write', 'steps', 'Update step settings', { body: StepPatch }),
  A('DELETE', '/api/funnels/:id/steps/:sid', 'funnels:write', 'steps', 'Delete a step', { status: 204 }),
  A('POST', '/api/funnels/:id/steps/:sid/duplicate', 'funnels:write', 'steps', 'Duplicate a step', { status: 201 }),
  A('GET', '/api/funnels/:id/steps/:sid/analytics', 'analytics:read', 'analytics', 'Step analytics', { query: AnalyticsQuery }),
  A('GET', '/api/funnels/:id/steps/:sid/page', 'funnels:read', 'pages', 'Page document and version'),
  A('PUT', '/api/funnels/:id/steps/:sid/page', 'funnels:write', 'pages', 'Save the page document (optimistic concurrency on `version`)', { body: SaveInput, cost: 2 }),
  A('GET', '/api/funnels/:id/steps/:sid/backups', 'funnels:read', 'pages', 'Page backups'),
  A('GET', '/api/funnels/:id/steps/:sid/backups/:bid', 'funnels:read', 'pages', 'One backup'),
  A('POST', '/api/funnels/:id/steps/:sid/backups/:bid/restore', 'funnels:write', 'pages', 'Restore a backup', { cost: 2 }),
  // tags
  A('GET', '/api/tags', 'funnels:read', 'tags', 'List tags'),
  A('POST', '/api/tags', 'tags:manage', 'tags', 'Create a tag', { body: TagInput, status: 201 }),
  A('PUT', '/api/tags/:id', 'tags:manage', 'tags', 'Rename a tag', { body: TagInput }),
  A('DELETE', '/api/tags/:id', 'tags:manage', 'tags', 'Delete a tag', { status: 204 }),
  A('DELETE', '/api/tags', 'tags:manage', 'tags', 'Delete several tags (?ids=a,b)'),
  // domains
  A('GET', '/api/domains', 'domains:read', 'domains', 'List domains'),
  A('GET', '/api/domains/:id', 'domains:read', 'domains', 'One domain with DNS instructions'),
  A('GET', '/api/domains/:id/routes', 'domains:read', 'domains', 'Step paths served on the domain'),
  A('POST', '/api/domains', 'domains:manage', 'domains', 'Add a domain', { body: DomainInput, status: 201 }),
  A('POST', '/api/domains/:id/verify', 'domains:manage', 'domains', 'Run the DNS check now', { cost: 5 }),
  A('PUT', '/api/domains/:id/default-pages', 'domains:manage', 'domains', 'Set the domain home and 404 steps', { body: DefaultPagesInput }),
  A('DELETE', '/api/domains/:id', 'domains:manage', 'domains', 'Delete a domain (funnels revert to test)', { status: 204 }),
  // leads, orders
  A('GET', '/api/leads', 'leads:read', 'leads', 'List leads', { query: LeadQuery }),
  A('GET', '/api/leads/export', 'leads:export', 'leads', 'CSV export (streamed, newest first)', { query: LeadQuery, cost: 5, inHandler: ['api.export'] }),
  A('GET', '/api/orders', 'orders:read', 'orders', 'List orders', { query: OrderQuery }),
  A('GET', '/api/orders/export', 'orders:export', 'orders', 'CSV export (streamed)', { query: OrderQuery, cost: 5, inHandler: ['api.export'] }),
  A('GET', '/api/orders/:id', 'orders:read', 'orders', 'One order'),
  // webhooks
  A('GET', '/api/webhooks', 'webhooks:manage', 'webhooks', 'List webhooks'),
  A('POST', '/api/webhooks', 'webhooks:manage', 'webhooks', 'Create a webhook (secret shown once)', { body: WebhookInput, status: 201 }),
  A('PATCH', '/api/webhooks/:id', 'webhooks:manage', 'webhooks', 'Update a webhook', { body: WebhookPatch }),
  A('DELETE', '/api/webhooks/:id', 'webhooks:manage', 'webhooks', 'Delete a webhook', { status: 204 }),
  A('POST', '/api/webhooks/:id/rotate-secret', 'webhooks:manage', 'webhooks', 'Rotate the signing secret'),
  A('POST', '/api/webhooks/:id/test', 'webhooks:manage', 'webhooks', 'Queue a test delivery', { status: 202 }),
  A('GET', '/api/webhooks/:id/deliveries', 'webhooks:manage', 'webhooks', 'Delivery log'),
  A('POST', '/api/webhooks/deliveries/:did/retry', 'webhooks:manage', 'webhooks', 'Retry a delivery'),
  // notifications
  A('GET', '/api/notifications', 'any', 'notifications', 'Notification feed'),
  A('POST', '/api/notifications/read-all', 'any', 'notifications', 'Mark all read', { status: 204 }),
  A('POST', '/api/notifications/:id/read', 'any', 'notifications', 'Mark one read', { status: 204 }),
  // templates and blocks
  A('GET', '/api/templates', 'funnels:read', 'templates', 'List templates', { query: TemplateQuery }),
  A('GET', '/api/templates/categories', 'funnels:read', 'templates', 'Template categories'),
  A('GET', '/api/templates/:id', 'funnels:read', 'templates', 'One template with step documents'),
  A('POST', '/api/templates/:id/use', 'funnels:write', 'templates', 'Create a funnel from a template', { status: 201, cost: 3 }),
  A('GET', '/api/blocks', 'funnels:read', 'blocks', 'Saved custom blocks'),
  A('POST', '/api/blocks', 'blocks:manage', 'blocks', 'Save a custom block', { body: CustomBlockInput, status: 201 }),
  A('DELETE', '/api/blocks/:id', 'blocks:manage', 'blocks', 'Delete a custom block', { status: 204 }),
  PLATFORM('POST', '/api/admin/templates', 'admin', 'Publish a funnel as a global template (PLATFORM_ADMIN_EMAILS)', { body: TemplateCreate, status: 201 }),
  PLATFORM('PATCH', '/api/admin/templates/:id', 'admin', 'Edit a template', { body: TemplatePatch }),
  PLATFORM('DELETE', '/api/admin/templates/:id', 'admin', 'Delete a template', { status: 204 }),
  PLATFORM('POST', '/api/admin/template-categories', 'admin', 'Create a template category', { body: CategoryInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/template-categories/:id', 'admin', 'Delete a template category', { status: 204 }),
  PLATFORM('GET', '/api/admin/rate-limits', 'admin', 'Recently limited subjects, block/allow lists and the policy table', { query: LimitedQuery }),
  PLATFORM('POST', '/api/admin/rate-limits/blocks', 'admin', 'Block an ip, workspace or user for a TTL', { body: ListEntryInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/rate-limits/blocks', 'admin', 'Lift a block (and clear its penalty box)', { body: WhoInput, status: 204 }),
  PLATFORM('POST', '/api/admin/rate-limits/allows', 'admin', 'Allow-list a client for a TTL (bypasses its limits)', { body: ListEntryInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/rate-limits/allows', 'admin', 'Remove an allow-list entry', { body: WhoInput, status: 204 }),
  PLATFORM('PUT', '/api/admin/workspaces/:id/rate-tier', 'admin', 'Override a workspace plan or rate multiplier', { body: TierInput }),
  // analytics API v1 (docs/ANALYTICS-API.md): API-key authenticated
  K('/api/v1/analytics/funnels', 'analytics:read', 'Funnels with totals for a range (cursor pagination)', { query: ApiListQuery }),
  K('/api/v1/analytics/funnels/:id/steps', 'analytics:read', 'Per-step totals, rates and exit rate for a funnel', { query: ApiRangeQuery }),
  K('/api/v1/analytics/funnels/:id/timeseries', 'analytics:read', 'Zero-filled time series of one metric, bucketed by hour, day, week or month in a time zone', { query: TimeseriesQuery }),
  K('/api/v1/analytics/schema', 'analytics:read', 'JSON Schemas of every response and export line, with schema_version'),
  K('/api/v1/analytics/export/events', 'analytics:export', 'Events as NDJSON, one page per request (X-Next-Cursor), PII-free keys', { query: ExportQuery, notes: 'Lines are keyed with HMAC of the workspace identity pepper (visitor_key, contact_key); raw emails never appear.' }),
  K('/api/v1/analytics/export/leads', 'analytics:export', 'Leads as NDJSON, one page per request (X-Next-Cursor), PII-free keys', { query: ExportQuery }),
  K('/api/v1/analytics/export/funnel-structure', 'analytics:export', 'Funnels with their steps: block counts, word counts, order bump and upsell flags', { query: ApiListQuery }),
  // API keys and the identity pepper: managed by people with a session
  A('GET', '/api/v1/api-keys', 'api_keys:manage', 'api-keys', 'API keys (prefix, scopes, last use; never the secret)'),
  A('POST', '/api/v1/api-keys', 'api_keys:manage', 'api-keys', 'Create an API key; the secret is returned once', { body: ApiKeyInput, status: 201 }),
  A('PATCH', '/api/v1/api-keys/:id', 'api_keys:manage', 'api-keys', 'Rename, set the expiry or the IP allow-list of a key', { body: ApiKeyPatch }),
  A('DELETE', '/api/v1/api-keys/:id', 'api_keys:manage', 'api-keys', 'Revoke a key', { status: 204 }),
  A('GET', '/api/v1/analytics/identity-pepper', 'analytics_identity:manage', 'api-keys', 'The workspace identity pepper (a secret, shown to people only)', { also: ['analytics:export'] }),
  A('POST', '/api/v1/analytics/identity-pepper/rotate', 'analytics_identity:manage', 'api-keys', 'Replace the pepper: exported keys change, so consumers must adopt the new one', { also: ['analytics:export'] }),
  // AI
  A('GET', '/api/ai/status', 'ai:use', 'ai', 'Provider and daily usage'),
  A('POST', '/api/ai/funnel', 'ai:use', 'ai', 'Generate a funnel', { body: ai.FunnelRequest, status: 201, limits: ['ip.global', 'api.write', 'api.workspace'], inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/rewrite', 'ai:use', 'ai', 'Rewrite copy', { body: ai.RewriteRequest, inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/headlines', 'ai:use', 'ai', 'Headline variants', { body: ai.HeadlineRequest, inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/insights', 'ai:use', 'ai', 'Analytics insights', { body: ai.InsightRequest, inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/alt-text', 'ai:use', 'ai', 'Alt text for an image', { body: ai.AltTextRequest, inHandler: ['ai.minute', 'ai.daily'] }),
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
