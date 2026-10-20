/**
 * Edge-side protection, in front of the origin's own limiter (which stays authoritative).
 *
 *  1. Workers Rate Limiting binding (`RL_EVENTS`, `RL_FORMS`): cheap, local to the Cloudflare location, counts per key in short periods.
 *     Right for floods; not exact globally (each location counts separately).
 *  2. Durable Object GCRA (`RL_DO`): one object per key, exact worldwide, one extra hop. Used for forms and checkout when bound.
 *
 * Both fail OPEN: a limiter outage must not take down lead capture. The origin's `public.forms`/`public.checkout` policies still apply.
 */

export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface DurableObjectStubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface RateEnv {
  RL_EVENTS?: RateLimitBinding;
  RL_FORMS?: RateLimitBinding;
  RL_DO?: DurableObjectNamespaceLike;
  /** Durable Object policy: requests per minute and burst, per client IP. */
  EDGE_FORMS_PER_MINUTE?: string;
  EDGE_FORMS_BURST?: string;
}

export type Kind = 'events' | 'forms';

export function classify(method: string, pathname: string): Kind | null {
  if (method !== 'POST') return null;
  if (pathname === '/api/public/events') return 'events';
  if (/^\/api\/public\/(forms|checkout)\//.test(pathname)) return 'forms';
  return null;
}

const json = (status: number, policy: string, retryAfter: number): Response =>
  new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and retry later.', retry_after_s: retryAfter, policy } }), {
    status,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter), 'ratelimit-policy': `"${policy}"`, ratelimit: `"${policy}";r=0;t=${retryAfter}`, 'cache-control': 'no-store' },
  });

/** Returns a 429 response when the request must be refused at the edge, else null. */
export async function edgeLimit(env: RateEnv, request: Request, clientIp: string): Promise<Response | null> {
  const url = new URL(request.url);
  const kind = classify(request.method, url.pathname);
  if (!kind) return null;
  const key = `${kind}:${clientIp}`;
  try {
    const binding = kind === 'events' ? env.RL_EVENTS : env.RL_FORMS;
    if (binding && !(await binding.limit({ key })).success) return json(429, `edge.${kind}`, 10);
    if (kind === 'forms' && env.RL_DO) {
      const stub = env.RL_DO.get(env.RL_DO.idFromName(key));
      const res = await stub.fetch('https://do/limit', {
        method: 'POST',
        body: JSON.stringify({ perMinute: Number(env.EDGE_FORMS_PER_MINUTE ?? 30), burst: Number(env.EDGE_FORMS_BURST ?? 10) }),
      });
      if (res.status === 429) return json(429, 'edge.forms.global', Number(res.headers.get('retry-after') ?? 5));
    }
  } catch {
    return null; // fail open
  }
  return null;
}

/** GCRA, the same arithmetic as the origin (server/src/ratelimit/math.ts); a test pins them together. */
export function gcra(tatIn: number | undefined, now: number, emissionMs: number, capacity: number, cost: number) {
  const EPS = 0.05;
  const tat = tatIn === undefined || tatIn < now ? now : tatIn;
  const tau = emissionMs * capacity;
  const newTat = tat + cost * emissionMs;
  const diff = newTat - now;
  if (diff > tau + EPS) return { allowed: false as const, newTat: tat, retryAfterMs: Math.max(1, Math.ceil(diff - tau - EPS)) };
  return { allowed: true as const, newTat, retryAfterMs: 0 };
}

interface DurableObjectStateLike {
  storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> };
}

/** Durable Object: one instance per key; requests to one object are serialised by the runtime, so the read-modify-write is atomic. */
export class RateLimiterDO {
  constructor(
    private state: DurableObjectStateLike,
    private now: () => number = () => Date.now(),
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { perMinute, burst } = (await request.json()) as { perMinute: number; burst: number };
    const t = this.now();
    const tat = await this.state.storage.get<number>('tat');
    const r = gcra(tat, t, 60_000 / perMinute, burst, 1);
    if (!r.allowed) return new Response(null, { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(r.retryAfterMs / 1000))) } });
    await this.state.storage.put('tat', r.newTat);
    return new Response(null, { status: 204 });
  }
}
