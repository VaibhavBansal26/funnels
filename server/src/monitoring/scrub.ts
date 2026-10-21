/**
 * What may leave this process towards Sentry. Everything here is an ALLOW-LIST: an event is rebuilt field by field from what is known to be safe, so a field a future SDK
 * version adds (request bodies, cookies, headers, user, breadcrumbs, extra data, local variables, page content) is dropped by default instead of leaked by default.
 * Text that does travel (exception messages) is scrubbed for emails, tokens, keys, addresses and query strings. Pure functions, no Sentry import: unit tested directly.
 */
export const REDACTED = '[redacted]';
const MAX_TEXT = 300;

const RULES: [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/g, '[stripe-key]'],
  [/\bwhsec_[A-Za-z0-9]{6,}/g, '[stripe-secret]'],
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, '[api-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[google-key]'],
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?[query]'],
  [/([?&](?:token|key|secret|password|pass|code|sig|signature|auth|api_key|apikey|access_token|refresh_token)=)[^&\s"']*/gi, '$1[redacted]'],
  [/\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[token]'],
];

/** Scrubs free text and caps its length. */
export function scrubText(input: unknown, max = MAX_TEXT): string {
  let s = typeof input === 'string' ? input : input === null || input === undefined ? '' : String(input);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const ID_SEGMENT = /^(?:[a-z]{1,6}_[A-Za-z0-9_-]{6,}|[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{16,}|\d+|[A-Za-z0-9_-]{24,})$/;

/** `/api/funnels/fn_abc123/steps/stp_x?token=1` -> `/api/funnels/:id/steps/:id`. Hono route patterns (`/api/funnels/:id`) pass through unchanged. */
export function templatePath(raw: unknown): string {
  const m = /^([A-Z]+ )?(.*)$/.exec(String(raw ?? '').split(/[?#]/)[0]!)!;
  return (m[1] ?? '') + m[2]!.split('/').map((seg) => (seg && !seg.startsWith(':') && ID_SEGMENT.test(seg) ? ':id' : seg)).join('/');
}

const TAG_KEYS = new Set(['request_id', 'route', 'workspace', 'plan', 'kind', 'job_type', 'handled', 'surface', 'environment_kind']);
const TAG_VALUE = /^[A-Za-z0-9_.:/\-[\] *]{0,120}$/;

function tagsOf(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (tags && typeof tags === 'object') {
    for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
      if (!TAG_KEYS.has(k)) continue;
      const s = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
      out[k] = TAG_VALUE.test(s) ? s : REDACTED;
    }
  }
  return out;
}

/** Absolute file names keep only the part inside the project or a dependency; URLs keep the path only. */
export function scrubFilename(f: unknown): string {
  const s = String(f ?? '').split(/[?#]/)[0]!.replace(/^[a-z]+:\/\/[^/]*/i, '');
  const m = /(?:^|\/)(node_modules\/.+|dist\/.+|src\/.+|assets\/.+)$/.exec(s);
  return m ? m[1]! : s.split('/').slice(-2).join('/');
}

interface Frame { filename?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean; module?: string }
interface ExceptionValue { type?: string; value?: string; mechanism?: { type?: string; handled?: boolean }; stacktrace?: { frames?: Frame[] } }
export interface SentryishEvent {
  event_id?: string;
  type?: string;
  timestamp?: number;
  start_timestamp?: number;
  platform?: string;
  level?: string;
  release?: string;
  environment?: string;
  message?: string;
  logentry?: { message?: string };
  transaction?: string;
  fingerprint?: string[];
  exception?: { values?: ExceptionValue[] };
  tags?: Record<string, unknown>;
  contexts?: { trace?: Record<string, unknown>; runtime?: { name?: string; version?: string } } & Record<string, unknown>;
  spans?: { span_id?: string; parent_span_id?: string; trace_id?: string; op?: string; start_timestamp?: number; timestamp?: number; status?: string }[];
  sdk?: { name?: string; version?: string };
  request?: { method?: string } & Record<string, unknown>;
  [k: string]: unknown;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const idLike = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v) ? v : undefined);

function frame(f: Frame): Frame {
  return { filename: scrubFilename(f.filename), function: f.function ? scrubText(f.function, 100) : undefined, lineno: num(f.lineno), colno: num(f.colno), in_app: f.in_app === true, module: f.module ? scrubText(f.module, 100) : undefined };
}

/**
 * Rebuilds an error event from the allow-list. Dropped on purpose: request (body, cookies, headers, query string, url, user ip), user, breadcrumbs, extra, local variables,
 * server name, device and OS details, modules, and every context other than the trace ids and the runtime.
 */
export function scrubEvent<T extends SentryishEvent>(event: T): T {
  const out: SentryishEvent = { event_id: idLike(event.event_id), timestamp: num(event.timestamp), platform: event.platform, level: event.level, release: event.release ? scrubText(event.release, 80) : undefined, environment: event.environment ? scrubText(event.environment, 40) : undefined };
  if (event.type === 'transaction') return scrubTransaction(event) as T;
  const message = event.message ?? event.logentry?.message;
  if (message) out.message = scrubText(message);
  if (event.transaction) out.transaction = templatePath(event.transaction);
  if (event.fingerprint) out.fingerprint = event.fingerprint.slice(0, 5).map((f) => scrubText(f, 100));
  if (event.exception?.values) {
    out.exception = {
      values: event.exception.values.slice(0, 5).map((v) => ({
        type: scrubText(v.type, 100),
        value: scrubText(v.value),
        ...(v.mechanism ? { mechanism: { type: scrubText(v.mechanism.type, 60), handled: v.mechanism.handled === true } } : {}),
        ...(v.stacktrace?.frames ? { stacktrace: { frames: v.stacktrace.frames.slice(-40).map(frame) } } : {}),
      })),
    };
  }
  out.tags = tagsOf(event.tags);
  const trace = event.contexts?.trace as Record<string, unknown> | undefined;
  out.contexts = {
    ...(trace ? { trace: { trace_id: idLike(trace.trace_id), span_id: idLike(trace.span_id), parent_span_id: idLike(trace.parent_span_id), op: typeof trace.op === 'string' ? scrubText(trace.op, 40) : undefined, status: typeof trace.status === 'string' ? scrubText(trace.status, 40) : undefined } } : {}),
    ...(event.contexts?.runtime ? { runtime: { name: scrubText(event.contexts.runtime.name, 40), version: scrubText(event.contexts.runtime.version, 40) } } : {}),
  };
  if (event.sdk) out.sdk = { name: scrubText(event.sdk.name, 60), version: scrubText(event.sdk.version, 30) };
  // Only the HTTP method of the request is kept: the URL carries ids, tokens and query strings, and the route pattern is already in the tags.
  if (event.request?.method) out.request = { method: scrubText(event.request.method, 10) };
  return out as T;
}

export function scrubTransaction<T extends SentryishEvent>(event: T): T {
  const trace = event.contexts?.trace as Record<string, unknown> | undefined;
  const out: SentryishEvent = {
    event_id: idLike(event.event_id), type: 'transaction', platform: event.platform, release: event.release ? scrubText(event.release, 80) : undefined, environment: event.environment ? scrubText(event.environment, 40) : undefined,
    transaction: templatePath(event.transaction), start_timestamp: num(event.start_timestamp), timestamp: num(event.timestamp), tags: tagsOf(event.tags),
    contexts: { ...(trace ? { trace: { trace_id: idLike(trace.trace_id), span_id: idLike(trace.span_id), op: typeof trace.op === 'string' ? scrubText(trace.op, 40) : undefined, status: typeof trace.status === 'string' ? scrubText(trace.status, 40) : undefined } } : {}) },
    // Span descriptions and data carry URLs, SQL and header values: only the operation, timing and status stay.
    spans: (event.spans ?? []).slice(0, 50).map((s) => ({ span_id: idLike(s.span_id), parent_span_id: idLike(s.parent_span_id), trace_id: idLike(s.trace_id), op: typeof s.op === 'string' ? scrubText(s.op, 40) : undefined, start_timestamp: num(s.start_timestamp), timestamp: num(s.timestamp), status: typeof s.status === 'string' ? scrubText(s.status, 40) : undefined })),
  };
  if (event.sdk) out.sdk = { name: scrubText(event.sdk.name, 60), version: scrubText(event.sdk.version, 30) };
  return out as T;
}

// ---- what is not worth reporting --------------------------------------------------------------------------------------------------------------------------

const EXPECTED_CODES = new Set(['RATE_LIMITED', 'INGEST_BACKPRESSURE', 'REQUEST_TIMEOUT_CLIENT', 'PAYLOAD_TOO_LARGE', 'VALIDATION_ERROR', 'WORKSPACE_SUSPENDED']);
const ABORTED = /\b(aborted|ECONNRESET|EPIPE|socket hang up|client disconnected|terminated)\b/i;

/** Expected failures and client noise: validation, 4xx, rate limits, load shedding, aborted requests. */
export function isExpectedError(err: unknown): boolean {
  const e = err as { status?: number; code?: unknown; name?: string; message?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.status === 'number' && e.status < 500) return true;
  if (typeof e.code === 'string' && EXPECTED_CODES.has(e.code)) return true;
  if (e.name === 'ZodError' || e.name === 'AbortError') return true;
  return ABORTED.test(String(e.message ?? '')) && !(typeof e.status === 'number' && e.status >= 500);
}

/** Noisy-error limiter: at most `perFingerprint` events per fingerprint and `global` events per window, so one crash loop cannot drain a Sentry quota. */
export class NoiseLimiter {
  private perKey = new Map<string, { at: number; n: number }>();
  private global = { at: 0, n: 0 };
  constructor(private opts: { perFingerprint: number; global: number; windowMs: number; now: () => number }) {}

  allow(fingerprint: string): boolean {
    const now = this.opts.now();
    if (now - this.global.at >= this.opts.windowMs) this.global = { at: now, n: 0 };
    if (this.global.n >= this.opts.global) return false;
    let e = this.perKey.get(fingerprint);
    if (!e || now - e.at >= this.opts.windowMs) {
      e = { at: now, n: 0 };
      if (this.perKey.size > 500) this.perKey.clear();
      this.perKey.set(fingerprint, e);
    }
    if (e.n >= this.opts.perFingerprint) return false;
    e.n++;
    this.global.n++;
    return true;
  }
}

/** Stable identity of an error for grouping and limiting: type, message without numbers and ids, and the first application frame. */
export function fingerprintOf(event: SentryishEvent): string {
  const v = event.exception?.values?.[event.exception.values.length - 1];
  const top = [...(v?.stacktrace?.frames ?? [])].reverse().find((f) => f.in_app) ?? v?.stacktrace?.frames?.at(-1);
  return [v?.type ?? event.level ?? 'event', scrubText(v?.value ?? event.message ?? '', 120).replace(/\d+/g, 'N'), top ? `${scrubFilename(top.filename)}:${top.function ?? ''}` : ''].join('|');
}
