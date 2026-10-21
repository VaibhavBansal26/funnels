export type ConversionName = 'Lead' | 'Purchase';
export type ProviderId = 'meta' | 'ga4' | 'tiktok';

export interface ConversionUser {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  /** The visitor id of the funnel (cookie `visitor_id`), the stable pseudonymous key of the browser. */
  externalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  /** TikTok browser id (`_ttp` cookie) and click id. */
  ttp?: string | null;
  ttclid?: string | null;
  gclid?: string | null;
  /** The GA4 client id (second and third part of the `_ga` cookie) and session id when the browser reported them. */
  gaClientId?: string | null;
  gaSessionId?: string | null;
  defaultCallingCode?: string;
}

export interface ConversionItem {
  id: string;
  name: string;
  quantity: number;
  /** Unit price in major currency units. */
  price: number;
}

/** What happened, independent of any network. Providers turn it into their own request. */
export interface ConversionEvent {
  name: ConversionName;
  /** Shared with the browser pixel (`lead_<submissionId>`, `purchase_<first order id>`) so each network can deduplicate the two. */
  eventId: string;
  timeMs: number;
  sourceUrl?: string | null;
  user: ConversionUser;
  value?: number;
  currency?: string;
  orderId?: string;
  items?: ConversionItem[];
}

export interface IntegrationTarget {
  pixelId: string;
  testEventCode?: string | null;
  /** Base URL of the network's API (https). */
  base: string;
  /** Meta only. */
  version?: string;
}

/** A request without its secret. This is what the delivery log stores (hashed identifiers, no token). */
export interface BuiltRequest {
  /** Path and query WITHOUT the secret. */
  path: string;
  body: Record<string, unknown>;
}

export type Outcome = { ok: true } | { ok: false; retry: boolean; message: string };

export interface PreparedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** One ad network's server-side conversion API. `build` and `prepare` are pure; the transport (fetch, retries, log) is shared in services/conversions.ts. */
export interface ConversionsProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Names of the network's events for ours. */
  eventName(n: ConversionName): string;
  build(e: ConversionEvent, t: IntegrationTarget, opts: { test: boolean }): BuiltRequest;
  /** Adds the secret. Never log the result: GA4 requires the secret in the query string. */
  prepare(built: BuiltRequest, t: IntegrationTarget, secret: string, opts: { test: boolean }): PreparedCall;
  interpret(status: number, text: string, opts: { test: boolean }): Outcome;
}

export const clip = (s: string | null | undefined, n: number): string | undefined => (s ? s.slice(0, n) : undefined);
export const nonEmpty = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0))) as T;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Short, secret-free description of a failed call for the delivery log. */
export function errorText(text: string, secret: string): string {
  let t = text.slice(0, 500);
  if (secret) t = t.split(secret).join('[redacted]');
  return t.replace(/(access_token|api_secret|Access-Token)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1$2[redacted]');
}
