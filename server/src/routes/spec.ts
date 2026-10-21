import type { ZodType } from 'zod';
import type { Permission } from '../auth/permissions.js';
import * as ai from '../ai/service.js';
import * as aiBuild from '../ai/builder/service.js';
import * as aiEdit from '../ai/builder/edit.js';
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
import { CategoryInput, CustomBlockInput, TemplateCreate, TemplateDetailQuery, TemplateHtmlQuery, TemplatePatch, TemplateQuery, UseTemplateInput } from '../services/templates.js';
import { TemplateImport } from '../services/templateio.js';
import { WebhookInput, WebhookPatch } from '../services/webhooks.js';
import { LoginInput, MemberPatch, PasswordChange, RegisterInput, WorkspacePatch } from '../services/accounts.js';
import { ApiKeyInput, ApiKeyPatch } from '../services/apikeys.js';
import { ApiListQuery, ApiRangeQuery, ExportQuery, PepperInput, TimeseriesQuery } from '../services/analyticsapi.js';
import { SubscribeInput } from '../services/billing.js';
import { RefundInput } from '../services/stripepay.js';
import { PriceInput, PricePatch, ProductInput, ProductPatch, ProductQuery } from '../services/catalog.js';
import { PaymentSettingsPatch } from '../services/paymentsettings.js';
import { WizardInput } from '../services/paymentswizard.js';
import { ProductsExportQuery, ProductsQuery } from '../services/productanalytics.js';
import { SummaryRequest } from '../services/analyticssummary.js';
import { ApiProductsQuery } from '../services/analyticsproducts.js';
import { DisputeQuery } from '../services/disputes.js';
import { AuditQuery } from '../services/audit.js';
import { AcceptInput, InvitationInput, LookupQuery } from '../services/invitations.js';
import { ForgotInput, ResetInput } from '../services/recovery.js';
import { RoleInput, RolePatch } from '../services/roles.js';
import { CodeInput, ConfirmInput, VerifyLoginInput } from '../services/twofactor.js';
import { RefreshInput } from './auth.js';
import { AdminAddInput, DeleteWorkspaceInput, ImpersonateInput, PlatformAuditQuery, SuspendInput, WorkspaceQuery } from '../services/admin.js';
import { AnnouncementInput, AnnouncementPatch } from '../services/announcements.js';
import { FlagInput, OverrideInput } from '../services/flags.js';
import { SubjectInput } from '../services/gdpr.js';
import { AttributionInput } from '../services/attribution.js';
import { ImportQuery, MapInput, SpendInput, SpendQuery } from '../services/adspend.js';
import { AdsQuery, AttributionQuery } from '../services/adsreport.js';
import { DeliveryQuery, IntegrationInput, IntegrationPatch } from '../services/integrations.js';
import { PixelSettings } from '../ads/pixelConfig.js';
import { ApiAdsQuery, ApiAttributionQuery } from '../services/analyticsapi.js';
import { ConnectInput, SettingsInput, UnpublishInput } from '../services/publishing.js';
import { DisconnectQuery } from './publishing.js';

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
  { method: 'GET', path: '/uploads/:id/:name', auth: 'public', tag: 'public', summary: 'An image uploaded in the page builder (immutable, cacheable)', limits: ['ip.global', 'public.page'], notes: 'Also served on customer domains (passthrough and edge worker).' },
  { method: 'GET', path: '/uploads/:id', auth: 'public', tag: 'public', summary: 'An uploaded image without a file name', limits: ['ip.global', 'public.page'] },
  { method: 'GET', path: '/preview/:funnelId', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel (first step)', limits: ['ip.global', 'public.preview'], notes: 'Authorised by a short-lived token in ?token=.' },
  { method: 'GET', path: '/preview/:funnelId/*', auth: 'public', tag: 'public', summary: 'Signed preview of a funnel step', limits: ['ip.global', 'public.preview'] },
  // public ingestion
  { method: 'POST', path: '/api/public/events', auth: 'public', tag: 'public', summary: 'Record a page view or opt-in (accepted into a write-behind buffer)', body: PublicEventInput, limits: ['ip.global'], inHandler: ['public.events', 'ingest.workspace'], status: 202, notes: 'Keyed by IP and the funnelId in the body.' },
  { method: 'POST', path: '/api/public/forms/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Submit a lead form', body: SubmitInput, limits: ['ip.global', 'public.forms'], scope: 'funnelId' },
  { method: 'POST', path: '/api/public/checkout/:funnelId/:stepId/:blockId', auth: 'public', tag: 'public', summary: 'Checkout (main offer, bumps, one-click upsell)', body: CheckoutInput, limits: ['ip.global', 'public.checkout'], scope: 'funnelId' },
  { method: 'POST', path: '/api/public/attribution', auth: 'public', tag: 'public', summary: 'Record a visitor\'s marketing touch (UTM parameters, click ids, referrer) and browser ids for ad attribution and server-side conversions', body: AttributionInput, limits: ['ip.global'], inHandler: ['public.events', 'ingest.workspace'], status: 202, notes: 'Every value is validated and length-capped; the workspace is derived from the funnel. Bots and previews are ignored.' },
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
  A('GET', '/api/funnels/:id/analytics/products', 'analytics:read', 'analytics', 'Product analytics of one funnel (see /api/analytics/products)', { query: ProductsQuery }),
  A('GET', '/api/analytics/products', 'analytics:read', 'analytics', 'Product analytics for a date range and time zone: per product and currency orders, units, gross, refunded, disputed lost, net, AOV, refund rate, checkout conversion, bump and upsell take rates, new and repeat customers, zero-filled revenue series, top funnels and steps', { query: ProductsQuery }),
  A('GET', '/api/analytics/products/export', 'analytics:read', 'analytics', 'The product table as CSV (formula-injection neutralised)', { query: ProductsExportQuery, cost: 5 }),
  A('POST', '/api/analytics/summary', 'analytics:read', 'analytics', 'Summarise a period for the workspace, one funnel or one product: a short narrative and 3 prioritised actions grounded only in numbers computed from SQL (every number in the text is verified against that evidence; otherwise the deterministic narrator writes it)', { also: ['ai:use'], body: SummaryRequest, inHandler: ['ai.minute', 'ai.daily'] }),
  A('GET', '/api/funnels/:id/steps/:sid/analytics', 'analytics:read', 'analytics', 'Step analytics', { query: AnalyticsQuery }),
  A('GET', '/api/funnels/:id/steps/:sid/page', 'funnels:read', 'pages', 'Page document and version'),
  A('PUT', '/api/funnels/:id/steps/:sid/page', 'funnels:write', 'pages', 'Save the page document (optimistic concurrency on `version`)', { body: SaveInput, cost: 2 }),
  A('GET', '/api/funnels/:id/steps/:sid/html', 'funnels:read', 'pages', 'The stored, published HTML of a step (for thumbnails and previews; show it in a sandboxed iframe)'),
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
  A('GET', '/api/templates', 'funnels:read', 'templates', 'The template gallery: filters (category, industry, goal, tag, checkout), search, pages and facet counts; ETag', { query: TemplateQuery }),
  A('GET', '/api/templates/categories', 'funnels:read', 'templates', 'Template categories'),
  A('GET', '/api/templates/:id/html', 'funnels:read', 'templates', 'A template step rendered as a standalone page, for previews (`?step=1`); show it in a sandboxed iframe', { query: TemplateHtmlQuery }),
  A('GET', '/api/templates/:id', 'funnels:read', 'templates', 'One template: steps, product slots, thumbnail and the first step rendered as an inert preview (`?docs=true` adds the step documents); ETag', { query: TemplateDetailQuery }),
  A('POST', '/api/templates/:id/use', 'funnels:write', 'templates', 'Create a funnel from a template; `bindings` attach the template product slots to catalog prices (or create them from the template defaults)', { body: UseTemplateInput, status: 201, cost: 3, notes: 'The body is optional.' }),
  A('GET', '/api/blocks', 'funnels:read', 'blocks', 'Saved custom blocks'),
  A('POST', '/api/blocks', 'blocks:manage', 'blocks', 'Save a custom block', { body: CustomBlockInput, status: 201 }),
  A('DELETE', '/api/blocks/:id', 'blocks:manage', 'blocks', 'Delete a custom block', { status: 204 }),
  A('GET', '/api/assets', 'funnels:read', 'assets', 'Uploaded images of the workspace and the upload limits'),
  A('POST', '/api/assets', 'funnels:write', 'assets', 'Upload an image (multipart field `file`, or the raw image as the body with ?name=). PNG, JPEG, GIF or WebP, decided by content, at most 1.5 MB', { status: 201, cost: 2 }),
  A('DELETE', '/api/assets/:id', 'funnels:write', 'assets', 'Delete an uploaded image', { status: 204 }),
  PLATFORM('POST', '/api/admin/templates', 'admin', 'Publish a funnel as a global template (PLATFORM_ADMIN_EMAILS)', { body: TemplateCreate, status: 201 }),
  PLATFORM('POST', '/api/admin/templates/import', 'admin', 'Import a template from JSON (the export format): validated like a page save, size limited; `onConflict: "replace"` replaces a template with the same slug', { body: TemplateImport, status: 201 }),
  PLATFORM('GET', '/api/admin/templates/:id/export', 'admin', 'Export a template as a JSON file (a valid import)'),
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
  PLATFORM('GET', '/api/admin/stats', 'admin', 'Platform counters: workspaces, users, funnels, dead jobs', { limits: ['ip.global', 'admin.platform', 'api.workspace'] }),
  PLATFORM('GET', '/api/admin/admins', 'admin', 'Platform administrators'),
  PLATFORM('POST', '/api/admin/admins', 'admin', 'Make an existing user a platform administrator', { body: AdminAddInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/admins/:userId', 'admin', 'Remove a platform administrator (not one listed in PLATFORM_ADMIN_EMAILS, not yourself)', { status: 204 }),
  PLATFORM('GET', '/api/admin/workspaces', 'admin', 'Search workspaces (name, id, member email), filter by status, keyset pages', { query: WorkspaceQuery }),
  PLATFORM('GET', '/api/admin/workspaces/:id', 'admin', 'One workspace: plan, usage, members, flag overrides, recent audit'),
  PLATFORM('POST', '/api/admin/workspaces/:id/suspend', 'admin', 'Suspend a workspace: sign members out, stop serving, refuse public writes and API keys, purge the edge cache', { body: SuspendInput }),
  PLATFORM('POST', '/api/admin/workspaces/:id/unsuspend', 'admin', 'Lift a suspension'),
  PLATFORM('POST', '/api/admin/workspaces/:id/impersonate', 'admin', 'Open a time-limited, READ-ONLY support session as the workspace owner or a given member (reason required, audited in the workspace); allow_writes needs the superadmin role and a 20-character reason', { body: ImpersonateInput, status: 201 }),
  PLATFORM('DELETE', '/api/admin/workspaces/:id', 'admin', 'Permanently delete a suspended workspace and all its data (name must be typed)', { body: DeleteWorkspaceInput, status: 204 }),
  PLATFORM('GET', '/api/admin/workspaces/:id/export', 'admin', 'Export a workspace as NDJSON (members, funnels, pages, leads, orders, audit; no events)', { notes: 'Streamed in keyset pages of 1000 rows; memory does not grow with the workspace.' }),
  PLATFORM('GET', '/api/admin/queues', 'admin', 'Queue inspector: jobs by status and type, outbox backlog, event bus lag and dead letters, webhook deliveries'),
  PLATFORM('GET', '/api/admin/queues/dead-jobs', 'admin', 'Dead jobs with their last error'),
  PLATFORM('GET', '/api/admin/queues/dead-letters', 'admin', 'Dead letters of the event bus consumer groups this installation runs'),
  PLATFORM('POST', '/api/admin/queues/jobs/:id/retry', 'admin', 'Re-queue a dead job'),
  PLATFORM('DELETE', '/api/admin/queues/jobs/:id', 'admin', 'Discard a dead job', { status: 204 }),
  PLATFORM('GET', '/api/admin/flags', 'admin', 'Feature flags (built-in and stored)'),
  PLATFORM('PUT', '/api/admin/flags/:key', 'admin', 'Create or change a flag: description, default, rollout percentage', { body: FlagInput }),
  PLATFORM('DELETE', '/api/admin/flags/:key', 'admin', 'Delete a stored flag and its overrides', { status: 204 }),
  PLATFORM('PUT', '/api/admin/flags/:key/workspaces/:id', 'admin', 'Override a flag for one workspace (enabled: null removes the override)', { body: OverrideInput }),
  PLATFORM('GET', '/api/admin/announcements', 'admin', 'All announcements'),
  PLATFORM('POST', '/api/admin/announcements', 'admin', 'Publish an announcement (banner for every signed-in user)', { body: AnnouncementInput, status: 201 }),
  PLATFORM('PATCH', '/api/admin/announcements/:id', 'admin', 'Edit an announcement', { body: AnnouncementPatch }),
  PLATFORM('DELETE', '/api/admin/announcements/:id', 'admin', 'Delete an announcement', { status: 204 }),
  PLATFORM('GET', '/api/admin/audit', 'admin', 'Platform-wide audit log with filters and keyset paging', { query: PlatformAuditQuery }),
  PLATFORM('POST', '/api/admin/gdpr/export', 'admin', 'Everything held about one email address (leads, orders, checkout sessions)', { body: SubjectInput }),
  PLATFORM('POST', '/api/admin/gdpr/erase', 'admin', 'Erase one email address: delete leads, anonymise orders and checkout sessions, scrub notifications and webhook payloads', { body: SubjectInput }),
  A('GET', '/api/announcements', 'any', 'notices', 'Active announcements you have not dismissed'),
  A('POST', '/api/announcements/:id/dismiss', 'any', 'notices', 'Dismiss an announcement (critical ones cannot be dismissed)', { status: 204 }),
  A('GET', '/api/workspace/flags', 'any', 'notices', 'Evaluated feature flags for your workspace'),
  // analytics API v1 (docs/ANALYTICS-API.md): API-key authenticated
  K('/api/v1/analytics/funnels', 'analytics:read', 'Funnels with totals for a range (cursor pagination)', { query: ApiListQuery }),
  K('/api/v1/analytics/funnels/:id/steps', 'analytics:read', 'Per-step totals, rates and exit rate for a funnel', { query: ApiRangeQuery }),
  K('/api/v1/analytics/funnels/:id/timeseries', 'analytics:read', 'Zero-filled time series of one metric, bucketed by hour, day, week or month in a time zone', { query: TimeseriesQuery }),
  K('/api/v1/analytics/schema', 'analytics:read', 'JSON Schemas of every response and export line, with schema_version'),
  K('/api/v1/analytics/export/events', 'analytics:export', 'Events as NDJSON, one page per request (X-Next-Cursor), PII-free keys', { query: ExportQuery, notes: 'Lines are keyed with HMAC of the workspace identity pepper (visitor_key, contact_key); raw emails never appear.' }),
  K('/api/v1/analytics/export/leads', 'analytics:export', 'Leads as NDJSON, one page per request (X-Next-Cursor), PII-free keys', { query: ExportQuery }),
  K('/api/v1/analytics/export/funnel-structure', 'analytics:export', 'Funnels with their steps: block counts, word counts, order bump and upsell flags', { query: ApiListQuery }),
  K('/api/v1/analytics/ads', 'analytics:read', 'Ad performance by campaign, source, funnel or day: spend, visits, leads, orders, revenue, CPL, CPA, ROAS, profit, in one currency', { query: ApiAdsQuery, notes: 'Dates are whole calendar days (YYYY-MM-DD). Ad spend belongs to live funnels: a test key sees none.' }),
  K('/api/v1/analytics/attribution', 'analytics:read', 'Visits, leads, orders and revenue by source, medium, campaign or content for the first or last touch', { query: ApiAttributionQuery }),
  K('/api/v1/analytics/products', 'analytics:read', 'Product analytics: orders, units, gross, refunded, disputed_lost, net, AOV, refund rate, checkout conversion, bump and upsell take rates, new and repeat customers and top funnels per product and currency (cursor pagination, include=series for zero-filled series)', { query: ApiProductsQuery }),
  // API keys and the identity pepper: managed by people with a session
  A('GET', '/api/v1/api-keys', 'api_keys:manage', 'api-keys', 'API keys (prefix, scopes, last use; never the secret)'),
  A('POST', '/api/v1/api-keys', 'api_keys:manage', 'api-keys', 'Create an API key; the secret is returned once', { body: ApiKeyInput, status: 201 }),
  A('PATCH', '/api/v1/api-keys/:id', 'api_keys:manage', 'api-keys', 'Rename, set the expiry or the IP allow-list of a key', { body: ApiKeyPatch }),
  A('DELETE', '/api/v1/api-keys/:id', 'api_keys:manage', 'api-keys', 'Revoke a key', { status: 204 }),
  A('GET', '/api/v1/analytics/identity-pepper', 'analytics_identity:manage', 'api-keys', 'The workspace identity pepper and its fingerprint (a secret): a person with analytics_identity:manage + analytics:export, or an API key with both scopes', { also: ['analytics:export'], notes: 'Response {pepper, version, algorithm: "HMAC-SHA256", fingerprint, rotatedAt}. With an API key (Bearer fa_...) the key layers analytics.read and analytics.workspace apply instead of the user layers.' }),
  A('PUT', '/api/v1/analytics/identity-pepper', 'analytics_identity:manage', 'api-keys', 'Set (import) the pepper so two apps derive the same contact_key: validated, audited, bumps version (people only, never an API key)', { also: ['analytics:export'], body: PepperInput }),
  A('POST', '/api/v1/analytics/identity-pepper/rotate', 'analytics_identity:manage', 'api-keys', 'Replace the pepper with a new random one: exported keys change, so consumers must adopt the new one (people only)', { also: ['analytics:export'] }),
  // Stripe and billing
  make('POST', '/api/stripe/webhook', 'public', 'billing', 'Stripe platform webhook: subscriptions and invoices (signature over the raw body)', { limits: ['ip.global', 'webhook.inbound'], notes: 'Signed with STRIPE_WEBHOOK_SECRET (Stripe-Signature, timestamped HMAC-SHA-256). Deduplicated by event id; a failure answers 500 so Stripe retries.' }),
  make('POST', '/api/stripe/connect-webhook', 'public', 'billing', 'Stripe Connect webhook: checkout, refunds, disputes and account changes of connected accounts', { limits: ['ip.global', 'webhook.inbound'], notes: 'Signed with STRIPE_CONNECT_WEBHOOK_SECRET.' }),
  make('GET', '/api/public/checkout/return', 'public', 'billing', 'Where Stripe Checkout sends the visitor back: finishes the orders (idempotent) and redirects to the next page', { limits: ['ip.global', 'public.checkout'], query: undefined, status: 303 }),
  A('GET', '/api/billing', 'billing:read', 'billing', 'Plan, limits, usage and Stripe connection state'),
  A('POST', '/api/billing/subscribe', 'billing:manage', 'billing', 'Start a subscription: returns a Stripe Checkout URL', { body: SubscribeInput }),
  A('POST', '/api/billing/portal', 'billing:manage', 'billing', 'Open the Stripe billing portal (payment method, invoices, cancel)'),
  A('GET', '/api/billing/connect', 'billing:read', 'billing', 'Connected Stripe account state (refreshed from Stripe)'),
  A('POST', '/api/billing/connect/start', 'billing:manage', 'billing', 'Start or resume Stripe Connect onboarding: returns the onboarding URL'),
  A('POST', '/api/billing/connect/disconnect', 'billing:manage', 'billing', 'Stop taking payments through the connected account', { status: 204 }),
  A('POST', '/api/orders/:id/refund', 'orders:refund', 'orders', 'Refund an order, in full or in part (the refundable amount is reserved atomically)', { body: RefundInput, notes: 'Body is optional: no amount refunds what is left.' }),
  A('GET', '/api/disputes', 'orders:read', 'orders', 'Stripe disputes (chargebacks) of the workspace: status, outcome, evidence due date, amount lost, Stripe dashboard link; orphans (payment not known yet) included', { query: DisputeQuery }),
  // publishing to Cloudflare Pages (docs/CLOUDFLARE-PAGES.md)
  A('GET', '/api/publishing/connection', 'publishing:manage', 'publishing', 'The workspace\'s Cloudflare connection (account id, masked token, status) and whether the platform account is available'),
  A('PUT', '/api/publishing/connection', 'publishing:manage', 'publishing', 'Connect a Cloudflare account: verifies the token with a read call, stores it encrypted, never returns it', { body: ConnectInput, limits: [...WRITE, 'publishing.deploy'] }),
  A('POST', '/api/publishing/connection/verify', 'publishing:manage', 'publishing', 'Check the stored token again', { limits: [...WRITE, 'publishing.deploy'] }),
  A('DELETE', '/api/publishing/connection', 'publishing:manage', 'publishing', 'Disconnect Cloudflare (force=true switches funnels that use it back to this server)', { query: DisconnectQuery, status: 204 }),
  A('GET', '/api/funnels/:id/publishing', 'funnels:read', 'publishing', 'Where a funnel is published: target, Pages project and URL, custom domain and its status, the live and latest deployment'),
  A('PUT', '/api/funnels/:id/publishing', 'publishing:manage', 'publishing', 'Choose the target (this server or Cloudflare Pages); creates the Pages project and queues the first deployment when the funnel is live', { body: SettingsInput, limits: [...WRITE, 'publishing.deploy'] }),
  A('POST', '/api/funnels/:id/publishing/redeploy', 'publishing:manage', 'publishing', 'Build and deploy the current state again, ending any rollback or unpublish hold', { limits: [...WRITE, 'publishing.deploy'], status: 202 }),
  A('POST', '/api/funnels/:id/publishing/unpublish', 'publishing:manage', 'publishing', 'Take the site offline: replace it with a paused page, or delete the project the app created', { body: UnpublishInput, limits: [...WRITE, 'publishing.deploy'] }),
  A('POST', '/api/funnels/:id/publishing/rollback/:did', 'publishing:manage', 'publishing', 'Make an earlier successful deployment the live one; automatic deployments then wait until Redeploy', { limits: [...WRITE, 'publishing.deploy'] }),
  A('POST', '/api/funnels/:id/publishing/domain/refresh', 'publishing:manage', 'publishing', 'Read the custom domain status from Cloudflare now'),
  A('GET', '/api/funnels/:id/publishing/deployments', 'funnels:read', 'publishing', 'Deployment history, newest first (status, version, time, errors)'),
  A('GET', '/api/funnels/:id/publishing/deployments/:did', 'funnels:read', 'publishing', 'One deployment with its log'),
  // ads: integrations, pixels, spend, reports (docs/ADS.md)
  A('GET', '/api/integrations', 'integrations:manage', 'ads', 'Ad integrations (Meta, GA4, TikTok): pixel, masked token, last delivery status'),
  A('POST', '/api/integrations', 'integrations:manage', 'ads', 'Connect an ad network for server-side conversions; the token is stored encrypted and never returned', { body: IntegrationInput, status: 201 }),
  A('PATCH', '/api/integrations/:id', 'integrations:manage', 'ads', 'Rename, switch on or off, replace the token or set the test event code', { body: IntegrationPatch }),
  A('DELETE', '/api/integrations/:id', 'integrations:manage', 'ads', 'Remove an integration and its delivery log', { status: 204 }),
  A('POST', '/api/integrations/:id/test', 'integrations:manage', 'ads', 'Send one test event now (Meta and TikTok test event code, GA4 validation endpoint) and return the network\'s answer', { limits: [...WRITE, 'integrations.test'], notes: 'A real outbound call: limited to 10 per minute per workspace.' }),
  A('GET', '/api/integrations/:id/deliveries', 'integrations:manage', 'ads', 'Delivery log of an integration, newest first (status, attempts, error; no personal data)', { query: DeliveryQuery }),
  A('POST', '/api/integrations/deliveries/:did/retry', 'integrations:manage', 'ads', 'Send a failed or dead delivery again'),
  A('GET', '/api/pixels', 'funnels:read', 'ads', 'Workspace default pixels and consent banner settings'),
  A('PUT', '/api/pixels', 'integrations:manage', 'ads', 'Set the workspace default pixels and consent settings (pages are re-rendered)', { body: PixelSettings, cost: 3 }),
  A('GET', '/api/funnels/:id/pixels', 'funnels:read', 'ads', 'Pixels and consent settings of a funnel, with the effective result'),
  A('PUT', '/api/funnels/:id/pixels', 'integrations:manage', 'ads', 'Set the pixels and consent settings of a funnel (its pages are re-rendered)', { body: PixelSettings, cost: 2 }),
  A('GET', '/api/funnels/:id/steps/:sid/pixels', 'funnels:read', 'ads', 'Pixels of one step, with the effective result'),
  A('PUT', '/api/funnels/:id/steps/:sid/pixels', 'integrations:manage', 'ads', 'Set the pixels of one step (overrides the funnel)', { body: PixelSettings, cost: 2 }),
  A('GET', '/api/ads/performance', 'ads:read', 'ads', 'Ad performance: spend, visits, leads, orders, revenue, CPL, CPA, ROAS and profit by campaign, source, funnel or day (one currency per report)', { query: AdsQuery }),
  A('GET', '/api/ads/performance/export', 'ads:read', 'ads', 'The performance report as CSV (formula-injection safe)', { query: AdsQuery, cost: 5 }),
  A('GET', '/api/ads/attribution', 'ads:read', 'ads', 'Visits, leads, orders and revenue by source, medium, campaign or content, first or last touch', { query: AttributionQuery }),
  A('GET', '/api/ads/attribution/export', 'ads:read', 'ads', 'The attribution report as CSV', { query: AttributionQuery, cost: 5 }),
  A('GET', '/api/ads/spend', 'ads:read', 'ads', 'Ad spend rows, newest day first (cursor pagination)', { query: SpendQuery }),
  A('POST', '/api/ads/spend', 'ads:write', 'ads', 'Enter or correct one day of spend for a campaign (same day, source, account, campaign and currency replaces the amount)', { body: SpendInput }),
  A('DELETE', '/api/ads/spend/:id', 'ads:write', 'ads', 'Delete a spend row', { status: 204 }),
  A('POST', '/api/ads/spend/import', 'ads:write', 'ads', 'Import spend from CSV (request body, Content-Type: text/csv): validates every row, dry run and skip-invalid options, idempotent re-import', { query: ImportQuery, cost: 5, limits: [...WRITE, 'ads.import'], notes: 'Columns: date, source, account (optional), campaign, currency, spend, impressions and clicks (optional). At most ADS_IMPORT_MAX_ROWS rows and 2 MB.' }),
  A('GET', '/api/ads/mappings', 'ads:read', 'ads', 'Mappings from an ad platform campaign name to the UTM values its traffic carries'),
  A('PUT', '/api/ads/mappings', 'ads:write', 'ads', 'Map a spend campaign to a utm_campaign (and optionally utm_source)', { body: MapInput }),
  A('DELETE', '/api/ads/mappings/:id', 'ads:write', 'ads', 'Remove a campaign mapping', { status: 204 }),
  // product catalog and payments setup (docs/PRODUCTS.md, docs/STRIPE.md)
  A('GET', '/api/products', 'products:read', 'products', 'The product catalog: products with their prices, Stripe sync state and order counts (status, search, pages)', { query: ProductQuery }),
  A('POST', '/api/products', 'products:write', 'products', 'Create a product, optionally with its first price (amount in minor units or major units, currency exponent applied); synced to Stripe when connected', { body: ProductInput, status: 201, cost: 2 }),
  A('POST', '/api/products/sync', 'products:write', 'products', 'Push every product that is not in sync to the connected Stripe account', { cost: 5, limits: [...WRITE, 'payments.sync'] }),
  A('GET', '/api/products/:id', 'products:read', 'products', 'One product with its prices'),
  A('PATCH', '/api/products/:id', 'products:write', 'products', 'Edit a product (name, description, images, tax code, metadata, default price)', { body: ProductPatch }),
  A('POST', '/api/products/:id/archive', 'products:write', 'products', 'Archive a product: pickers hide it, checkouts naming it refuse with a friendly message, pages keep rendering, orders keep their link (products are never deleted)'),
  A('POST', '/api/products/:id/restore', 'products:write', 'products', 'Restore an archived product'),
  A('POST', '/api/products/:id/sync', 'products:write', 'products', 'Push one product and its prices to the connected Stripe account', { cost: 3, limits: [...WRITE, 'payments.sync'] }),
  A('POST', '/api/products/:id/prices', 'products:write', 'products', 'Add a price (prices are immutable: change an amount with .../replace)', { body: PriceInput, status: 201 }),
  A('POST', '/api/products/:id/prices/:priceId/replace', 'products:write', 'products', 'Change a price: creates the new price, archives the old one and points it at the new one (pages and checkouts naming the old price use the new one; past orders keep theirs)', { body: PriceInput }),
  A('PATCH', '/api/products/:id/prices/:priceId', 'products:write', 'products', 'Rename a price (nickname)', { body: PricePatch }),
  A('POST', '/api/products/:id/prices/:priceId/archive', 'products:write', 'products', 'Archive a price (a product keeps at least one active price)'),
  A('POST', '/api/funnels/:id/payments', 'funnels:write', 'payments', 'Add payments to a funnel (the wizard): picks or creates the products, builds the checkout (one-step or offer plus checkout), order bump, one-click upsell and downsell and thank-you steps, and wires the flow', { also: ['products:write'], body: WizardInput, status: 201, cost: 3 }),
  A('GET', '/api/payments/status', 'products:read', 'payments', 'Payments overview: test or live mode, connection state, charges and payouts, payment methods, currency, statement descriptor, Stripe Tax availability, checkout settings and the Stripe test cards'),
  A('PATCH', '/api/payments/settings', 'billing:manage', 'payments', 'Checkout settings: statement descriptor suffix, receipt emails, Stripe Tax', { body: PaymentSettingsPatch }),
  // AI
  A('GET', '/api/ai/status', 'ai:use', 'ai', 'Provider and daily usage'),
  A('POST', '/api/ai/funnel', 'ai:use', 'ai', 'Generate a funnel', { body: ai.FunnelRequest, status: 201, limits: ['ip.global', 'api.write', 'api.workspace'], inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/builds', 'ai:use', 'ai', 'Start the multi-stage funnel builder from a brief; answers 202 at once, progress comes as `ai.build` events on the SSE stream and from GET /api/ai/builds/:id', { body: aiBuild.BuildRequest, status: 202, also: ['funnels:write'], inHandler: ['ai.minute', 'ai.daily'], notes: 'One build per workspace at a time (409 BUILD_IN_PROGRESS). `options.products: "create"` also needs products:write. Uses the job queue, so it resumes after a restart.' }),
  A('GET', '/api/ai/builds', 'ai:use', 'ai', 'Recent generations of the workspace (status, stages, token use)'),
  A('GET', '/api/ai/builds/:id', 'ai:use', 'ai', 'One generation: stages, brief, assumptions, strategy, validation report, token use and the funnel it created'),
  A('POST', '/api/ai/builds/:id/cancel', 'ai:use', 'ai', 'Cancel a queued or running generation (nothing is created)'),
  A('POST', '/api/ai/builds/:id/steps/:key/regenerate', 'ai:use', 'ai', 'Rewrite one page of a finished generation and save it to the funnel (the previous version goes to the page history)', { body: aiBuild.RegenerateRequest, also: ['funnels:write'], inHandler: ['ai.minute', 'ai.daily'] }),
  A('POST', '/api/ai/edit', 'ai:use', 'ai', 'Builder assistant: turn an instruction about the current page (outline of element ids and text) into validated edit operations (insert, replace, delete, move, setText, restyle over allow-listed components and styles); the browser applies them as one undoable step after preview', { body: aiEdit.EditRequest, also: ['funnels:write'], inHandler: ['ai.minute', 'ai.daily'], notes: 'Never returns HTML. Answer: {summary, ops, source: model|heuristic|fallback, message?, usage}.' }),
  A('POST', '/api/ai/section', 'ai:use', 'ai', 'Builder assistant: write one section from a short description; returns a validated node spec the browser inserts', { body: aiEdit.SectionRequest, also: ['funnels:write'], inHandler: ['ai.minute', 'ai.daily'] }),
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
