import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AppError, badRequest, parse } from '../errors.js';
import type { Deps } from '../deps.js';
import { BEACON_JS } from '../beacon.js';
import { PublicEventInput, recordPublicEvent } from '../services/events.js';
import { SubmitInput, submitForm } from '../services/leads.js';
import { CheckoutInput, checkout } from '../services/orders.js';
import { enforceInHandler } from '../ratelimit/http.js';
import { clientIp, trustedCountry } from '../ratelimit/ip.js';
import { AttributionInput, recordAttribution } from '../services/attribution.js';
import { corsOriginFor } from '../services/cors.js';
import { publicReviews } from '../services/googlereviews.js';

const tooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
const limitTo = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: () => {
      throw tooLarge();
    },
  });

/** Reads a JSON or form-encoded body. sendBeacon posts text/plain, so the content type is not trusted. */
async function readBody(c: Context): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody();
    const { _hp, ...fields } = form as Record<string, string>;
    return { fields, _hp };
  }
  const text = await c.req.text();
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function publicRoutes(deps: Deps): Hono {
  const r = new Hono();
  const idOf = (v: unknown) => (typeof v === 'object' && v !== null && typeof (v as { funnelId?: unknown }).funnelId === 'string' ? String((v as { funnelId: string }).funnelId).slice(0, 64) : '-');

  r.get('/beacon.js', (c) => c.body(BEACON_JS, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' }));

  r.use('/api/public/*', async (c, next) => {
    const allow = await corsOriginFor(deps, c.req.header('origin'));
    if (allow) c.header('Access-Control-Allow-Origin', allow);
    if (allow && allow !== '*') c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Headers', 'content-type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  // Review data for a "Google reviews" block (cached; see docs/REVIEWS.md). Readable cross-origin only by the origins the public API allows (customer domains, Pages hosts).
  r.get('/public/reviews/:token', async (c) => {
    const allow = await corsOriginFor(deps, c.req.header('origin'));
    if (allow) c.header('Access-Control-Allow-Origin', allow);
    if (allow && allow !== '*') c.header('Vary', 'Origin');
    c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
    return c.json(await publicReviews(deps, c.req.param('token')));
  });

  r.post('/api/public/events', limitTo(8 * 1024), async (c) => {
    const raw = await readBody(c);
    await enforceInHandler(deps, c, 'public.events', { scope: idOf(raw) });
    const input = parse(PublicEventInput, raw);
    return c.json(await recordPublicEvent(deps, input, c.req.header('user-agent'), { country: trustedCountry(c, deps.config) }), 202);
  });

  r.post('/api/public/attribution', limitTo(4 * 1024), async (c) => {
    const raw = await readBody(c);
    await enforceInHandler(deps, c, 'public.events', { scope: idOf(raw) });
    const input = parse(AttributionInput, raw);
    return c.json(await recordAttribution(deps, input, { ip: clientIp(c, deps.config), userAgent: c.req.header('user-agent') }), 202);
  });

  r.post('/api/public/forms/:funnelId/:stepId/:blockId', limitTo(64 * 1024), async (c) => {
    const input = parse(SubmitInput, await readBody(c));
    return c.json(await submitForm(deps, { funnelId: c.req.param('funnelId'), stepId: c.req.param('stepId'), blockId: c.req.param('blockId'), input }), 200);
  });

  r.post('/api/public/checkout/:funnelId/:stepId/:blockId', limitTo(64 * 1024), async (c) => {
    const input = parse(CheckoutInput, await readBody(c));
    return c.json(await checkout(deps, { funnelId: c.req.param('funnelId'), stepId: c.req.param('stepId'), blockId: c.req.param('blockId'), input }), 200);
  });
  return r;
}
