// @vitest-environment node
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ID_FORMATS, isId } from '../src/ads/ids.js';
import { PixelSettings, resolvePixels } from '../src/ads/pixelConfig.js';
import { cspHosts, pageConfig, renderAdTags, safeJson } from '../src/ads/snippets.js';

const ctx = { funnelId: 'fn_1', stepId: 'stp_1', mode: 'live' as const, products: [{ id: 'blk1', name: 'Course', price: 49, currency: 'USD', bump: false, upsell: false }, { id: 'blk2', name: 'Bonus', price: 9.5, currency: 'USD', bump: true, upsell: false }] };

describe('pixel id formats', () => {
  const good: [keyof typeof ID_FORMATS, string][] = [
    ['metaPixel', '123456789012345'], ['ga4', 'G-ABC123XYZ9'], ['googleAds', 'AW-123456789'], ['googleAdsLabel', 'AbC-dEf_123'],
    ['tiktok', 'CABCDEF1234567890ABC'], ['linkedinPartner', '1234567'], ['linkedinConversion', '12345678'], ['uet', '12345678'],
  ];
  const bad: [keyof typeof ID_FORMATS, string][] = [
    ['metaPixel', '1234567'], ['metaPixel', '123456789012345678901'], ['metaPixel', '12345678a'], ['metaPixel', "123456789'+alert(1)+'"], ['metaPixel', '123456789\n'],
    ['ga4', 'g-abc123xyz9'], ['ga4', 'G-ABC'], ['ga4', 'G-ABC123</script>'], ['ga4', 'UA-12345-1'],
    ['googleAds', 'AW-12'], ['googleAds', 'aw-123456789'], ['googleAdsLabel', 'ab'], ['googleAdsLabel', 'abc def ghi'], ['googleAdsLabel', '";alert(1);"'],
    ['tiktok', 'abcdefghijk'], ['tiktok', 'SHORT'], ['tiktok', 'CABCDEF1234567890ABC"><script>'],
    ['linkedinPartner', '12'], ['linkedinPartner', '1234567x'], ['uet', 'abc'], ['uet', '12345 '],
  ];
  it.each(good)('accepts %s %s', (k, v) => expect(isId(k, v)).toBe(true));
  it.each(bad)('rejects %s %j', (k, v) => expect(isId(k, v)).toBe(false));
  it('rejects non-strings', async () => {
    for (const v of [null, undefined, 12345678, {}, ['123456789']]) expect(isId('metaPixel', v)).toBe(false);
  });
  it('the settings schema refuses a bad id with a readable message', async () => {
    const r = PixelSettings.safeParse({ meta: { pixelId: 'abc' } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('Meta Pixel ID');
  });
});

describe('settings resolution', () => {
  it('step overrides funnel overrides workspace, null switches a provider off, consent merges field by field', async () => {
    const ws = PixelSettings.parse({ meta: { pixelId: '111111111111111' }, ga4: { measurementId: 'G-WORKSPACE1' }, consent: { enabled: true, regions: 'eu_uk' } });
    const fn = PixelSettings.parse({ meta: { pixelId: '222222222222222' }, consent: { title: 'Cookies' } });
    const step = PixelSettings.parse({ ga4: null, events: { lead: true } });
    const eff = resolvePixels([ws, fn, step]);
    expect(eff.meta?.pixelId).toBe('222222222222222');
    expect(eff.ga4).toBeNull();
    expect(eff.events.lead).toBe(true);
    expect(eff.consent).toMatchObject({ enabled: true, regions: 'eu_uk', title: 'Cookies', mode: 'opt_in', respectDnt: true });
  });
  it('ignores stored values that no longer pass the format check', async () => {
    const eff = resolvePixels([{ meta: { pixelId: "1');alert(1);//" } } as never]);
    expect(eff.meta).toBeNull();
  });
});

describe('snippet generation', () => {
  it('serialises JSON so that nothing can close the script element', async () => {
    const j = safeJson({ a: '</script><script>alert(1)</script>', b: '  ', c: '<!--', d: '&' });
    expect(j).not.toMatch(/<|>|&/);
    expect(JSON.parse(j)).toEqual({ a: '</script><script>alert(1)</script>', b: '  ', c: '<!--', d: '&' });
  });
  it('a hostile product name or consent text is data in a JSON string, never markup', async () => {
    const eff = resolvePixels([PixelSettings.parse({ meta: { pixelId: '123456789012345' }, consent: { enabled: true, title: '</script><img src=x onerror=alert(1)>' } })]);
    const tags = renderAdTags(eff, { ...ctx, products: [{ ...ctx.products[0]!, name: '"></script><script>alert(1)</script>' }] })!;
    expect(tags.html.match(/<script/g)).toHaveLength(1);
    expect(tags.html.match(/<\/script/g)).toHaveLength(1);
    expect(tags.html.startsWith('<script>') && tags.html.endsWith('</script>')).toBe(true);
    expect(tags.html).not.toContain('<img');
  });
  it('renders nothing without a pixel or a banner, and is deterministic otherwise', async () => {
    expect(renderAdTags(resolvePixels([]), ctx)).toBeNull();
    const eff = resolvePixels([PixelSettings.parse({ tiktok: { pixelId: 'CABCDEF1234567890ABC' } })]);
    const a = renderAdTags(eff, ctx)!;
    expect(a.html).toBe(renderAdTags(eff, ctx)!.html);
    expect(a.cspHash).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(renderAdTags(resolvePixels([PixelSettings.parse({ consent: { enabled: true } })]), ctx)).not.toBeNull();
  });
  it('page config carries only validated ids', async () => {
    const cfg = pageConfig({ ...resolvePixels([]), meta: { pixelId: 'not-a-pixel' }, ga4: { measurementId: 'G-ABC123XYZ9' }, googleAds: { conversionId: 'AW-123456789', purchaseLabel: 'bad label!', leadLabel: 'LeadLabel1' } }, ctx) as { p: Record<string, unknown> };
    expect(cfg.p.meta).toBeUndefined();
    expect(cfg.p.ga4).toEqual({ id: 'G-ABC123XYZ9' });
    expect(cfg.p.ads).toEqual({ id: 'AW-123456789', pl: null, ll: 'LeadLabel1' });
  });
  it('lists the hosts a CSP needs, only for configured networks', async () => {
    expect(cspHosts(resolvePixels([]))).toEqual({ script: [], connect: [], img: [], frame: [] });
    const h = cspHosts(resolvePixels([PixelSettings.parse({ meta: { pixelId: '123456789012345' } })]));
    expect(h.script).toEqual(['https://connect.facebook.net']);
    expect(h.img).toContain('https://www.facebook.com');
  });
});

// ---- the runtime, executed in jsdom ----------------------------------------------------------------------------------------------------------------------

interface Page {
  dom: JSDOM;
  w: any;
  scripts: string[];
}

async function load(settings: Record<string, unknown>, opts: { dnt?: boolean; cookie?: string; tz?: string; mode?: 'live' | 'preview'; html?: string } = {}): Promise<Page> {
  const eff = resolvePixels([PixelSettings.parse(settings)]);
  const tags = renderAdTags(eff, { ...ctx, mode: opts.mode ?? 'live' })!;
  const dom = new JSDOM(`<!doctype html><body>${opts.html ?? ''}</body>`, { url: 'https://shop.example.com/promo', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  if (opts.dnt) Object.defineProperty(w.navigator, 'doNotTrack', { value: '1', configurable: true });
  if (opts.cookie) w.document.cookie = opts.cookie;
  if (opts.tz !== undefined) w.Intl.DateTimeFormat = function () { return { resolvedOptions: () => ({ timeZone: opts.tz }) }; };
  const scripts: string[] = [];
  const append = w.Element.prototype.appendChild;
  w.Element.prototype.appendChild = function (n: any) {
    if (n.tagName === 'SCRIPT' && n.src) scripts.push(n.src);
    else return append.call(this, n);
    return n;
  };
  w.eval(tags.source);
  await new Promise((r) => setTimeout(r, 20)); // the runtime starts at DOMContentLoaded
  return { dom, w, scripts };
}
const META = { meta: { pixelId: '123456789012345' } };
const banner = (p: Page) => p.w.document.querySelector('[data-fn-consent]') as HTMLElement | null;
const click = (p: Page, label: string) => [...p.w.document.querySelectorAll('[data-fn-consent] button')].find((b: any) => b.textContent === label)!.click();

describe('consent gating (runtime)', () => {
  it('without consent settings, loads at once and fires PageView with an event id', async () => {
    const p = await load(META);
    expect(p.scripts).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    const calls = [...p.w.fbq.queue].map((a: any) => [...a]);
    expect(calls[0]).toEqual(['init', '123456789012345']);
    expect(calls[1].slice(0, 3)).toEqual(['track', 'PageView', {}]);
    expect(calls[1][3].eventID).toMatch(/^pv_[0-9a-f]{16}$/);
    expect(banner(p)).toBeNull();
  });
  it('with opt-in consent nothing loads and nothing is sent until Accept, then the queued PageView goes out', async () => {
    const p = await load({ ...META, consent: { enabled: true } });
    expect(p.scripts).toEqual([]);
    expect(p.w.fbq).toBeUndefined();
    expect(banner(p)).not.toBeNull();
    expect(p.w.fnAds.consent()).toBe('unknown');
    click(p, 'Accept');
    expect(banner(p)).toBeNull();
    expect(p.scripts).toEqual(['https://connect.facebook.net/en_US/fbevents.js']);
    expect([...p.w.fbq.queue].map((a: any) => a[1])).toContain('PageView');
    expect(p.w.document.cookie).toContain('fn_consent=granted');
  });
  it('Decline never loads anything and drops later events', async () => {
    const p = await load({ ...META, consent: { enabled: true } });
    click(p, 'Decline');
    p.w.fnAds.track('Lead', {}, 'x');
    expect(p.scripts).toEqual([]);
    expect(p.w.fbq).toBeUndefined();
    expect(p.w.document.cookie).toContain('fn_consent=denied');
  });
  it('remembers the choice: granted loads without a banner, denied stays off', async () => {
    const g = await load({ ...META, consent: { enabled: true } }, { cookie: 'fn_consent=granted' });
    expect(banner(g)).toBeNull();
    expect(g.scripts).toHaveLength(1);
    const dn = await load({ ...META, consent: { enabled: true } }, { cookie: 'fn_consent=denied' });
    expect(dn.scripts).toEqual([]);
    expect(banner(dn)).toBeNull();
  });
  it('Do Not Track blocks everything and shows no banner, even after a stored grant', async () => {
    const p = await load({ ...META, consent: { enabled: true } }, { dnt: true, cookie: 'fn_consent=granted' });
    expect(p.scripts).toEqual([]);
    expect(banner(p)).toBeNull();
    expect(p.w.fnAds.consent()).toBe('denied');
  });
  it('Do Not Track can be ignored on request', async () => {
    const p = await load({ ...META, consent: { enabled: false, respectDnt: false } }, { dnt: true });
    expect(p.scripts).toHaveLength(1);
  });
  it('opt-out mode loads at once and still offers the choice', async () => {
    const p = await load({ ...META, consent: { enabled: true, mode: 'opt_out' } });
    expect(p.scripts).toHaveLength(1);
    expect(banner(p)).not.toBeNull();
    click(p, 'Decline');
    expect(p.w.fnAds.consent()).toBe('denied');
  });
  it('region rule: Europe waits for consent, other time zones do not', async () => {
    const eu = await load({ ...META, consent: { enabled: true, regions: 'eu_uk' } }, { tz: 'Europe/Berlin' });
    expect(eu.scripts).toEqual([]);
    expect(banner(eu)).not.toBeNull();
    const us = await load({ ...META, consent: { enabled: true, regions: 'eu_uk' } }, { tz: 'America/New_York' });
    expect(us.scripts).toHaveLength(1);
    expect(banner(us)).toBeNull();
    const unknown = await load({ ...META, consent: { enabled: true, regions: 'eu_uk' } }, { tz: '' });
    expect(unknown.scripts).toEqual([]);
  });
  it('Google Consent Mode v2: all four signals denied by default and updated to granted on Accept', async () => {
    const p = await load({ ga4: { measurementId: 'G-ABC123XYZ9' }, consent: { enabled: true } });
    const dl = () => [...p.w.dataLayer].map((a: any) => [...a]);
    expect(dl()[0]).toEqual(['consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', wait_for_update: 500 }]);
    expect(p.scripts).toEqual([]);
    click(p, 'Accept');
    const upd = dl().find((a) => a[0] === 'consent' && a[1] === 'update');
    expect(upd![2]).toEqual({ ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
    expect(p.scripts[0]).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9');
  });
  it('the banner text is rendered as text, not markup', async () => {
    const p = await load({ ...META, consent: { enabled: true, title: '<img src=x onerror=alert(1)>', message: '<b>hi</b>' } });
    expect(p.w.document.querySelector('[data-fn-consent] img')).toBeNull();
    expect(p.w.document.querySelector('[data-fn-consent] b')).toBeNull();
    expect(banner(p)!.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('a policy link and a settings link reopen the banner', async () => {
    const p = await load({ ...META, consent: { enabled: true, policyUrl: 'https://shop.example.com/privacy' } }, { cookie: 'fn_consent=granted', html: '<a href="#" data-fn-consent-settings>Cookie settings</a>' });
    expect(banner(p)).toBeNull();
    (p.w.document.querySelector('[data-fn-consent-settings]') as HTMLElement).click();
    expect(banner(p)!.querySelector('a')!.getAttribute('href')).toBe('https://shop.example.com/privacy');
  });
});

describe('event mapping (golden)', () => {
  const all = { ...META, ga4: { measurementId: 'G-ABC123XYZ9' }, googleAds: { conversionId: 'AW-123456789', purchaseLabel: 'PurchaseLbl', leadLabel: 'LeadLabel1' }, tiktok: { pixelId: 'CABCDEF1234567890ABC' }, linkedin: { partnerId: '1234567', purchaseConversionId: '777777', leadConversionId: '888888' }, uet: { tagId: '12345678' }, events: { lead: true } };
  const purchase = { orderId: 'ord_1', eventId: 'purchase_ord_1', orders: [{ productName: 'Course', amountCents: 4900, currency: 'USD' }, { productName: 'Bonus', amountCents: 950, currency: 'USD' }] };

  it('Purchase carries value, currency, contents and the shared event id for every network', async () => {
    const p = await load(all, { mode: 'preview' });
    p.w.document.dispatchEvent(new p.w.CustomEvent('fn:purchase', { detail: purchase }));
    const log = p.w.__fnAdsLog.filter((l: any) => JSON.stringify(l).includes('ord_1') || l.network === 'linkedin' || l.network === 'uet');
    expect(JSON.parse(JSON.stringify(log))).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "Purchase",
            {
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
              "value": 58.5,
            },
            {
              "eventID": "purchase_ord_1",
            },
          ],
          "call": "track",
          "network": "meta",
        },
        {
          "args": [
            "purchase",
            {
              "currency": "USD",
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
              "transaction_id": "ord_1",
              "value": 58.5,
            },
          ],
          "call": "event",
          "network": "ga4",
        },
        {
          "args": [
            "conversion",
            {
              "currency": "USD",
              "send_to": "AW-123456789/PurchaseLbl",
              "transaction_id": "ord_1",
              "value": 58.5,
            },
          ],
          "call": "event",
          "network": "ga4",
        },
        {
          "args": [
            "CompletePayment",
            {
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
              "value": 58.5,
            },
            {
              "event_id": "purchase_ord_1",
            },
          ],
          "call": "track",
          "network": "tiktok",
        },
        {
          "args": [
            {
              "conversion_id": 777777,
            },
          ],
          "call": "track",
          "network": "linkedin",
        },
        {
          "args": [
            "purchase",
            {
              "currency": "USD",
              "revenue_value": 58.5,
            },
          ],
          "call": "event",
          "network": "uet",
        },
      ]
    `);
  });
  it('Lead is opt-in and uses the event id the server will use', async () => {
    const off = await load({ ...all, events: { lead: false } }, { mode: 'preview' });
    off.w.document.dispatchEvent(new off.w.CustomEvent('fn:lead', { detail: { eventId: 'lead_abc12345' } }));
    expect(JSON.stringify(off.w.__fnAdsLog)).not.toContain('lead_abc12345');
    const on = await load(all, { mode: 'preview' });
    on.w.document.dispatchEvent(new on.w.CustomEvent('fn:lead', { detail: { eventId: 'lead_abc12345' } }));
    const log = JSON.parse(JSON.stringify(on.w.__fnAdsLog.filter((l: any) => l.call !== 'page' && !(l.args && l.args[0] === 'PageView' || l.args && l.args[0] === 'page_view'))));
    expect(log.map((l: any) => `${l.network}:${l.args[0]}`)).toEqual(['meta:Lead', 'ga4:generate_lead', 'ga4:conversion', 'tiktok:SubmitForm', 'linkedin:[object Object]', 'uet:lead'].map((x) => x.replace('[object Object]', JSON.stringify({ conversion_id: 888888 }))).map((x) => (x.startsWith('linkedin') ? 'linkedin:[object Object]' : x)));
    expect(log[0].args[2].eventID).toBe('lead_abc12345');
  });
  it('page load sends PageView; a checkout page adds ViewContent, then InitiateCheckout once on first focus and AddPaymentInfo on submit', async () => {
    const html = '<form id="blk1" data-fn-checkout action="/x"><input name="email" id="em"><input type="checkbox" name="bump" value="blk2" form="blk1" checked><button type="submit">Buy</button></form>';
    const p = await load(all, { mode: 'preview', html });
    const names = () => p.w.__fnAdsLog.filter((l: any) => l.network === 'meta').map((l: any) => l.args[0]);
    expect(names()).toEqual(['PageView', 'ViewContent']);
    const em = p.w.document.getElementById('em');
    em.dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true }));
    em.dispatchEvent(new p.w.FocusEvent('focusin', { bubbles: true }));
    expect(names()).toEqual(['PageView', 'ViewContent', 'InitiateCheckout']);
    const ic = p.w.__fnAdsLog.find((l: any) => l.network === 'meta' && l.args[0] === 'InitiateCheckout');
    expect(ic.args[1].value).toBe(58.5);
    expect(ic.args[1].content_ids).toEqual(['blk1', 'blk2']);
    p.w.document.querySelector('form').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    expect(names()).toEqual(['PageView', 'ViewContent', 'InitiateCheckout', 'AddPaymentInfo']);
  });
  it('the same event id is never sent twice', async () => {
    const p = await load(META, { mode: 'preview' });
    p.w.fnAds.track('Lead', {}, 'same');
    p.w.fnAds.track('Lead', {}, 'same');
    expect(p.w.__fnAdsLog.filter((l: any) => l.args[0] === 'Lead')).toHaveLength(1);
  });
  it('a preview never loads a vendor script, whatever the consent', async () => {
    const p = await load({ ...all, consent: { enabled: true } }, { mode: 'preview', cookie: 'fn_consent=granted' });
    expect(p.scripts).toEqual([]);
    expect(p.w.fbq).toBeUndefined();
    expect(p.w.document.querySelector('[data-fn-pixel-debug]')).not.toBeNull();
  });
});
