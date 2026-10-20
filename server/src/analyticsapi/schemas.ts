import { z } from 'zod';

/**
 * The Analytics API v1 response contracts (docs/ANALYTICS-API.md, the shared ANALYTICS-CONTRACT). These zod schemas are the single source: they type the
 * service output in tests, are emitted as JSON Schema files in docs/analytics-api/ (`npm run docs:api`) and are served by `GET /api/v1/analytics/schema`, so
 * the Python consumer and this repository's contract tests validate against the same documents. Additive changes only within v1: objects are open (no
 * `additionalProperties: false`), so consumers must ignore fields they do not know.
 */
export const SCHEMA_VERSION = 1;

const ts = z.string().describe('UTC ISO-8601 timestamp');
const rate = z.number().min(0).max(1).describe('Fraction between 0 and 1');

export const FunnelRow = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.enum(['live', 'test']),
  steps_count: z.number().int().min(0),
  visits: z.number().int().min(0).describe('Page views across all steps in the range'),
  unique_visits: z.number().int().min(0).describe('First views of the entry step by a visitor in the range'),
  optins: z.number().int().min(0),
  optin_rate: rate.describe('optins / unique_visits (0 when there are no unique visits)'),
  orders: z.number().int().min(0),
  gross: z.number().describe('Order revenue in major currency units. Refunds are not subtracted; amounts lost to lost Stripe disputes (chargebacks) are'),
  refunded: z.number().min(0).describe('Refunds on the orders created in the range, in major units (added in v1, additive)'),
  disputed_lost: z.number().min(0).describe('Amounts lost to lost disputes on the orders created in the range; already out of gross (added in v1, additive)'),
  net: z.number().describe('gross - refunded (added in v1, additive)'),
  currency: z.string().nullable().describe('The single currency of the funnel orders in the range; null when there are none or they are mixed'),
  earnings_per_view: z.number().min(0).describe('gross / visits'),
  created_at: ts,
});
export const FunnelList = z.looseObject({ data: z.array(FunnelRow), next_cursor: z.string().nullable() });

export const StepRow = z.looseObject({
  step_id: z.string(),
  name: z.string(),
  order: z.number().int().min(1).describe('1-based position in the funnel'),
  visits: z.number().int().min(0),
  unique_visits: z.number().int().min(0).describe('Visitors whose first view of this step fell in the range'),
  optins: z.number().int().min(0),
  optin_rate: rate,
  orders: z.number().int().min(0),
  gross: z.number(),
  refunded: z.number().min(0).describe('Refunds on the orders of this step created in the range (additive)'),
  disputed_lost: z.number().min(0).describe('Amounts lost to lost disputes on those orders; already out of gross (additive)'),
  net: z.number().describe('gross - refunded (additive)'),
  exit_rate: rate.nullable().describe('Share of this step visitors who never reached the next step; null for the last step'),
  avg_time_on_page_s: z.number().min(0).nullable().describe('Always null: time on page is not collected'),
});
export const StepList = z.looseObject({ data: z.array(StepRow), next_cursor: z.null() });

export const METRICS = ['visits', 'unique_visits', 'optins', 'orders', 'gross'] as const;
export const INTERVALS = ['hour', 'day', 'week', 'month'] as const;
export const Timeseries = z.looseObject({
  interval: z.enum(INTERVALS),
  metric: z.enum(METRICS),
  tz: z.string(),
  points: z.array(z.looseObject({ t: ts.describe('Start of the interval as a UTC instant (intervals follow the local calendar of tz)'), value: z.number() })),
});

const device = z.enum(['desktop', 'mobile', 'tablet', 'unknown']);
export const EventLine = z.looseObject({
  id: z.string(),
  ts: ts,
  type: z.enum(['page_view', 'optin', 'order']),
  funnel_id: z.string(),
  step_id: z.string(),
  visitor_key: z.string().nullable().describe('Hex HMAC-SHA256 of the visitor id with the workspace pepper; null when the event has no visitor'),
  contact_key: z.string().nullable().describe('Hex HMAC-SHA256 of the lower-cased, trimmed email with the workspace pepper; null when the event is not tied to a lead'),
  utm_source: z.string().nullable(),
  utm_medium: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  device,
  country: z.string().nullable().describe('ISO 3166-1 alpha-2, only from a verified Cloudflare header'),
  referrer_host: z.string().nullable(),
  amount: z.number().nullable().describe('Order amount in major units; null for other events'),
  currency: z.string().nullable(),
  unique_visit: z.boolean(),
});

