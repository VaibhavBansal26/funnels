import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { fingerprintOf, isExpectedError, NoiseLimiter, scrubEvent, scrubTransaction, templatePath, type SentryishEvent } from './scrub.js';

/**
 * Optional Sentry error monitoring (docs/MONITORING.md, ADR 0046). Off unless SENTRY_DSN is set: with no DSN `createMonitor` returns an inert object and `@sentry/node` is
 * never imported, so there is no network access and no overhead. With a DSN everything that leaves the process passes the allow-list scrubber in ./scrub.ts.
 */
export interface MonitorContext {
  requestId?: string;
  /** Route PATTERN (`/api/funnels/:id`), never the raw URL. */
  route?: string;
  workspaceId?: string;
  plan?: string;
  kind?: 'request' | 'job' | 'process' | 'test';
  jobType?: string;
}

export interface RequestSpan {
  end(route: string, status: number): void;
}

export interface Monitor {
  readonly enabled: boolean;
  readonly info: { environment: string; release: string | null; tracesSampleRate: number; dsnHost: string | null; webEnabled: boolean };
  /** Reports an unexpected error (expected ones, such as 4xx and rate limits, are ignored). Returns the Sentry event id, or null when nothing was sent. */
  captureError(err: unknown, ctx?: MonitorContext): string | null;
  /** A sampled performance transaction for one request; null when tracing is off or this request is not sampled. */
  startRequest(method: string): RequestSpan | null;
  flush(timeoutMs?: number): Promise<boolean>;
  /** Flushes and shuts the SDK down (graceful shutdown). */
  close(timeoutMs?: number): Promise<boolean>;
}

/** Stable, non-reversible tag for a workspace: the only identity that ever reaches Sentry. */
export const workspaceTag = (workspaceId: string): string => createHash('sha256').update(`workspace:${workspaceId}`).digest('hex').slice(0, 12);

const KEEP_INTEGRATIONS = new Set(['EventFilters', 'FunctionToString', 'LinkedErrors', 'Dedupe', 'NodeSystemError', 'OnUncaughtException']);
const DSN = /^https?:\/\/[^@\s/]+@[^/\s]+(?:\/[^/\s]+)*\/\d+$/;
export const isValidDsn = (v: unknown): v is string => typeof v === 'string' && DSN.test(v.trim());
const dsnHost = (dsn: string) => dsn.replace(/^https?:\/\/[^@]*@/, '').split('/')[0] ?? null;

export const releaseOf = (c: Pick<Config, 'SENTRY_RELEASE' | 'RENDER_GIT_COMMIT' | 'GIT_SHA'>): string | null => c.SENTRY_RELEASE || c.RENDER_GIT_COMMIT || c.GIT_SHA || null;
export const environmentOf = (c: Pick<Config, 'SENTRY_ENVIRONMENT' | 'NODE_ENV'>): string => c.SENTRY_ENVIRONMENT || c.NODE_ENV;

export const NOOP_MONITOR: Monitor = {
  enabled: false,
  info: { environment: 'none', release: null, tracesSampleRate: 0, dsnHost: null, webEnabled: false },
  captureError: () => null,
  startRequest: () => null,
  flush: async () => true,
  close: async () => true,
};

/** What the browser is told at runtime (GET /api/config): null when no valid DSN is configured. */
export function webMonitoringConfig(config: Config): { dsn: string; environment: string; release: string | null; tracesSampleRate: number } | null {
  const dsn = (config.SENTRY_WEB_DSN || config.SENTRY_DSN || '').trim();
  return isValidDsn(dsn) ? { dsn, environment: environmentOf(config), release: releaseOf(config), tracesSampleRate: 0 } : null;
}

