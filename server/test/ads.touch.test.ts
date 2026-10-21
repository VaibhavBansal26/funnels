// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cleanText, mergeTouch, sanitizeBrowserIds, sanitizeTouch, type Touch } from '../src/ads/touch.js';

const T0 = new Date('2026-03-01T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('sanitizeTouch', () => {
  it('reads UTM parameters, lower-cases source and medium, keeps campaign case', () => {
    expect(sanitizeTouch({ utm_source: ' Facebook ', utm_medium: 'CPC', utm_campaign: 'Spring_Sale', utm_content: 'ad-7', utm_term: 'shoes' }, T0)).toEqual({
      source: 'facebook', medium: 'cpc', campaign: 'Spring_Sale', content: 'ad-7', term: 'shoes', at: T0.toISOString(),
    });
  });
  it('accepts the short names the existing utm cookies use', () => {
    expect(sanitizeTouch({ source: 'newsletter', campaign: 'c1' }, T0)).toMatchObject({ source: 'newsletter', campaign: 'c1' });
  });
  it('a direct visit carries no information', () => {
    expect(sanitizeTouch({}, T0)).toBeNull();
    expect(sanitizeTouch({ landing: '/promo' }, T0)).toBeNull();
    expect(sanitizeTouch(null, T0)).toBeNull();
    expect(sanitizeTouch('utm_source=x', T0)).toBeNull();
    expect(sanitizeTouch([{ utm_source: 'x' }], T0)).toBeNull();
  });
  it('infers source and medium from a click id when there are no UTMs', () => {
    expect(sanitizeTouch({ clickIds: { gclid: 'Cj0KCQiA1234' } }, T0)).toMatchObject({ source: 'google', medium: 'cpc', inferred: true, clickIds: { gclid: 'Cj0KCQiA1234' } });
    expect(sanitizeTouch({ clickIds: { fbclid: 'IwAR0abcd' } }, T0)).toMatchObject({ source: 'facebook', medium: 'paid_social' });
    expect(sanitizeTouch({ clickIds: { ttclid: 'E.C.P.abcd' } }, T0)).toMatchObject({ source: 'tiktok' });
    expect(sanitizeTouch({ clickIds: { msclkid: 'abcd1234' } }, T0)).toMatchObject({ source: 'bing', medium: 'cpc' });
    expect(sanitizeTouch({ clickIds: { li_fat_id: 'abcd-1234' } }, T0)).toMatchObject({ source: 'linkedin' });
  });
  it('explicit UTMs win over the click id inference', () => {
    const t = sanitizeTouch({ utm_source: 'partner', clickIds: { gclid: 'abcd1234' } }, T0)!;
    expect(t.source).toBe('partner');
    expect(t).not.toHaveProperty('inferred');
  });
  it('an external referrer becomes source/referral; the own host does not count', () => {
    expect(sanitizeTouch({ referrer: 'www.Blog.Example.com' }, T0, 'shop.example.com')).toMatchObject({ source: 'blog.example.com', medium: 'referral', inferred: true });
    expect(sanitizeTouch({ referrer: 'shop.example.com' }, T0, 'shop.example.com')).toBeNull();
    expect(sanitizeTouch({ referrer: 'bad host/../x' }, T0)).toBeNull();
  });
  it('drops malformed click ids', () => {
    expect(sanitizeTouch({ clickIds: { gclid: 'x' } }, T0)).toBeNull();
    expect(sanitizeTouch({ clickIds: { gclid: '<script>alert(1)</script>' } }, T0)).toBeNull();
    expect(sanitizeTouch({ clickIds: { gclid: 'a'.repeat(201) } }, T0)).toBeNull();
    expect(sanitizeTouch({ clickIds: { gclid: 'abcd1234', evil: 'abcd1234' } }, T0)!.clickIds).toEqual({ gclid: 'abcd1234' });
  });
  it('caps lengths and strips control, zero-width and bidi characters', () => {
    const t = sanitizeTouch({ utm_campaign: `x\u0000​‮${'y'.repeat(500)}`, utm_content: 'a\r\nb\tc' }, T0)!;
    expect(t.campaign).toHaveLength(100);
    expect(t.campaign).not.toMatch(/[\u0000​‮]/);
    expect(t.content).toBe('a b c');
  });
  it('keeps hostile text as inert data (no markup is interpreted here; renderers escape)', () => {
    const t = sanitizeTouch({ utm_campaign: '"><img src=x onerror=alert(1)>', utm_source: "x' OR 1=1 --" }, T0)!;
    expect(t.campaign).toBe('"><img src=x onerror=alert(1)>');
    expect(t.source).toBe("x' or 1=1 --");
  });
  it('non-string values are ignored', () => {
    expect(sanitizeTouch({ utm_source: 5, utm_campaign: { a: 1 }, utm_medium: ['x'] }, T0)).toBeNull();
  });
  it('landing keeps the path only', () => {
    expect(sanitizeTouch({ utm_source: 'a', landing: '/promo?x=1#y' }, T0)!.landing).toBe('/promo');
    expect(sanitizeTouch({ utm_source: 'a', landing: 'https://evil.example/x' }, T0)!.landing).toBeUndefined();
  });
  it('normalises unicode', () => {
    expect(cleanText('Café')).toBe('Café');
    expect(cleanText('   ')).toBeUndefined();
  });
});

