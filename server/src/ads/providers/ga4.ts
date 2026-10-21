import { createHash } from 'node:crypto';
import { hashedUser } from '../hash.js';
import { clip, nonEmpty, round2, type BuiltRequest, type ConversionEvent, type ConversionName, type ConversionsProvider, type IntegrationTarget, type Outcome, type PreparedCall } from './types.js';

/**
 * Google Analytics 4 Measurement Protocol. VERIFIED ONLY AGAINST THE DOCUMENTED SHAPES (fake in tests), not against Google.
 * Docs: https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events (POST /mp/collect?measurement_id=&api_secret=, body client_id + events[]),
 * https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference (limits; answers 2xx even for malformed data),
 * https://developers.google.com/analytics/devguides/collection/protocol/ga4/validating-events (POST /debug/mp/collect answers `validationMessages`),
 * https://developers.google.com/analytics/devguides/collection/protocol/ga4/user-data (user_data with sha256_* arrays and an address block).
 * Limits that matter: events may be backdated 72 hours; event names are 40 characters at most. Measurement Protocol cannot carry a gclid: ad attribution of these events
 * works through the GA4 <-> Google Ads link (conversion import), see docs/ADS.md.
 */
const NAMES: Record<ConversionName, string> = { Lead: 'generate_lead', Purchase: 'purchase' };

/** A GA4 client id has the shape `<number>.<number>`. The browser's own (from the `_ga` cookie) is used when reported; otherwise a stable one is derived from the visitor id. */
export function clientIdFor(e: ConversionEvent): string {
  const given = e.user.gaClientId;
  if (given && /^\d{4,12}\.\d{4,12}$/.test(given)) return given;
  const h = createHash('sha256').update(`ga:${e.user.externalId ?? e.eventId}`).digest();
  return `${h.readUInt32BE(0)}.${h.readUInt32BE(4)}`;
}

export const ga4Provider: ConversionsProvider = {
  id: 'ga4',
  label: 'Google Analytics 4 (Measurement Protocol)',
  eventName: (n) => NAMES[n],
  build(e: ConversionEvent, t: IntegrationTarget): BuiltRequest {
    const u = e.user;
    const hu = hashedUser({ email: u.email, phone: u.phone, name: u.name, zip: u.zip, country: u.country, defaultCallingCode: u.defaultCallingCode }, 'ga4');
    const address = nonEmpty({ sha256_first_name: hu.sha256_first_name, sha256_last_name: hu.sha256_last_name, postal_code: hu.postal_code, country: hu.country });
    const userData = nonEmpty({
      sha256_email_address: hu.sha256_email_address ? [hu.sha256_email_address] : undefined,
      sha256_phone_number: hu.sha256_phone_number ? [hu.sha256_phone_number] : undefined,
      address: Object.keys(address).length ? [address] : undefined,
    });
    const items = e.items ?? [];
    const sessionId = u.gaSessionId && /^\d{1,12}$/.test(u.gaSessionId) ? u.gaSessionId : undefined;
    const params = nonEmpty({
      currency: e.currency?.toUpperCase(),
      value: e.value !== undefined ? round2(e.value) : undefined,
      transaction_id: e.name === 'Purchase' ? e.orderId : undefined,
      items: items.length ? items.map((i) => ({ item_id: i.id, item_name: clip(i.name, 100), price: i.price, quantity: i.quantity })) : undefined,
      session_id: sessionId,
      engagement_time_msec: 1,
    });
    return {
      path: `/mp/collect?measurement_id=${encodeURIComponent(t.pixelId)}`,
      body: nonEmpty({
        client_id: clientIdFor(e),
        timestamp_micros: Math.min(e.timeMs, Date.now()) * 1000,
        user_data: Object.keys(userData).length ? userData : undefined,
        events: [{ name: NAMES[e.name], params }],
      }),
    };
  },
  prepare(built, t, secret, opts): PreparedCall {
    const path = opts.test ? built.path.replace('/mp/collect', '/debug/mp/collect') : built.path;
    return { url: `${t.base.replace(/\/$/, '')}${path}&api_secret=${encodeURIComponent(secret)}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(built.body) };
  },
  interpret(status, text, opts): Outcome {
    if (status >= 500 || status === 429 || status === 408) return { ok: false, retry: true, message: `HTTP ${status}` };
    if (status < 200 || status >= 300) return { ok: false, retry: false, message: `HTTP ${status}: ${text.slice(0, 200)}` };
    if (opts.test) {
      try {
        const m = (JSON.parse(text) as { validationMessages?: { fieldPath?: string; description?: string; validationCode?: string }[] }).validationMessages ?? [];
        if (m.length) return { ok: false, retry: false, message: m.map((x) => `${x.fieldPath ?? ''}: ${x.description ?? x.validationCode ?? ''}`).join('; ').slice(0, 400) };
      } catch {
        return { ok: false, retry: false, message: 'The validation endpoint answered something that is not JSON' };
      }
    }
    // The collect endpoint answers 2xx for anything it received, valid or not (documented): success here means "delivered", not "accepted into reports".
    return { ok: true };
  },
};