export async function createMonitor(config: Config, opts: { log?: Pick<Logger, 'warn' | 'info'>; transport?: unknown; now?: () => number } = {}): Promise<Monitor> {
  const raw = (config.SENTRY_DSN ?? '').trim();
  if (!raw) return NOOP_MONITOR;
  if (!isValidDsn(raw)) {
    opts.log?.warn('SENTRY_DSN is not a valid DSN: error monitoring stays off', {});
    return NOOP_MONITOR;
  }
  let Sentry: typeof import('@sentry/node');
  try {
    Sentry = await import('@sentry/node');
  } catch (e) {
    opts.log?.warn('@sentry/node could not be loaded: error monitoring stays off', { error: (e as Error).message });
    return NOOP_MONITOR;
  }
  const environment = environmentOf(config);
  const release = releaseOf(config);
  const limiter = new NoiseLimiter({ perFingerprint: 5, global: 60, windowMs: 60_000, now: opts.now ?? Date.now });
  try {
    Sentry.init({
      dsn: raw,
      environment,
      ...(release ? { release } : {}),
      // @sentry/node 11 replaced the `sendDefaultPii` flag by `dataCollection`: every category is switched off. `sendDefaultPii: false` is passed as well so an older SDK behaves the same.
      sendDefaultPii: false,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
      tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
      maxBreadcrumbs: 0,
      // `static` = one transaction event per request, which beforeSendTransaction scrubs (the v11 default streams spans, which would bypass it).
      traceLifecycle: 'static',
      beforeBreadcrumb: () => null,
      // The scrubber rebuilds the event from an allow-list; the limiter then drops repeats of the same error (test events from the admin panel always pass).
      beforeSend: (event) => {
        const clean = scrubEvent(event as unknown as SentryishEvent) as unknown as typeof event;
        if ((clean.tags as Record<string, string> | undefined)?.kind === 'test') return clean;
        return limiter.allow(fingerprintOf(event as unknown as SentryishEvent)) ? clean : null;
      },
      beforeSendTransaction: (event) => scrubTransaction(event as unknown as SentryishEvent) as unknown as typeof event,
      // A rejected promise nobody handled is a crash, as it is without Sentry (the SDK's default would only warn).
      // An explicit keep-list: no console/http/fetch breadcrumbs or spans, no request data, no source lines, no local variables, no module list, no release-health sessions.
      integrations: (defaults) => [...defaults.filter((i) => KEEP_INTEGRATIONS.has(i.name)), Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })],
      sendClientReports: false,
      ...(opts.transport ? { transport: opts.transport as never } : {}),
    } as Parameters<typeof Sentry.init>[0]);
  } catch (e) {
    opts.log?.warn('Sentry could not be started: error monitoring stays off', { error: (e as Error).message });
    return NOOP_MONITOR;
  }
  opts.log?.info('error monitoring is on', { environment, release, tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE });

  return {
    enabled: true,
    info: { environment, release, tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE, dsnHost: dsnHost(raw), webEnabled: webMonitoringConfig(config) !== null },
    captureError(err, ctx = {}) {
      if (ctx.kind !== 'test' && isExpectedError(err)) return null;
      try {
        return Sentry.withScope((scope) => {
          scope.setLevel('error');
          const tags: Record<string, string> = { kind: ctx.kind ?? 'request' };
          if (ctx.requestId) tags.request_id = ctx.requestId.slice(0, 64);
          if (ctx.route) tags.route = templatePath(ctx.route);
          if (ctx.workspaceId) tags.workspace = workspaceTag(ctx.workspaceId);
          if (ctx.plan) tags.plan = ctx.plan;
          if (ctx.jobType) tags.job_type = ctx.jobType;
          scope.setTags(tags);
          return Sentry.captureException(err);
        });
      } catch {
        return null; // monitoring must never take a request down
      }
    },
    startRequest(method) {
      if (!(config.SENTRY_TRACES_SAMPLE_RATE > 0)) return null;
      try {
        const span = Sentry.startInactiveSpan({ name: `${method} request`, op: 'http.server', forceTransaction: true, attributes: { 'sentry.source': 'route' } });
        return {
          end(route, status) {
            try {
              span.updateName(`${method} ${templatePath(route)}`);
              span.setStatus({ code: status >= 500 ? 2 : 1 });
              span.end();
            } catch {
              /* ignored */
            }
          },
        };
      } catch {
        return null;
      }
    },
    flush: (ms = 2000) => Sentry.flush(ms).catch(() => false),
    close: (ms = 2000) => Sentry.close(ms).catch(() => false),
  };
}
