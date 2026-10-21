import { scrubEvent } from '@monitoring-scrub';

/**
 * Optional browser error monitoring (docs/MONITORING.md). Off unless the server says so: at start the app asks `GET /api/config`; with no DSN nothing else happens (no
 * Sentry code is downloaded, no request goes to Sentry). `@sentry/react` is loaded with a dynamic import, so it is a separate chunk outside the main bundle budget.
 * Sent: errors from this app's own scripts, scrubbed by the same allow-list as the server (shared source), tagged with a hash of the workspace id. Not sent: session replay
 * (not installed), breadcrumbs, user identity, request data, page content, anything from the page builder's canvas or from published pages.
 */
export interface BrowserMonitoringConfig {
  dsn: string;
  environment: string;
  release: string | null;
  tracesSampleRate: number;
}

type SentryReact = typeof import('./sentryLoader');
let sentry: SentryReact | null = null;
let workspaceTag: string | null = null;

/** Same tag as the server's `workspaceTag`: sha256("workspace:<id>"), first 12 hex characters. */
export async function hashWorkspace(id: string): Promise<string> {
  const bytes = new TextEncoder().encode(`workspace:${id}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

export async function setMonitoringWorkspace(id: string | null): Promise<void> {
  workspaceTag = id ? await hashWorkspace(id) : null;
  sentry?.setTag('workspace', workspaceTag ?? 'none');
}

export const monitoringActive = (): boolean => sentry !== null;

/** Initialises Sentry in the browser when the server has a DSN. Never throws. */
export async function startMonitoring(opts: { fetchImpl?: typeof fetch; load?: () => Promise<SentryReact>; origin?: string } = {}): Promise<boolean> {
  try {
    const res = await (opts.fetchImpl ?? fetch)('/api/config', { credentials: 'omit' });
    if (!res.ok) return false;
    const cfg = ((await res.json()) as { monitoring?: BrowserMonitoringConfig | null }).monitoring;
    if (!cfg?.dsn) return false;
    const S = await (opts.load ?? (() => import('./sentryLoader')))();
    const origin = opts.origin ?? location.origin;
    S.init({
      dsn: cfg.dsn,
      environment: cfg.environment,
      ...(cfg.release ? { release: cfg.release } : {}),
      sendDefaultPii: false,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false, frameContextLines: 0 },
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      // Only errors that come from this app's own bundles: the builder canvas and published pages run other people's scripts.
      allowUrls: [`${origin}/assets/`],
      beforeSend: (event) => scrubEvent(event as never) as never,
      // No tracing, no replay, no breadcrumbs, no session tracking: only error capture (global error and unhandled rejection handlers) stays.
      integrations: (defaults) => defaults.filter((i) => !['Breadcrumbs', 'BrowserSession', 'HttpContext', 'BrowserTracing', 'Replay'].includes(i.name)),
    } as Parameters<SentryReact['init']>[0]);
    sentry = S;
    if (workspaceTag) S.setTag('workspace', workspaceTag);
    return true;
  } catch {
    sentry = null;
    return false;
  }
}

/** Called by the error boundaries; does nothing unless monitoring is active. The component stack is NOT sent (it names components, not data, but is of no use without source maps). */
export function reportRenderError(error: unknown): void {
  if (!sentry) return;
  try {
    sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { surface: 'react' } as never });
  } catch {
    /* ignored */
  }
}

/** Test hook. */
export function resetMonitoringForTests(): void {
  sentry = null;
  workspaceTag = null;
}
