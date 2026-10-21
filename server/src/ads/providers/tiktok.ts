import { hashedUser } from '../hash.js';
import { clip, nonEmpty, round2, type BuiltRequest, type ConversionEvent, type ConversionName, type ConversionsProvider, type IntegrationTarget, type Outcome, type PreparedCall } from './types.js';

/**
 * TikTok Events API 2.0 (web). VERIFIED ONLY AGAINST SECONDARY DESCRIPTIONS OF THE DOCUMENTED SHAPES (fake in tests): TikTok's own reference page is a client-rendered
 * portal that could not be read as text here, so the field names come from the portal outline (https://business-api.tiktok.com/portal/docs?id=1771101027431425) and
 * integration guides that all agree: POST {base}/open_api/v1.3/event/track/ with header `Access-Token`, body { event_source: "web", event_source_id: <pixel code>,
 * test_event_code?, data: [{ event, event_time (unix seconds), event_id, user{ttclid, ttp, email, phone_number, external_id, ip, user_agent}, properties{currency,
 * value, contents[], content_type, order_id}, page{url} }] }. Emails, phone numbers (E.164) and external ids are SHA-256 hashed; deduplication is by pixel code +
 * event + event_id within 48 hours. Check the real response in the delivery log of a test event before relying on it.
 */
const NAMES: Record<ConversionName, string> = { Lead: 'SubmitForm', Purchase: 'CompletePayment' };

export const tiktokProvider: ConversionsProvider = {
  id: 'tiktok',
  label: 'TikTok Events API',
  eventName: (n) => NAMES[n],
  build(e: ConversionEvent, t: IntegrationTarget, opts): BuiltRequest {
    const u = e.user;
    const hu = hashedUser({ email: u.email, phone: u.phone, externalId: u.externalId, defaultCallingCode: u.defaultCallingCode }, 'tiktok');
    const items = e.items ?? [];
    const event = nonEmpty({
      event: NAMES[e.name],
      event_time: Math.floor(e.timeMs / 1000),
      event_id: e.eventId,
      user: nonEmpty({ ttclid: clip(u.ttclid, 256), ttp: clip(u.ttp, 256), email: hu.email, phone: hu.phone_number, external_id: hu.external_id, ip: clip(u.ip, 64), user_agent: clip(u.userAgent, 512) }),
      properties: nonEmpty({
        currency: e.currency?.toUpperCase(),
        value: e.value !== undefined ? round2(e.value) : undefined,
        content_type: items.length ? 'product' : undefined,
        contents: items.map((i) => ({ content_id: i.id, content_name: clip(i.name, 120), quantity: i.quantity, price: i.price })),
        order_id: e.orderId,
      }),
      page: nonEmpty({ url: clip(e.sourceUrl, 1000) }),
    });
    return { path: '/open_api/v1.3/event/track/', body: nonEmpty({ event_source: 'web', event_source_id: t.pixelId, test_event_code: opts.test ? (t.testEventCode ?? undefined) : undefined, data: [event] }) };
  },
  prepare(built, t, secret): PreparedCall {
    return { url: `${t.base.replace(/\/$/, '')}${built.path}`, headers: { 'content-type': 'application/json', 'access-token': secret }, body: JSON.stringify(built.body) };
  },
  interpret(status, text): Outcome {
    let j: { code?: number; message?: string } | null = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (status >= 200 && status < 300 && j?.code === 0) return { ok: true };
    const msg = j?.code !== undefined ? `TikTok code ${j.code}: ${j.message ?? ''}`.trim() : `HTTP ${status}: ${text.slice(0, 200)}`;
    return { ok: false, retry: status >= 500 || status === 429 || status === 408 || (j?.code !== undefined && j.code >= 50000), message: msg };
  },
};
