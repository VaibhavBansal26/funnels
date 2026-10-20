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
  gross: z.number().describe('Order revenue in major currency units'),
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
  error: ErrorBody,
} as const;

export const jsonSchemaOf = (s: z.ZodType): Record<string, unknown> => {
  const j = z.toJSONSchema(s, { io: 'output', target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  return j;
};

export const schemaDocument = () => ({ schema_version: SCHEMA_VERSION, schemas: Object.fromEntries(Object.entries(DOCUMENTS).map(([k, v]) => [k, jsonSchemaOf(v)])) });
