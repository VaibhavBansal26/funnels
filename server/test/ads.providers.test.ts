// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clientIdFor, ga4Provider } from '../src/ads/providers/ga4.js';
import { metaProvider } from '../src/ads/providers/meta.js';
import { tiktokProvider } from '../src/ads/providers/tiktok.js';
import { errorText, type ConversionEvent } from '../src/ads/providers/types.js';

const purchase: ConversionEvent = {
  name: 'Purchase', eventId: 'purchase_ord_42', timeMs: Date.UTC(2026, 2, 10, 12, 0, 0), sourceUrl: 'https://offers.example.com/checkout',
  user: { email: 'Ada.Lovelace@Gmail.com', phone: '+44 20 7946 0958', name: 'Ada King', zip: 'EC1A 1BB', country: 'GB', externalId: 'vis_123', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Test)', fbp: 'fb.1.1700000000000.123456789', fbc: 'fb.1.1700000000000.AbCdEf', ttp: 'ttp_1', ttclid: 'E.C.P.abc', gaClientId: '1234567890.1700000000', gaSessionId: '1700000001' },
  value: 58.5, currency: 'usd', orderId: 'ord_42',
  items: [{ id: 'blk1', name: 'Course', quantity: 1, price: 49 }, { id: 'blk2', name: 'Bonus', quantity: 1, price: 9.5 }],
};
const lead: ConversionEvent = { name: 'Lead', eventId: 'lead_sub12345', timeMs: Date.UTC(2026, 2, 10, 12, 0, 0), user: { email: 'lee@example.com', externalId: 'vis_9' } };
const meta = { pixelId: '123456789012345', base: 'https://graph.facebook.com', version: 'v23.0', testEventCode: 'TEST123' };
const ga = { pixelId: 'G-ABC123XYZ9', base: 'https://www.google-analytics.com' };
const tt = { pixelId: 'CABCDEF1234567890ABC', base: 'https://business-api.tiktok.com', testEventCode: 'TEST9' };

