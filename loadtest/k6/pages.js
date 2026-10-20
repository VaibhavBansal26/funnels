// k6: public page traffic against the edge. Expect >= 99% cache hits (x-edge-cache: hit) and a flat p99. docs/CLOUD-LOADTEST.md step 3.
//   k6 run -e BASE_URL=https://offers.example.com -e PATHS=/promo,/promo/thanks -e TARGET_RPS=5000 loadtest/k6/pages.js
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const TARGET = Number(__ENV.TARGET_RPS || 1000);
const PATHS = (__ENV.PATHS || '/').split(',');
const hit = new Rate('edge_cache_hit');
export const options = {
  scenarios: { pages: { executor: 'constant-arrival-rate', rate: TARGET, timeUnit: '1s', duration: __ENV.DURATION || '5m', preAllocatedVUs: Math.ceil(TARGET / 50), maxVUs: Math.ceil(TARGET / 5) } },
  thresholds: { http_req_failed: ['rate<0.001'], http_req_duration: ['p(99)<200'], edge_cache_hit: ['rate>0.99'] },
};
export default function () {
  const res = http.get((__ENV.BASE_URL || 'http://localhost:3000') + PATHS[Math.floor(Math.random() * PATHS.length)], { headers: { 'user-agent': 'Mozilla/5.0 (k6) Chrome/120' } });
  hit.add(res.headers['X-Edge-Cache'] === 'hit' || res.headers['Cf-Cache-Status'] === 'HIT');
  check(res, { '200': (r) => r.status === 200 });
}
