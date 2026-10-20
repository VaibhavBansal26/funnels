import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A small Stripe client over fetch (no SDK, so no dependency and no hidden retries) and Stripe's webhook signature scheme. Requests are form-encoded the way
 * Stripe expects (`line_items[0][price_data][currency]=usd`), can target a connected account (`Stripe-Account`) and carry an idempotency key. Errors become
 * `StripeApiError` with Stripe's own code, so callers can tell a declined card from an outage.
 *
 * NOT VERIFIED AGAINST THE REAL STRIPE API in this repository: the tests run against an in-process fake that implements the endpoints used, modelled on
 * Stripe's documentation. Run the flows in Stripe test mode (docs/STRIPE.md) before relying on any of it.
 */
export class StripeApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    public code: string | undefined,
    message: string,
    public declineCode?: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

export function encodeForm(value: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) value.forEach((v, i) => encodeForm(v, `${prefix}[${i}]`, out));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) encodeForm(v, prefix ? `${prefix}[${k}]` : k, out);
  else out.push([prefix, String(value)]);
  return out;
}

export interface StripeOptions {
  secretKey: string;
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class StripeClient {
  private f: typeof fetch;
  constructor(private o: StripeOptions) {
    this.f = o.fetch ?? fetch;
  }

  async call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}, opts: { account?: string; idempotencyKey?: string } = {}): Promise<T> {
    const body = new URLSearchParams(encodeForm(params));
    const url = `${(this.o.base ?? 'https://api.stripe.com').replace(/\/$/, '')}${path}${method === 'GET' && body.size ? `?${body}` : ''}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.o.secretKey}`, 'stripe-version': '2024-06-20' };
    if (opts.account) headers['stripe-account'] = opts.account;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    if (method !== 'GET') headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await this.f(url, { method, headers, body: method === 'GET' ? undefined : body.toString(), signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* handled below */
    }
    if (!res.ok) {
      const e = (json as { error?: { type?: string; code?: string; message?: string; decline_code?: string } } | null)?.error;
      throw new StripeApiError(res.status, e?.type ?? 'api_error', e?.code, e?.message ?? `Stripe answered ${res.status}`, e?.decline_code);
    }
    return json as T;
  }
}

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` over `${t}.${rawBody}` with the endpoint secret; a stale timestamp is refused (replay). */
export function verifyStripeSignature(secret: string, header: string | undefined, rawBody: string, nowSec: number, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=') as [string, string]);
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length || Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  // Several v1 values appear during secret rotation: any may match. No early exit, constant work.
  let ok = false;
  for (const s of sigs) {
    const given = Buffer.from(s);
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}

export const signStripePayload = (secret: string, rawBody: string, t: number): string => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