describe('Meta Conversions API', () => {
  it('Purchase (golden)', () => {
    expect(metaProvider.build(purchase, meta, { test: false })).toMatchInlineSnapshot(`
      {
        "body": {
          "data": [
            {
              "action_source": "website",
              "custom_data": {
                "content_ids": [
                  "blk1",
                  "blk2",
                ],
                "content_type": "product",
                "contents": [
                  {
                    "id": "blk1",
                    "item_price": 49,
                    "quantity": 1,
                  },
                  {
                    "id": "blk2",
                    "item_price": 9.5,
                    "quantity": 1,
                  },
                ],
                "currency": "USD",
                "num_items": 2,
                "order_id": "ord_42",
                "value": 58.5,
              },
              "event_id": "purchase_ord_42",
              "event_name": "Purchase",
              "event_source_url": "https://offers.example.com/checkout",
              "event_time": 1773144000,
              "user_data": {
                "client_ip_address": "203.0.113.7",
                "client_user_agent": "Mozilla/5.0 (Test)",
                "country": "0b407281768f0e833afef47ed464b6571d01ca4d53c12ce5c51d1462f4ad6677",
                "em": "894ac26ea616dec861df81a6efb2ddfc30c3f1cb72b219a17242d8244e66c125",
                "external_id": "64b93d52af5e69c8b8719c95487db520eee3e5d5df28b5331fd45542fd7bfad5",
                "fbc": "fb.1.1700000000000.AbCdEf",
                "fbp": "fb.1.1700000000000.123456789",
                "fn": "fdee430d40bd57deeac186cd9790033d0f06f909a8806e7ce6e717ab7c7d5029",
                "ln": "e81dfe69841ad2f7b5790b63e998f0febaf3b29acd732881975130761b98e2c7",
                "ph": "35e206e5dec4c89b9e8b71b8c32724a5bb518483ac5a20c6617d738375b3b823",
                "zp": "636efa87fe7d1f12f2755e36182415f38a6c589471a98aeb88f0f8af7a03a6b2",
              },
            },
          ],
        },
        "path": "/v23.0/123456789012345/events",
      }
    `);
  });
  it('Lead (golden)', () => {
    expect(metaProvider.build(lead, meta, { test: false })).toMatchInlineSnapshot(`
      {
        "body": {
          "data": [
            {
              "action_source": "website",
              "event_id": "lead_sub12345",
              "event_name": "Lead",
              "event_time": 1773144000,
              "user_data": {
                "em": "556740ed46f084c7e3f36626b254bd181c24a6388512feff832302d9d05a8f87",
                "external_id": "564b16c9669a7e3a05f4c0ee1d966b95ad9d13befcd2046f92b878e33d9a051c",
              },
            },
          ],
        },
        "path": "/v23.0/123456789012345/events",
      }
    `);
  });
  it('test_event_code is added only in test mode', () => {
    expect(metaProvider.build(lead, meta, { test: false }).body).not.toHaveProperty('test_event_code');
    expect(metaProvider.build(lead, meta, { test: true }).body.test_event_code).toBe('TEST123');
  });
  it('the token goes in the body, never in the URL or the stored request', () => {
    const built = metaProvider.build(purchase, meta, { test: false });
    expect(JSON.stringify(built)).not.toContain('access_token');
    const call = metaProvider.prepare(built, meta, 'EAAB-secret', { test: false });
    expect(call.url).toBe('https://graph.facebook.com/v23.0/123456789012345/events');
    expect(call.url).not.toContain('secret');
    expect(JSON.parse(call.body).access_token).toBe('EAAB-secret');
  });
  it('response handling', () => {
    expect(metaProvider.interpret(200, '{"events_received":1,"messages":[],"fbtrace_id":"A1"}', { test: false })).toEqual({ ok: true });
    expect(metaProvider.interpret(200, '{"events_received":0}', { test: false })).toMatchObject({ ok: false, retry: false });
    expect(metaProvider.interpret(400, '{"error":{"message":"Invalid OAuth access token","code":190,"fbtrace_id":"T"}}', { test: false })).toMatchObject({ ok: false, retry: false, message: expect.stringContaining('190') });
    expect(metaProvider.interpret(400, '{"error":{"message":"rate","code":4}}', { test: false })).toMatchObject({ retry: true });
    expect(metaProvider.interpret(503, 'down', { test: false })).toMatchObject({ retry: true });
    expect(metaProvider.interpret(429, '', { test: false })).toMatchObject({ retry: true });
    expect(metaProvider.interpret(400, 'not json', { test: false })).toMatchObject({ retry: false });
  });
  it('contains no raw identifier', () => {
    const json = JSON.stringify(metaProvider.build(purchase, meta, { test: false }));
    for (const raw of ['Lovelace', 'gmail', '2079460958', 'EC1A', 'Ada']) expect(json).not.toContain(raw);
  });
});

