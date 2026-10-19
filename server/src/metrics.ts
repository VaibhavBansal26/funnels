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
  return {
    registry,
    observe(method: string, route: string, status: number, seconds: number) {
      requests.inc({ method, route, status: `${Math.floor(status / 100)}xx` });
      duration.observe({ route }, seconds);
    },
  };
}