describe('mergeTouch (first and last touch)', () => {
  const touch = (min: number, source: string, extra: Partial<Touch> = {}): Touch => ({ source, at: at(min).toISOString(), ...extra });
  const empty = { first: null, last: null };

  it('the first touch is kept, the last follows the newest', () => {
    let s = mergeTouch(empty, touch(0, 'google'));
    expect(s.first!.source).toBe('google');
    expect(s.last!.source).toBe('google');
    s = mergeTouch(s, touch(10, 'facebook'));
    expect(s.first!.source).toBe('google');
    expect(s.last!.source).toBe('facebook');
    s = mergeTouch(s, touch(20, 'tiktok'));
    expect(s).toMatchObject({ first: { source: 'google' }, last: { source: 'tiktok' }, changed: true });
  });
  it('a direct visit changes nothing', () => {
    const s = mergeTouch(empty, touch(0, 'google'));
    expect(mergeTouch(s, null)).toMatchObject({ first: s.first, last: s.last, changed: false });
  });
  it('a first visit without information followed by a campaign click: the click is the first touch', () => {
    const s = mergeTouch(mergeTouch(empty, null), touch(5, 'facebook'));
    expect(s.first!.source).toBe('facebook');
  });
  it('an older touch that arrives late can become the first but never the last', () => {
    const s = mergeTouch(empty, touch(30, 'facebook'));
    const late = mergeTouch(s, touch(10, 'google'));
    expect(late.first!.source).toBe('google');
    expect(late.last!.source).toBe('facebook');
  });
  it('the same touch twice is not a change in who is first or last', () => {
    const t = touch(0, 'google');
    const s = mergeTouch(empty, t);
    const again = mergeTouch(s, { ...t });
    expect(again.first!.source).toBe('google');
    expect(again.last!.source).toBe('google');
  });
  it('is stable under any arrival order of the same set of touches', () => {
    const ts = [touch(0, 'a'), touch(5, 'b'), touch(9, 'c'), touch(12, 'd')];
    const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
    for (const p of perms) {
      let s = empty as ReturnType<typeof mergeTouch>;
      for (const i of p) s = mergeTouch(s, ts[i]!);
      expect([s.first!.source, s.last!.source]).toEqual(['a', 'd']);
    }
  });
});

describe('browser identifiers', () => {
  it('accepts the documented shapes and drops everything else', () => {
    expect(sanitizeBrowserIds({ fbp: 'fb.1.1700000000000.1234567890', fbc: 'fb.1.1700000000000.AbCd_Ef-12', ttp: 'abcdefgh_1.2', gaClientId: '1234567890.1700000000', gaSessionId: '1700000001', consent: 'granted' })).toEqual({
      fbp: 'fb.1.1700000000000.1234567890', fbc: 'fb.1.1700000000000.AbCd_Ef-12', ttp: 'abcdefgh_1.2', gaClientId: '1234567890.1700000000', gaSessionId: '1700000001', consent: 'granted',
    });
    expect(sanitizeBrowserIds({ fbp: 'fb.1.x', fbc: '<x>', ttp: 'a', gaClientId: 'GA1.1.123', gaSessionId: 'abc', consent: 'yes' })).toEqual({});
    expect(sanitizeBrowserIds(null)).toEqual({});
    expect(sanitizeBrowserIds('x')).toEqual({});
  });
});
