// k6 script for the cloud validation run (docs/CLOUD-LOADTEST.md). Open model: a fixed ARRIVAL RATE, so a slow origin cannot hide behind fewer requests.
// Run standalone:  k6 run -e BASE_URL=https://app.example.com -e FUNNELS=fn_a:stp_a -e TARGET_RPS=2000 loadtest/k6/events.js
// Run distributed: deploy/k6/testrun.yaml (k6-operator). TARGET_RPS and PEAK_RPS are totals; in distributed mode each pod runs its share automatically.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TARGET = Number(__ENV.TARGET_RPS || 1000);
const PEAK = Number(__ENV.PEAK_RPS || TARGET * 5);
const DURATION = __ENV.DURATION || '5m';
const FUNNELS = (__ENV.FUNNELS || '').split(',').filter(Boolean).map((p) => p.split(':'));
if (FUNNELS.length === 0) throw new Error('set FUNNELS=funnelId:stepId[,funnelId:stepId...]');
const HEAVY = Number(__ENV.HEAVY_SHARE || 0); // fraction of traffic sent to funnel #1 (noisy neighbour test: 0.9 with 10 funnels)
const shed = new Counter('ingest_backpressure_503');

export const options = {
  scenarios: {
    sustained: { executor: 'constant-arrival-rate', rate: TARGET, timeUnit: '1s', duration: DURATION, preAllocatedVUs: Math.ceil(TARGET / 50), maxVUs: Math.ceil(TARGET / 10) },
    burst: { executor: 'ramping-arrival-rate', startTime: DURATION, startRate: TARGET, timeUnit: '1s', preAllocatedVUs: Math.ceil(PEAK / 50), maxVUs: Math.ceil(PEAK / 10), stages: [{ target: PEAK, duration: '30s' }, { target: PEAK, duration: '2m' }, { target: TARGET, duration: '30s' }] },
  },
  // These fail the run (and therefore nightly CI) when the SLOs regress. They are the targets of SCALE-TARGETS.md, not measured results.
  thresholds: {
    'http_req_failed{scenario:sustained}': ['rate<0.001'],
    'http_req_duration{scenario:sustained}': ['p(99)<300'],
    'http_req_failed{scenario:burst}': ['rate<0.01'],        // a spike may shed with 503 + Retry-After, never fail otherwise
    checks: ['rate>0.999'],
  },
};

let seq = 0;
export default function () {
  const heavy = HEAVY > 0 && Math.random() < HEAVY;
  const [funnelId, stepId] = heavy ? FUNNELS[0] : FUNNELS[Math.floor(Math.random() * FUNNELS.length)];
  const body = JSON.stringify({ funnelId, stepId, type: 'page_view', visitorId: `k6-${__VU}-${__ITER}-${seq++}-${Math.random().toString(36).slice(2, 8)}` });
  const res = http.post(`${BASE}/api/public/events`, body, { headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (k6) Chrome/120' }, tags: { funnel: heavy ? 'heavy' : 'other' } });
  if (res.status === 503 || res.status === 429) shed.add(1);
  check(res, { 'accepted (202) or deliberately shed (429/503 with Retry-After)': (r) => r.status === 202 || ((r.status === 429 || r.status === 503) && !!r.headers['Retry-After']) });
}