describe('GA4 Measurement Protocol', () => {
  it('Purchase (golden)', () => {
    expect(ga4Provider.build(purchase, ga, { test: false })).toMatchInlineSnapshot(`
      {
        "body": {
          "client_id": "1234567890.1700000000",
          "events": [
            {
              "name": "purchase",
              "params": {
                "currency": "USD",
                "engagement_time_msec": 1,
                "items": [
                  {
                    "item_id": "blk1",
                    "item_name": "Course",
                    "price": 49,
                    "quantity": 1,
                  },
                  {
                    "item_id": "blk2",
                    "item_name": "Bonus",
                    "price": 9.5,
                    "quantity": 1,
                  },
                ],
                "session_id": "1700000001",
                "transaction_id": "ord_42",
                "value": 58.5,
              },
            },
          ],
          "timestamp_micros": 1773144000000000,
          "user_data": {
            "address": [
              {
                "country": "GB",
                "postal_code": "ec1a1bb",
                "sha256_first_name": "fdee430d40bd57deeac186cd9790033d0f06f909a8806e7ce6e717ab7c7d5029",
                "sha256_last_name": "e81dfe69841ad2f7b5790b63e998f0febaf3b29acd732881975130761b98e2c7",
              },
            ],
            "sha256_email_address": [
              "cd98a25152ad884b29e524ea5d3d8d35615ed0afbbc5ea3a6d4215572b0b2bde",
            ],
            "sha256_phone_number": [
              "f0bf0228144d9fe2bdf1da2d8ca698f17bf1410ee688b075c27062e47b6f0b6d",
            ],
          },
        },
        "path": "/mp/collect?measurement_id=G-ABC123XYZ9",
      }
    `);
  });
  it('Lead (golden)', () => {
    expect(ga4Provider.build(lead, ga, { test: false })).toMatchInlineSnapshot(`
      {
        "body": {
          "client_id": "2248120797.3507480167",
          "events": [
            {
              "name": "generate_lead",
              "params": {
                "engagement_time_msec": 1,
              },
            },
          ],
          "timestamp_micros": 1773144000000000,
          "user_data": {
            "sha256_email_address": [
              "556740ed46f084c7e3f36626b254bd181c24a6388512feff832302d9d05a8f87",
            ],
          },
        },
        "path": "/mp/collect?measurement_id=G-ABC123XYZ9",
      }
    `);
  });
  it('production and validation URLs; the secret is only added at send time', () => {
    const built = ga4Provider.build(lead, ga, { test: false });
    expect(JSON.stringify(built)).not.toContain('api_secret');
    expect(ga4Provider.prepare(built, ga, 's3cr&t', { test: false }).url).toBe('https://www.google-analytics.com/mp/collect?measurement_id=G-ABC123XYZ9&api_secret=s3cr%26t');
    expect(ga4Provider.prepare(built, ga, 'k', { test: true }).url).toBe('https://www.google-analytics.com/debug/mp/collect?measurement_id=G-ABC123XYZ9&api_secret=k');
  });
  it('client id: the browser one when valid, otherwise stable and derived from the visitor', () => {
    expect(clientIdFor(purchase)).toBe('1234567890.1700000000');
    const a = clientIdFor({ ...lead });
    expect(a).toMatch(/^\d+\.\d+$/);
    expect(clientIdFor({ ...lead })).toBe(a);
    expect(clientIdFor({ ...lead, user: { externalId: 'vis_other' } })).not.toBe(a);
    expect(clientIdFor({ ...purchase, user: { ...purchase.user, gaClientId: '<script>' } })).toMatch(/^\d+\.\d+$/);
  });
  it('timestamps are never in the future', () => {
    const b = ga4Provider.build({ ...lead, timeMs: Date.now() + 3_600_000 }, ga, { test: false });
    expect(Number(b.body.timestamp_micros)).toBeLessThanOrEqual(Date.now() * 1000);
  });
  it('response handling: 2xx is delivered; validation messages fail a test; 5xx retries', () => {
    expect(ga4Provider.interpret(204, '', { test: false })).toEqual({ ok: true });
    expect(ga4Provider.interpret(200, '{"validationMessages":[]}', { test: true })).toEqual({ ok: true });
    expect(ga4Provider.interpret(200, '{"validationMessages":[{"fieldPath":"events[0].name","description":"bad","validationCode":"NAME_INVALID"}]}', { test: true })).toMatchObject({ ok: false, retry: false, message: expect.stringContaining('events[0].name') });
    expect(ga4Provider.interpret(500, '', { test: false })).toMatchObject({ retry: true });
    expect(ga4Provider.interpret(403, 'x', { test: false })).toMatchObject({ retry: false });
  });
});