export const LeadLine = z.looseObject({
  id: z.string(),
  created_at: ts,
  funnel_id: z.string().nullable(),
  step_id: z.string().nullable(),
  contact_key: z.string(),
  source: z.enum(['form', 'checkout']).describe('How the lead was first created: an opt-in form or a purchase'),
  utm_source: z.string().nullable(),
  utm_campaign: z.string().nullable(),
  converted_to_order: z.boolean(),
  order_total: z.number().describe('Sum of the lead orders in major units (0 when none)'),
  first_order_at: ts.nullable(),
});

export const StructureStep = z.looseObject({
  step_id: z.string(),
  name: z.string(),
  order: z.number().int().min(1),
  path: z.string(),
  blocks: z.looseObject({ form: z.number().int(), checkout: z.number().int(), video: z.number().int(), countdown: z.number().int() }),
  word_count: z.number().int().min(0),
  has_order_bump: z.boolean(),
  has_upsell: z.boolean(),
});
export const StructureFunnel = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.enum(['live', 'test']),
  steps: z.array(StructureStep),
  has_order_bump: z.boolean(),
  has_upsell: z.boolean(),
  word_count: z.number().int().min(0),
});
export const StructureList = z.looseObject({ data: z.array(StructureFunnel), next_cursor: z.string().nullable() });

export const IdentityPepper = z.looseObject({
  pepper: z.string().min(32).max(256).describe('The HMAC key, used exactly as given (UTF-8). Generated peppers are 64 hex characters; an imported one may be any acceptable string of 32 to 256 characters'),
  version: z.number().int().min(1).describe('Starts at 1; every change of value (rotate, or set to a different value) adds 1'),
  algorithm: z.literal('HMAC-SHA256').describe('contact_key = hex(HMAC-SHA256(pepper, lower(trim(email)))); visitor_key = hex(HMAC-SHA256(pepper, "v:" + visitor_id))'),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/).describe('First 8 hex characters of SHA-256 over the pepper (UTF-8): compare it between apps without showing the pepper'),
  rotatedAt: ts.describe('When the value last changed (rotate or set); the workspace creation time for a pepper never changed since it was first generated before this field existed'),
});

const money = z.number().describe('Major currency units, in the report currency');
const nullableRatio = z.number().nullable().describe('null when the denominator is zero');
export const AdsRow = z.looseObject({
  key: z.string().describe('Stable key of the row: platform and campaign for group_by=campaign, else the platform, funnel id or day'),
  source: z.string().nullable().describe('Platform (spend source folded to meta, google, tiktok, bing, linkedin, ... or as entered)'),
  campaign: z.string().nullable(),
  funnel_id: z.string().nullable(),
  day: z.string().nullable().describe('Calendar day YYYY-MM-DD (group_by=day)'),
  spend: money,
  impressions: z.number().int().nullable(),
  clicks: z.number().int().nullable(),
  visits: z.number().int().min(0).describe('Visitors whose first (or last) touch fell in the range'),
  leads: z.number().int().min(0),
  orders: z.number().int().min(0).describe('Checkouts; an order bump is not counted again'),
  revenue: money.describe('Net of refunds and of amounts lost in Stripe disputes'),
  cpl: nullableRatio.describe('spend / leads'),
  cpa: nullableRatio.describe('spend / orders'),
  cpc: nullableRatio.describe('spend / clicks'),
  ctr: nullableRatio.describe('clicks / impressions in percent'),
  roas: nullableRatio.describe('revenue / spend'),
  profit: z.number().describe('revenue - spend'),
});
export const AdsReport = z.looseObject({
  data: z.array(AdsRow),
  next_cursor: z.null(),
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  model: z.enum(['first', 'last']),
  group_by: z.enum(['campaign', 'source', 'funnel', 'day']),
  currency: z.string().regex(/^[A-Z]{3}$/).describe('Every amount in the report is in this currency; currencies never mix'),
  currencies: z.array(z.string()).describe('Currencies with spend or revenue in the range'),
  totals: AdsRow,
  other: z.looseObject({ visits: z.number().int(), leads: z.number().int(), orders: z.number().int(), revenue: money }).describe('Results of campaigns that have no spend recorded'),
  unmatched_spend: z.array(z.looseObject({ source: z.string(), campaign: z.string(), spend: money })).describe('Spend whose campaign never appears in the traffic: map it to a utm_campaign'),
});
export const AttributionRow = z.looseObject({
  source: z.string().nullable(),
  medium: z.string().nullable(),
  campaign: z.string().nullable(),
  content: z.string().nullable(),
  visits: z.number().int().min(0),
  leads: z.number().int().min(0),
  orders: z.number().int().min(0),
  revenue: money,
  conversion_rate: z.number().nullable().describe('orders / visits in percent'),
});
export const AttributionReport = z.looseObject({
  data: z.array(AttributionRow),
  next_cursor: z.null(),
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  model: z.enum(['first', 'last']),
  dimension: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  currencies: z.array(z.string()),
  totals: z.looseObject({ visits: z.number().int(), leads: z.number().int(), orders: z.number().int(), revenue: money }),
});

