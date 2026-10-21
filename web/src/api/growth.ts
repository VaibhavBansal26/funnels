import { useQuery } from '@tanstack/react-query';
import { api } from './client';

/**
 * Types and hooks for publishing (Cloudflare Pages), pixels, integrations, ad spend and the ads reports. Kept in their own file so the shared hooks.ts stays small;
 * the server contracts are in docs/ADS.md and docs/CLOUDFLARE-PAGES.md.
 */
type Q = Record<string, string | number | boolean | undefined | null>;

// ---- publishing -----------------------------------------------------------------------------------------------------------------------------------------

export interface PublishingConnection {
  connected: boolean;
  accountId: string | null;
  tokenHint: string | null;
  status: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  platform: { available: boolean; projectsUsed: number };
}

export interface DeploymentSummary {
  id: string;
  versionId: string | null;
  status: 'queued' | 'building' | 'uploading' | 'deploying' | 'succeeded' | 'failed' | 'superseded' | 'rolled_back';
  reason: 'publish' | 'save' | 'redeploy' | 'rollback' | 'unpublish';
  fileCount: number;
  bytes: number;
  url: string | null;
  error: string | null;
  cloudflareDeploymentId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  active: boolean;
  canRollback: boolean;
}

export interface PublishSettings {
  target: 'origin' | 'cloudflare-pages' | 'cloudflare-workers-assets';
  owner: 'workspace' | 'platform' | null;
  project: { name: string; host: string | null; url: string | null; created: boolean } | null;
  customDomain: { hostname: string; status: 'pending' | 'active' | 'failed' | null; error: string | null; dns: { type: string; name: string; value: string | null } } | null;
  domain: { id: string; hostname: string; status: string } | null;
  funnelStatus: 'live' | 'test';
  paused: boolean;
  hold: boolean;
  lastError: string | null;
  active: DeploymentSummary | null;
  latest: DeploymentSummary | null;
  inFlight: boolean;
  constraints: { workspaceConnected: boolean; platformAvailable: boolean; domainShared: boolean; needsLiveDomain: boolean; limits: { maxFiles: number; maxFileBytes: number } };
}

export interface DeploymentDetail extends DeploymentSummary {
  log: { t: string; level: 'info' | 'warn' | 'error'; msg: string }[];
}

export const growthKeys = {
  connection: ['publishing', 'connection'] as const,
  publish: (funnelId: string) => ['publishing', funnelId] as const,
  deployments: (funnelId: string) => ['publishing', funnelId, 'deployments'] as const,
  pixels: (scope: string) => ['pixels', scope] as const,
  integrations: ['integrations'] as const,
  deliveries: (id: string | null) => ['integrations', id, 'deliveries'] as const,
  spend: ['ads', 'spend'] as const,
  mappings: ['ads', 'mappings'] as const,
  performance: (q: Q) => ['ads', 'performance', q] as const,
  attribution: (q: Q) => ['ads', 'attribution', q] as const,
};

export const usePublishingConnection = (enabled = true) => useQuery({ queryKey: growthKeys.connection, enabled, queryFn: () => api.get<PublishingConnection>('/api/publishing/connection') });

/** Polls while a deployment is in flight so the screen follows it without a click. */
export const usePublishSettings = (funnelId: string) =>
  useQuery({
    queryKey: growthKeys.publish(funnelId),
    queryFn: () => api.get<PublishSettings>(`/api/funnels/${funnelId}/publishing`),
    refetchInterval: (q) => (q.state.data?.inFlight || q.state.data?.customDomain?.status === 'pending' ? 2500 : false),
  });

export const useDeployments = (funnelId: string, enabled: boolean) =>
  useQuery({
    queryKey: growthKeys.deployments(funnelId),
    enabled,
    queryFn: () => api.get<{ data: DeploymentSummary[] }>(`/api/funnels/${funnelId}/publishing/deployments`),
    refetchInterval: (q) => (q.state.data?.data.some((d) => ['queued', 'building', 'uploading', 'deploying'].includes(d.status)) ? 2500 : false),
  });

