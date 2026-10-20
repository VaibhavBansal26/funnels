import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Deps } from './deps.js';

/** Prometheus metrics. Labels are bounded: route patterns (not raw paths), status classes, fixed job states. */
export function createMetrics(deps: Deps) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({ name: 'funnels_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry] });
  const duration = new Histogram({ name: 'funnels_http_request_duration_seconds', help: 'HTTP latency', labelNames: ['route'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry] });
  new Gauge({ name: 'funnels_event_buffer_depth', help: 'Queued analytics events', registers: [registry], collect() { this.set(deps.events.depth); } });
  new Gauge({ name: 'funnels_events_dropped_total', help: 'Events dropped at flush', registers: [registry], collect() { this.set(deps.events.dropped); } });
  new Gauge({ name: 'funnels_page_cache_entries', help: 'Rendered pages cached', registers: [registry], collect() { this.set(deps.pageCache.size); } });
  new Gauge({
    name: 'funnels_jobs', help: 'Jobs by status', labelNames: ['status'], registers: [registry],
    async collect() {
      const rows = await deps.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
      for (const s of ['queued', 'running', 'done', 'dead']) this.set({ status: s }, rows.find((r) => r.status === s)?.n ?? 0);
    },
  });
  // Rate limiter: bounded labels only (policy ids and a handful of outcomes), never keys.
  const decisions = new Counter({ name: 'funnels_ratelimit_decisions_total', help: 'Rate limit decisions by policy and outcome', labelNames: ['policy', 'outcome'], registers: [registry] });
  const storeLatency = new Histogram({ name: 'funnels_ratelimit_store_seconds', help: 'Rate limit store call latency (Redis)', labelNames: ['ok'], buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05], registers: [registry] });
  const leases = new Counter({ name: 'funnels_ratelimit_lease_total', help: 'Local token lease tier: hit (served locally), refill (leased a batch from the store), direct (exact store call)', labelNames: ['policy', 'result'], registers: [registry] });
  const breaker = new Gauge({ name: 'funnels_ratelimit_breaker_state', help: 'Rate limit store circuit breaker: 0 closed, 1 half-open, 2 open', registers: [registry] });
  new Gauge({
    name: 'funnels_ratelimit_penalty_box', help: 'Subjects currently in the penalty box (in-memory store only; with Redis see decisions{outcome="blocked"})', registers: [registry],
    collect() { this.set((deps.limiter.store as { blockedCount?: () => number }).blockedCount?.() ?? 0); },
  });
  const flights = new Counter({ name: 'funnels_flights_total', help: 'Request coalescing: leader, local (waited for an in-process computation), shared (took another process\'s result), fallback', labelNames: ['name', 'outcome'], registers: [registry] });
  deps.flights.hooks.outcome = (name, outcome) => flights.inc({ name, outcome });
  Object.assign(deps.limiter.hooks, {
    decision: (policy: string, outcome: string) => decisions.inc({ policy, outcome }),
    lease: (policy: string, result: string) => leases.inc({ policy, result }),
    store: (seconds: number, ok: boolean) => storeLatency.observe({ ok: String(ok) }, seconds),
    breaker: (s: string) => breaker.set(s === 'closed' ? 0 : s === 'half_open' ? 1 : 2),
    logLimited: (i: { policyId: string; outcome: string; sample: number }) => deps.log.warn('rate limited', { policy: i.policyId, outcome: i.outcome, sampled_one_in: i.sample }),
  });
  return {
    registry,
    observe(method: string, route: string, status: number, seconds: number) {
      requests.inc({ method, route, status: `${Math.floor(status / 100)}xx` });
      duration.observe({ route }, seconds);
    },
  };
}
