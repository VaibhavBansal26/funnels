// k6: analytics reads over long ranges must stay under 300 ms p95 from rollups/sketches. docs/CLOUD-LOADTEST.md step 6.
//   k6 run -e BASE_URL=https://app.example.com -e TOKEN=<jwt> -e FUNNELS=fn_a -e TARGET_RPS=50 loadtest/k6/analytics.js
import http from 'k6/http';
import { check } from 'k6';

const FUNNELS = (__ENV.FUNNELS || '').split(',').filter(Boolean);
if (!FUNNELS.length) throw new Error('set FUNNELS=funnelId[,funnelId...]');
const RANGES = [['2026-10-01', '2026-10-07'], ['2026-09-01', '2026-10-15'], ['2026-01-01', '2026-10-15']];
export const options = {
  scenarios: { analytics: { executor: 'constant-arrival-rate', rate: Number(__ENV.TARGET_RPS || 50), timeUnit: '1s', duration: __ENV.DURATION || '3m', preAllocatedVUs: 20, maxVUs: 200 } },
  thresholds: { http_req_failed: ['rate<0.001'], http_req_duration: ['p(95)<300'] },
};
export default function () {
  const [from, to] = RANGES[Math.floor(Math.random() * RANGES.length)];
  const f = FUNNELS[Math.floor(Math.random() * FUNNELS.length)];
  const res = http.get(`${__ENV.BASE_URL}/api/funnels/${f}/analytics?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${__ENV.TOKEN}` } });
  check(res, { '200': (r) => r.status === 200 });
}