export const useDeployment = (funnelId: string, id: string | null) =>
  useQuery({ queryKey: [...growthKeys.deployments(funnelId), id], enabled: !!id, queryFn: () => api.get<DeploymentDetail>(`/api/funnels/${funnelId}/publishing/deployments/${id}`) });

// ---- pixels ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ConsentSettings {
  enabled: boolean;
  mode: 'opt_in' | 'opt_out';
  regions: 'everyone' | 'eu_uk';
  respectDnt: boolean;
  title: string;
  message: string;
  acceptLabel: string;
  rejectLabel: string;
  policyUrl: string;
  position: 'bottom' | 'bottom-left' | 'center';
}

export interface PixelSettings {
  meta?: { pixelId: string } | null;
  ga4?: { measurementId: string } | null;
  googleAds?: { conversionId: string; purchaseLabel?: string | null; leadLabel?: string | null } | null;
  tiktok?: { pixelId: string } | null;
  linkedin?: { partnerId: string; purchaseConversionId?: string | null; leadConversionId?: string | null } | null;
  uet?: { tagId: string } | null;
  events?: { lead?: boolean };
  consent?: Partial<ConsentSettings>;
}

export interface PixelsResponse {
  scope: 'workspace' | 'funnel' | 'step';
  config: PixelSettings | null;
  effective: (Required<Pick<PixelSettings, 'meta' | 'ga4' | 'googleAds' | 'tiktok' | 'linkedin' | 'uet'>> & { events: { lead: boolean }; consent: ConsentSettings }) | null;
}

export const pixelsPath = (funnelId?: string | null, stepId?: string | null) => (stepId && funnelId ? `/api/funnels/${funnelId}/steps/${stepId}/pixels` : funnelId ? `/api/funnels/${funnelId}/pixels` : '/api/pixels');
export const usePixels = (funnelId?: string | null, stepId?: string | null) =>
  useQuery({ queryKey: growthKeys.pixels(`${funnelId ?? 'ws'}:${stepId ?? ''}`), queryFn: () => api.get<PixelsResponse>(pixelsPath(funnelId, stepId)) });

/** The same strict formats the server enforces (server/src/ads/ids.ts), so the form can say what is wrong before saving. */
export const ID_FORMATS = {
  metaPixel: { re: /^\d{8,20}$/, hint: 'the Meta Pixel ID: 8 to 20 digits, for example 123456789012345' },
  ga4: { re: /^G-[A-Z0-9]{6,12}$/, hint: 'a GA4 measurement ID such as G-ABC123XYZ9' },
  googleAds: { re: /^AW-\d{6,12}$/, hint: 'a Google Ads conversion ID such as AW-123456789' },
  googleAdsLabel: { re: /^[A-Za-z0-9_-]{6,40}$/, hint: 'a conversion label (letters, digits, - and _)' },
  tiktok: { re: /^[A-Z0-9]{10,30}$/, hint: 'a TikTok pixel code in capitals and digits' },
  linkedinPartner: { re: /^\d{5,10}$/, hint: 'a LinkedIn partner ID (digits)' },
  linkedinConversion: { re: /^\d{4,12}$/, hint: 'a LinkedIn conversion ID (digits)' },
  uet: { re: /^\d{6,12}$/, hint: 'a Microsoft Advertising UET tag ID (digits)' },
} as const;
export type IdKind = keyof typeof ID_FORMATS;
export const idProblem = (kind: IdKind, v: string): string | undefined => (v.trim() === '' || ID_FORMATS[kind].re.test(v.trim()) ? undefined : `Enter ${ID_FORMATS[kind].hint}`);

// ---- integrations ----------------------------------------------------------------------------------------------------------------------------------------

export type Provider = 'meta' | 'ga4' | 'tiktok';
export interface Integration {
  id: string;
  provider: Provider;
  providerLabel: string;
  name: string;
  pixelId: string;
  hasSecret: boolean;
  secretHint: string | null;
  testEventCode: string | null;
  enabled: boolean;
  sendLead: boolean;
  sendPurchase: boolean;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}