const amount = z.number().describe('Major currency units, in the row currency (never summed across currencies)');
const seriesPoint = z.looseObject({ t: ts, orders: z.number().int().min(0), units: z.number().int().min(0), gross: amount, refunded: amount, disputed_lost: amount, net: amount });
const takeRate = z.looseObject({ offered: z.number().int().min(0), taken: z.number().int().min(0), rate: rate.describe('taken / offered (0 when nothing was offered)') });
export const ProductRow = z.looseObject({
  product_id: z.string().nullable().describe('Catalog product id; null for orders that predate the catalog and could not be matched'),
  name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  exponent: z.number().int().min(0).max(3).describe('Currency decimals: amounts are major units rounded to this many places'),
  orders: z.number().int().min(0).describe('Order lines: an order bump or upsell is its own order'),
  units: z.number().int().min(0),
  gross: amount.describe('Booked amount after promotion codes, minus amounts lost to lost disputes (the same meaning as gross on funnels)'),
  refunded: amount.describe('Refunds on these orders (as of now), attributed to the order date'),
  disputed_lost: amount.describe('Amounts lost to lost disputes on these orders (already out of gross)'),
  net: amount.describe('gross - refunded'),
  discount: amount.describe('Promotion code discounts (already out of gross)'),
  aov: amount.describe('gross / orders'),
  refund_rate: rate.describe('refunded / gross'),
  refunded_orders: z.number().int().min(0),
  roles: z.looseObject({ main: z.number().int(), bump: z.number().int(), upsell: z.number().int(), downsell: z.number().int() }).describe('Orders by role'),
  customers: z.looseObject({ total: z.number().int(), new: z.number().int().describe('First ever order in the workspace fell in the range'), repeat: z.number().int() }),
  checkout: z.looseObject({ visitors: z.number().int(), orders: z.number().int(), conversion: rate.describe('main-offer orders / unique visitors of the checkout steps') }),
  take_rates: z.looseObject({ bump: takeRate, upsell: takeRate, downsell: takeRate }),
  top_funnels: z.array(z.looseObject({ funnel_id: z.string(), name: z.string(), orders: z.number().int(), gross: amount, refunded: amount, net: amount })),
  series: z.array(seriesPoint).optional().describe('Zero-filled intervals; only with include=series'),
});
export const ProductsReport = z.looseObject({
  data: z.array(ProductRow),
  next_cursor: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  tz: z.string(),
  interval: z.enum(['day', 'week', 'month']),
  totals: z.array(z.looseObject({ currency: z.string().regex(/^[A-Z]{3}$/), exponent: z.number().int(), orders: z.number().int(), units: z.number().int(), gross: amount, refunded: amount, disputed_lost: amount, net: amount, discount: amount, aov: amount, refund_rate: rate, customers: z.looseObject({ total: z.number().int(), new: z.number().int(), repeat: z.number().int() }), series: z.array(seriesPoint).optional() })).describe('One row per currency: currencies are never added together'),
});

export const ErrorBody = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional().describe('Validation problems: [{ path, message }]'),
    retry_after_s: z.number().int().optional().describe('On 429 and 503: seconds to wait (also the Retry-After header)'),
    policy: z.string().optional().describe('On 429: the rate limit policy that refused the request'),
  }),
});

/** Every document the API promises, by name (what `GET /schema` and docs/analytics-api/ publish). */
export const DOCUMENTS = {
  funnels: FunnelList,
  steps: StepList,
  timeseries: Timeseries,
  'export-event': EventLine,
  'export-lead': LeadLine,
  'funnel-structure': StructureList,
  'identity-pepper': IdentityPepper,
  ads: AdsReport,
  attribution: AttributionReport,
  products: ProductsReport,
  error: ErrorBody,
} as const;

export const jsonSchemaOf = (s: z.ZodType): Record<string, unknown> => {
  const j = z.toJSONSchema(s, { io: 'output', target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  return j;
};

export const schemaDocument = () => ({ schema_version: SCHEMA_VERSION, schemas: Object.fromEntries(Object.entries(DOCUMENTS).map(([k, v]) => [k, jsonSchemaOf(v)])) });
