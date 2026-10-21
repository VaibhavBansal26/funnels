import { hashedUser } from '../hash.js';
import { clip, errorText, nonEmpty, round2, type BuiltRequest, type ConversionEvent, type ConversionsProvider, type IntegrationTarget, type Outcome, type PreparedCall } from './types.js';

/**
 * Meta Conversions API. VERIFIED ONLY AGAINST THE DOCUMENTED SHAPES (fake in tests), not against Meta.
 * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api (POST /{version}/{pixel_id}/events, body `data[]`, `test_event_code`, `access_token`),
 * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters (hashing),
 * https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events (event_name + event_id).
 * The access token travels in the JSON body (the endpoint accepts it as a form/body field), so it never appears in a URL or an access log.
 */
export const metaProvider: ConversionsProvider = {
  id: 'meta',
  label: 'Meta Conversions API',
  eventName: (n) => n,
  build(e: ConversionEvent, t: IntegrationTarget, opts): BuiltRequest {
    const u = e.user;
    const userData = nonEmpty({
      ...hashedUser({ email: u.email, phone: u.phone, name: u.name, city: u.city, state: u.state, zip: u.zip, country: u.country, externalId: u.externalId, defaultCallingCode: u.defaultCallingCode }, 'meta'),
      client_ip_address: clip(u.ip, 64),
      client_user_agent: clip(u.userAgent, 512),
      fbc: clip(u.fbc, 256),
      fbp: clip(u.fbp, 256),
    });
    const items = e.items ?? [];
    const custom = nonEmpty({
      currency: e.currency?.toUpperCase(),
      value: e.value !== undefined ? round2(e.value) : undefined,
      content_ids: items.map((i) => i.id),
      contents: items.map((i) => ({ id: i.id, quantity: i.quantity, item_price: i.price })),
      content_type: items.length ? 'product' : undefined,
      num_items: items.length || undefined,
      order_id: e.orderId,
    });
    const event = nonEmpty({
      event_name: e.name,
      event_time: Math.floor(e.timeMs / 1000),
      event_id: e.eventId,
      event_source_url: clip(e.sourceUrl, 1000),
      action_source: 'website',
      user_data: userData,
      custom_data: custom,
    });
    return { path: `/${t.version ?? 'v23.0'}/${t.pixelId}/events`, body: nonEmpty({ data: [event], test_event_code: opts.test ? (t.testEventCode ?? undefined) : undefined }) };
  },
  prepare(built, t, secret): PreparedCall {
    return { url: `${t.base.replace(/\/$/, '')}${built.path}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...built.body, access_token: secret }) };
  },
  interpret(status, text): Outcome {
    let j: { events_received?: number; error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } } | null = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (status >= 200 && status < 300 && (j?.events_received ?? 0) >= 1 && !j?.error) return { ok: true };
    const msg = j?.error ? `${j.error.message ?? 'error'} (code ${j.error.code ?? '?'}${j.error.error_subcode ? `/${j.error.error_subcode}` : ''}${j.error.fbtrace_id ? `, trace ${j.error.fbtrace_id}` : ''})` : `HTTP ${status}: ${text.slice(0, 200)}`;
    if (status >= 200 && status < 300) return { ok: false, retry: false, message: `Meta accepted the request but received no event: ${msg}` };
    // Rate limits (4, 17, 32, 613, 80004), temporary and unknown errors (1, 2) and server errors are worth another try; everything else (bad token 190, invalid parameter 100, permissions 200) is not.
    const retryCodes = new Set([1, 2, 4, 17, 32, 341, 613, 80004]);
    return { ok: false, retry: status >= 500 || status === 429 || status === 408 || (j?.error?.code !== undefined && retryCodes.has(j.error.code)), message: msg };
  },
};
export { errorText };