export interface Delivery {
  id: string;
  eventName: string;
  eventId: string;
  isTest: boolean;
  status: 'queued' | 'sent' | 'failed' | 'dead' | 'skipped';
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  response: string | null;
  createdAt: string;
}
export const useIntegrations = () => useQuery({ queryKey: growthKeys.integrations, queryFn: () => api.get<{ data: Integration[] }>('/api/integrations') });
export const useDeliveries = (id: string | null) =>
  useQuery({
    queryKey: growthKeys.deliveries(id),
    enabled: !!id,
    queryFn: () => api.get<{ data: Delivery[]; nextCursor: string | null }>(`/api/integrations/${id}/deliveries`, { limit: 50 }),
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status === 'queued' || d.status === 'failed') ? 4000 : false),
  });

export const PROVIDER_FORMAT: Record<Provider, { idKind: IdKind; label: string; idLabel: string; secretLabel: string; testCode: boolean }> = {
  meta: { idKind: 'metaPixel', label: 'Meta Conversions API', idLabel: 'Pixel (dataset) ID', secretLabel: 'Access token', testCode: true },
  ga4: { idKind: 'ga4', label: 'Google Analytics 4', idLabel: 'Measurement ID', secretLabel: 'Measurement Protocol API secret', testCode: false },
  tiktok: { idKind: 'tiktok', label: 'TikTok Events API', idLabel: 'Pixel code', secretLabel: 'Access token', testCode: true },
};

// ---- spend and reports ----------------------------------------------------------------------------------------------------------------------------------

export interface SpendRow {
  id: string;
  day: string;
  source: string;
  account: string;
  campaign: string;
  currency: string;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  funnelId: string | null;
}
export interface Mapping {
  id: string;
  source: string;
  campaign: string;
  utmSource: string | null;
  utmCampaign: string;
}
export interface PerfRow {
  key: string;
  source: string | null;
  campaign: string | null;
  funnelId: string | null;
  funnelName: string | null;
  day: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  visits: number;
  leads: number;
  orders: number;
  revenue: number;
  cpl: number | null;
  cpa: number | null;
  cpc: number | null;
  ctr: number | null;
  roas: number | null;
  profit: number;
}
export interface Performance {
  range: { from: string; to: string; tz: string };
  model: 'first' | 'last';
  groupBy: 'campaign' | 'source' | 'funnel' | 'day';
  currency: string;
  currencies: string[];
  rows: PerfRow[];
  totals: PerfRow;
  other: { visits: number; leads: number; orders: number; revenue: number };
  unmatched: { source: string; campaign: string; spend: number; hint: string | null }[];
  campaigns: string[];
}
export interface AttributionReport {
  range: { from: string; to: string; tz: string };
  model: 'first' | 'last';
  dimension: string;
  currency: string;
  currencies: string[];
  rows: { source?: string; medium?: string; campaign?: string; content?: string; visits: number; leads: number; orders: number; revenue: number; conversionRate: number | null }[];
  totals: { visits: number; leads: number; orders: number; revenue: number };
}
export interface ImportResult {
  dryRun: boolean;
  rows: number;
  valid: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { line: number; field: string; message: string }[];
  moreErrors: boolean;
}

export const useSpend = (q: Q) => useQuery({ queryKey: [...growthKeys.spend, q], queryFn: () => api.get<{ data: SpendRow[]; nextCursor: string | null }>('/api/ads/spend', q) });
export const useMappings = () => useQuery({ queryKey: growthKeys.mappings, queryFn: () => api.get<{ data: Mapping[] }>('/api/ads/mappings') });
export const usePerformance = (q: Q) => useQuery({ queryKey: growthKeys.performance(q), queryFn: () => api.get<Performance>('/api/ads/performance', q) });
export const useAttribution = (q: Q) => useQuery({ queryKey: growthKeys.attribution(q), queryFn: () => api.get<AttributionReport>('/api/ads/attribution', q) });

// ---- formatting ------------------------------------------------------------------------------------------------------------------------------------------

export const money = (n: number | null, currency: string): string => {
  if (n === null) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};
export const ratio = (n: number | null, digits = 2): string => (n === null ? '—' : n.toFixed(digits));
