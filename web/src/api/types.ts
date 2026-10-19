export type Role = 'owner' | 'admin' | 'member';
export interface User { id: string; email: string; name: string; role: Role; workspaceId: string }
export interface Workspace { id: string; name: string; allowCustomScripts: boolean; createdAt: string }
export interface Session { user: User; workspace: Workspace }
export interface AuthResponse extends Session { token: string }

export interface Pagination { page: number; limit: number; total: number; totalPages: number }
export interface Paged<T> { data: T[]; pagination: Pagination }

export interface Tag { id: string; name: string; count?: number }
export interface DomainRef { id: string; hostname: string; status: string }
export interface FunnelSummary {
  id: string; name: string; basePath: string; status: 'live' | 'test'; favicon: string | null;
  headerTrackingCode: string | null; footerTrackingCode: string | null;
  domain: DomainRef | null; tags: Tag[]; stepCount: number;
  stats: { visits: number; optins: number; orders: number; sales: number };
  thumbnail: { heading: string; from: string; to: string };
  createdAt: string; updatedAt: string; deletedAt: string | null;
}
export interface Step {
  id: string; funnelId: string; name: string; path: string; position: number;
  title: string | null; seoDescription: string | null; customCss: string | null;
  headerTrackingCode: string | null; footerTrackingCode: string | null;
  version: number; isDomainHome: boolean; isDomain404: boolean; createdAt: string; updatedAt: string;
}
export interface FunnelDetail extends FunnelSummary { steps: Step[] }
export interface FunnelFilters { status: { live: number; test: number }; domainConnected: { connected: number; notConnected: number }; tags: Tag[] }

export interface Domain {
  id: string; hostname: string; status: 'pending' | 'active' | 'failed'; failureReason: string | null;
  verifiedAt: string | null; lastCheckedAt: string | null; createdAt: string;
  defaultHomeStepId: string | null; default404StepId: string | null; funnelCount: number;
  dns: { cname: { type: string; name: string; value: string }; txt: { type: string; name: string; value: string } };
}
export interface VerifyResult { domain: Domain; checks: { cname: { ok: boolean; found: string[] }; txt: { ok: boolean } } | null; error?: string }
export interface DomainRoute { stepId: string; stepName: string; funnelId: string; funnelName: string; path: string }

export interface Lead { id: string; email: string; name: string | null; phone: string | null; data: Record<string, string>; firstFunnelName: string | null; submissions: number; createdAt: string; updatedAt: string }
export interface Order { id: string; productName: string; amount: number; amountCents: number; currency: string; isBump: boolean; isUpsell: boolean; funnelName: string | null; stepName: string | null; email: string; name: string | null; createdAt: string }

export interface Webhook { id: string; url: string; events: string[]; active: boolean; secretPreview: string; createdAt: string; secret?: string }
export interface Delivery { id: string; event: string; status: 'queued' | 'delivered' | 'failed' | 'dead'; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; updatedAt: string }
export interface AppNotification { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string }
export interface Member { id: string; email: string; name: string; role: Role; createdAt: string }

export interface TemplateSummary { id: string; slug: string; name: string; description: string; categoryId: string | null; categoryName: string | null; stepCount: number; heading: string | null }
export interface TemplateDetail extends TemplateSummary { steps: { id: string; name: string; path: string; position: number; doc: unknown }[] }
export interface TemplateCategory { id: string; name: string; slug: string; templateCount: number }
export interface CustomBlock { id: string; name: string; block: unknown; createdAt: string }

export interface Metrics {
  pageViews: { all: number; unique: number };
  optIns: { all: number; conversionRate: number };
  sales: { orders: number; conversionRate: number; gross: number };
  earningsPerView: { all: number; unique: number };
}
export interface SeriesPoint { date: string; pageViews: number; uniqueVisits: number; optIns: number; orders: number; gross: number }
export interface Analytics {
  range: { from: string; to: string; tz: string };
  summary: Metrics;
  steps: (Metrics & { stepId: string; name: string; path: string; position: number })[];
  series: SeriesPoint[];
}
export interface Insights { metrics: Analytics; weakestStepId: string | null; summary: string; actions: { title: string; detail: string }[]; source: string }
export interface Backup { id: string; version: number; label: string; checksum: string; createdAt: string }
export interface PageData { stepId: string; version: number; checksum: string; updatedAt: string; doc: unknown }

export interface PathConflict { path: string; resolved_path: string; conflictsWith?: { funnelName: string; stepName: string } }
