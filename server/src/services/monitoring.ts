import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { audit } from './audit.js';

/** What an administrator sees about error monitoring. No DSN, key or token is ever returned: only the ingest host. */
export function monitoringStatus(deps: Deps) {
  const i = deps.monitor.info;
  return { enabled: deps.monitor.enabled, environment: deps.monitor.enabled ? i.environment : null, release: i.release, tracesSampleRate: i.tracesSampleRate, ingestHost: i.dsnHost, browserEnabled: i.webEnabled };
}

/**
 * Sends one clearly labelled test error so setup can be verified in Sentry. It is the only error this app ever creates on purpose; it bypasses the noise limiter,
 * carries no user data and is audited.
 */
export async function sendTestError(deps: Deps, auth: Auth, ip?: string) {
  const at = deps.now().toISOString();
  const eventId = deps.monitor.captureError(new Error(`Funnels test error: sent by a platform administrator at ${at}`), { kind: 'test', route: '/api/admin/monitoring/test' });
  const flushed = deps.monitor.enabled ? await deps.monitor.flush(3000) : false;
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.monitoring.test', detail: { enabled: deps.monitor.enabled, eventId }, ip });
  return { ...monitoringStatus(deps), sent: eventId !== null, eventId, flushed };
}