describe('TikTok Events API', () => {
  it('Purchase (golden)', () => {
    expect(tiktokProvider.build(purchase, tt, { test: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "data": [
            {
              "event": "CompletePayment",
              "event_id": "purchase_ord_42",
              "event_time": 1773144000,
              "page": {
                "url": "https://offers.example.com/checkout",
              },
              "properties": {
                "content_type": "product",
                "contents": [
                  {
                    "content_id": "blk1",
                    "content_name": "Course",
                    "price": 49,
                    "quantity": 1,
                  },
                  {
                    "content_id": "blk2",
                    "content_name": "Bonus",
                    "price": 9.5,
                    "quantity": 1,
                  },
                ],
                "currency": "USD",
                "order_id": "ord_42",
                "value": 58.5,
              },
              "user": {
                "email": "894ac26ea616dec861df81a6efb2ddfc30c3f1cb72b219a17242d8244e66c125",
                "external_id": "64b93d52af5e69c8b8719c95487db520eee3e5d5df28b5331fd45542fd7bfad5",
                "ip": "203.0.113.7",
                "phone": "f0bf0228144d9fe2bdf1da2d8ca698f17bf1410ee688b075c27062e47b6f0b6d",
                "ttclid": "E.C.P.abc",
                "ttp": "ttp_1",
                "user_agent": "Mozilla/5.0 (Test)",
              },
            },
          ],
          "event_source": "web",
          "event_source_id": "CABCDEF1234567890ABC",
          "test_event_code": "TEST9",
        },
        "path": "/open_api/v1.3/event/track/",
      }
    `);
  });
  it('Lead (golden)', () => {
    expect(tiktokProvider.build(lead, tt, { test: false })).toMatchInlineSnapshot(`
      {
        "body": {
          "data": [
            {
              "event": "SubmitForm",
              "event_id": "lead_sub12345",
              "event_time": 1773144000,
              "user": {
                "email": "556740ed46f084c7e3f36626b254bd181c24a6388512feff832302d9d05a8f87",
                "external_id": "564b16c9669a7e3a05f4c0ee1d966b95ad9d13befcd2046f92b878e33d9a051c",
              },
            },
          ],
          "event_source": "web",
          "event_source_id": "CABCDEF1234567890ABC",
        },
        "path": "/open_api/v1.3/event/track/",
      }
    `);
  });
  it('the token is a header, not in the stored request', () => {
    const built = tiktokProvider.build(lead, tt, { test: false });
    expect(JSON.stringify(built)).not.toMatch(/token/i);
    const call = tiktokProvider.prepare(built, tt, 'tok', { test: false });
    expect(call.headers['access-token']).toBe('tok');
    expect(call.url).toBe('https://business-api.tiktok.com/open_api/v1.3/event/track/');
  });
  it('response handling follows the code in the body, not just the HTTP status', () => {
    expect(tiktokProvider.interpret(200, '{"code":0,"message":"OK"}', { test: false })).toEqual({ ok: true });
    expect(tiktokProvider.interpret(200, '{"code":40001,"message":"Invalid pixel"}', { test: false })).toMatchObject({ ok: false, retry: false, message: expect.stringContaining('40001') });
    expect(tiktokProvider.interpret(200, '{"code":50002,"message":"busy"}', { test: false })).toMatchObject({ retry: true });
    expect(tiktokProvider.interpret(502, '', { test: false })).toMatchObject({ retry: true });
    expect(tiktokProvider.interpret(200, 'html', { test: false })).toMatchObject({ ok: false });
  });
});

describe('error text', () => {
  it('redacts the secret wherever it appears', () => {
    expect(errorText('bad token EAAB-secret and access_token=EAAB-secret&x=1', 'EAAB-secret')).not.toContain('EAAB-secret');
    expect(errorText('{"api_secret":"abc123"}', '')).toBe('{"api_secret":"[redacted]"}');
    expect(errorText('Access-Token: abc', '')).toContain('[redacted]');
    expect(errorText('x'.repeat(2000), '')).toHaveLength(500);
  });
});
