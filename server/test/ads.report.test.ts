import { describe, expect, it } from 'vitest';
import { platformOf } from '../src/services/adsreport.js';
import { adsWorld } from './support/adsworld.js';

const R = 'from=2026-03-01&to=2026-03-31';
const meta = (campaign: string, content?: string) => ({ source: 'facebook', medium: 'paid_social', campaign, content });

describe('platform names', () => {
  it('folds the usual aliases', () => {
    for (const a of ['facebook', 'FB', 'Instagram', 'meta', 'ig']) expect(platformOf(a)).toBe('meta');
    for (const a of ['google', 'adwords', 'YouTube']) expect(platformOf(a)).toBe('google');
    expect(platformOf('newsletter')).toBe('newsletter');
    expect(platformOf(null)).toBe('');
  });
});

describe('ad performance', () => {
  it('joins spend to attributed results: CPL, CPA, ROAS, profit', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Spring', currency: 'USD', spend: 100, impressions: 10000, clicks: 200 });
    await w.spend({ day: '2026-03-06', source: 'meta', campaign: 'Spring', currency: 'USD', spend: 100, impressions: 10000, clicks: 100 });
    for (let i = 0; i < 4; i++) await w.lead({ at: '2026-03-07T10:00:00Z', last: meta('spring') });
    await w.order({ at: '2026-03-07T11:00:00Z', cents: 20000, last: meta('SPRING') });
    await w.order({ at: '2026-03-08T11:00:00Z', cents: 10000, last: meta('Spring') });
    await w.order({ at: '2026-03-08T11:00:00Z', cents: 900, last: meta('Spring'), bump: true });
    for (let i = 0; i < 20; i++) await w.visitor({ at: '2026-03-07T09:00:00Z', last: meta('Spring') });
    const r = (await w.report(R)).json;
    expect(r.currency).toBe('USD');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ source: 'meta', spend: 200, impressions: 20000, clicks: 300, visits: 20, leads: 4, orders: 2, revenue: 309, cpl: 50, cpa: 100, cpc: 0.67, ctr: 1.5, roas: 1.55, profit: 109 });
    expect(r.totals).toMatchObject({ spend: 200, revenue: 309, roas: 1.55 });
    expect(r.other).toEqual({ visits: 0, leads: 0, orders: 0, revenue: 0 });
    expect(r.unmatched).toEqual([]);
  });

  it('zero spend and zero revenue never divide by zero', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Dud', currency: 'USD', spend: 50 });
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Free', currency: 'USD', spend: 0 });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 8000, last: meta('Free') });
    const rows = (await w.report(R)).json.rows;
    const dud = rows.find((x: any) => x.campaign === 'Dud');
    expect(dud).toMatchObject({ spend: 50, revenue: 0, roas: 0, profit: -50, cpl: null, cpa: null, cpc: null, ctr: null });
    const free = rows.find((x: any) => x.campaign === 'Free');
    expect(free).toMatchObject({ spend: 0, revenue: 80, roas: null, profit: 80, cpa: 0 }); // acquisitions at no cost cost nothing; a ratio over zero spend is undefined
    const empty = await adsWorld();
    const none = (await empty.report(R)).json;
    expect(none.rows).toEqual([]);
    expect(none.totals).toMatchObject({ spend: 0, revenue: 0, roas: null, profit: 0, cpl: null });
  });

  it('never adds currencies: one currency per report, the rest listed', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'C', currency: 'USD', spend: 100 });
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'C', currency: 'EUR', spend: 80 });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 30000, currency: 'USD', last: meta('C') });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 4000, currency: 'EUR', last: meta('C') });
    const usd = (await w.report(R)).json;
    expect(usd.currency).toBe('USD'); // the currency with the most money in the range
    expect(usd.currencies).toEqual(['EUR', 'USD']);
    expect(usd.rows[0]).toMatchObject({ spend: 100, revenue: 300, roas: 3 });
    const eur = (await w.report(`${R}&currency=eur`)).json;
    expect(eur.currency).toBe('EUR');
    expect(eur.rows[0]).toMatchObject({ spend: 80, revenue: 40, roas: 0.5, profit: -40 });
    const jpy = (await w.report(`${R}&currency=JPY`)).json;
    expect(jpy.rows).toEqual([]);
  });

  it('yen are whole units, not hundredths', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'J', currency: 'JPY', spend: 10000 });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 30000, currency: 'JPY', last: meta('J') });
    expect((await w.report(R)).json.rows[0]).toMatchObject({ spend: 10000, revenue: 30000, roas: 3 });
  });

  it('first touch versus last touch', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'google', campaign: 'Search', currency: 'USD', spend: 100 });
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Retarget', currency: 'USD', spend: 20 });
    await w.order({ at: '2026-03-06T10:00:00Z', cents: 10000, first: { source: 'google', medium: 'cpc', campaign: 'Search' }, last: meta('Retarget') });
    const last = (await w.report(R)).json.rows;
    expect(last.find((x: any) => x.campaign === 'Retarget').revenue).toBe(100);
    expect(last.find((x: any) => x.campaign === 'Search').revenue).toBe(0);
    const first = (await w.report(`${R}&model=first`)).json.rows;
    expect(first.find((x: any) => x.campaign === 'Search')).toMatchObject({ revenue: 100, roas: 1 });
    expect(first.find((x: any) => x.campaign === 'Retarget').revenue).toBe(0);
  });

  it('refunds and lost disputes reduce revenue; revenue of campaigns without spend is reported as other', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'C', currency: 'USD', spend: 10 });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 10000, refunded: 2500, last: meta('C') });
    await w.order({ at: '2026-03-05T10:00:00Z', cents: 7000, last: { source: 'newsletter', medium: 'email', campaign: 'weekly' } });
    const r = (await w.report(R)).json;
    expect(r.rows[0].revenue).toBe(75);
    expect(r.other).toMatchObject({ orders: 1, revenue: 70 });
  });

  it('spend whose campaign never appears in the traffic is returned for mapping, and a mapping joins it', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Spring Sale 2026', currency: 'USD', spend: 100 });
    await w.order({ at: '2026-03-06T10:00:00Z', cents: 20000, last: meta('spring_sale_2026') });
    let r = (await w.report(R)).json;
    expect(r.unmatched).toEqual([{ source: 'meta', campaign: 'Spring Sale 2026', spend: 100, hint: 'spring_sale_2026' }]); // same letters, different punctuation
    expect(r.campaigns).toEqual(['spring_sale_2026']);
    expect(r.rows.find((x: any) => x.campaign === 'Spring Sale 2026').revenue).toBe(0);
    expect(r.other.revenue).toBe(200);
    const m = await w.h.call('PUT', '/api/ads/mappings', { token: w.owner.token, body: { source: 'Meta', campaign: 'Spring Sale 2026', utmCampaign: 'spring_sale_2026' } });
    expect(m.status).toBe(200);
    r = (await w.report(R)).json;
    expect(r.unmatched).toEqual([]);
    expect(r.rows[0]).toMatchObject({ campaign: 'Spring Sale 2026', spend: 100, revenue: 200, roas: 2 });
    expect(r.other.revenue).toBe(0);
    const list = (await w.h.call('GET', '/api/ads/mappings', { token: w.owner.token })).json.data;
    expect(list).toHaveLength(1);
    expect((await w.h.call('DELETE', `/api/ads/mappings/${list[0].id}`, { token: w.owner.token })).status).toBe(204);
    expect((await w.report(R)).json.unmatched).toHaveLength(1);
  });

  it('a mapping can point the spend at traffic of another utm_source', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'influencer', campaign: 'Promo', currency: 'USD', spend: 50 });
    await w.order({ at: '2026-03-06T10:00:00Z', cents: 5000, last: { source: 'ytcreator', medium: 'social', campaign: 'promo' } });
    expect((await w.report(R)).json.unmatched).toHaveLength(1);
    await w.h.call('PUT', '/api/ads/mappings', { token: w.owner.token, body: { source: 'influencer', campaign: 'Promo', utmCampaign: 'promo', utmSource: 'YTcreator' } });
    expect((await w.report(R)).json.rows[0]).toMatchObject({ revenue: 50, roas: 1 });
  });

  it('suggests the traffic name when only punctuation differs', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Black Friday', currency: 'USD', spend: 10 });
    await w.visitor({ at: '2026-03-06T10:00:00Z', last: meta('black-friday') });
    // campaign names normalise to the same letters, but the lower-cased names differ, so it is unmatched with a hint
    expect((await w.report(R)).json.unmatched[0].hint).toBe('black-friday');
  });

  it('day boundaries follow the requested time zone, for revenue, and spend days are calendar dates', async () => {
    const w = await adsWorld();
    await w.spend({ day: '2026-03-10', source: 'meta', campaign: 'C', currency: 'USD', spend: 10 });
    await w.spend({ day: '2026-03-11', source: 'meta', campaign: 'C', currency: 'USD', spend: 20 });
    await w.order({ at: '2026-03-10T23:30:00Z', cents: 1000, last: meta('C') }); // 2026-03-11 08:30 in Tokyo, 2026-03-10 19:30 in New York
    const day = (tz: string, from: string, to: string) => w.report(`from=${from}&to=${to}&tz=${encodeURIComponent(tz)}&groupBy=day`);
    const tokyo = (await day('Asia/Tokyo', '2026-03-10', '2026-03-11')).json.rows;
    expect(tokyo.map((r: any) => [r.day, r.spend, r.revenue])).toEqual([['2026-03-10', 10, 0], ['2026-03-11', 20, 10]]);
    const ny = (await day('America/New_York', '2026-03-10', '2026-03-11')).json.rows;
    expect(ny.map((r: any) => [r.day, r.spend, r.revenue])).toEqual([['2026-03-10', 10, 10], ['2026-03-11', 20, 0]]);
    // the range itself is in the zone: Tokyo's 11th starts at 2026-03-10T15:00Z, which contains the order
    expect((await w.report('from=2026-03-11&to=2026-03-11&tz=Asia/Tokyo')).json.totals.revenue).toBe(10);
    expect((await w.report('from=2026-03-11&to=2026-03-11&tz=UTC')).json.totals.revenue).toBe(0);
    expect((await w.report('from=2026-03-01&to=2026-03-31&tz=Nowhere/Land')).status).toBe(400);
  });

  it('groups by source and by funnel', async () => {
    const w = await adsWorld();
    const fid = w.form.funnelId;
    await w.spend({ day: '2026-03-05', source: 'facebook', campaign: 'A', currency: 'USD', spend: 30, funnelId: fid });
    await w.spend({ day: '2026-03-05', source: 'instagram', campaign: 'B', currency: 'USD', spend: 20 });
    await w.spend({ day: '2026-03-05', source: 'google', campaign: 'C', currency: 'USD', spend: 50 });
    await w.order({ at: '2026-03-06T10:00:00Z', cents: 6000, last: { source: 'fb', campaign: 'a' } });
    await w.order({ at: '2026-03-06T10:00:00Z', cents: 4000, last: { source: 'google', campaign: 'c' } });
    const bySource = (await w.report(`${R}&groupBy=source`)).json.rows.map((r: any) => [r.source, r.spend, r.revenue]);
    expect(bySource).toEqual([['meta', 50, 60], ['google', 50, 40]]);
    const byFunnel = (await w.report(`${R}&groupBy=funnel`)).json.rows;
    expect(byFunnel.find((r: any) => r.funnelId === fid)).toMatchObject({ spend: 30, revenue: 100, funnelName: expect.any(String) });
    expect(byFunnel.find((r: any) => r.funnelId === null)).toMatchObject({ spend: 70 });
    expect((await w.report(`${R}&funnelId=fn_missing`)).status).toBe(404);
  });

  it('validates the range', async () => {
    const w = await adsWorld();
    expect((await w.report('from=2026-04-01&to=2026-03-01')).status).toBe(400);
    expect((await w.report('from=2024-01-01&to=2026-03-01')).status).toBe(400);
    expect((await w.report('from=bad')).status).toBe(400);
    expect((await w.report('model=middle')).status).toBe(400);
  });
});

describe('attribution report', () => {
  it('counts visits, leads, orders and revenue per source and medium, with a direct row', async () => {
    const w = await adsWorld();
    for (let i = 0; i < 10; i++) await w.visitor({ at: '2026-03-02T10:00:00Z', last: { source: 'google', medium: 'cpc', campaign: 'brand' } });
    for (let i = 0; i < 5; i++) await w.visitor({ at: '2026-03-02T10:00:00Z', last: { source: 'newsletter', medium: 'email', campaign: 'weekly' } });
    await w.lead({ at: '2026-03-03T10:00:00Z', last: { source: 'google', medium: 'cpc', campaign: 'brand' } });
    await w.lead({ at: '2026-03-03T10:00:00Z' });
    await w.order({ at: '2026-03-04T10:00:00Z', cents: 9900, last: { source: 'Google', medium: 'CPC', campaign: 'Brand' } });
    await w.order({ at: '2026-03-04T10:00:00Z', cents: 500, bump: true, last: { source: 'google', medium: 'cpc', campaign: 'brand' } });
    const r = (await w.attribution(`${R}&dimension=source_medium`)).json;
    expect(r.rows[0]).toMatchObject({ source: 'google', medium: 'cpc', visits: 10, leads: 1, orders: 1, revenue: 104, conversionRate: 10 });
    const email = r.rows.find((x: any) => x.source === 'newsletter');
    expect(email).toMatchObject({ visits: 5, orders: 0, revenue: 0 });
    const direct = r.rows.find((x: any) => x.source === '(direct)');
    expect(direct).toMatchObject({ leads: 1 });
    const camp = (await w.attribution(`${R}&dimension=campaign`)).json.rows.map((x: any) => x.campaign);
    expect(camp.map((c: string) => c.toLowerCase())).toContain('brand');
    expect((await w.attribution(`${R}&dimension=zzz`)).status).toBe(400);
  });

  it('first touch groups by the first touch', async () => {
    const w = await adsWorld();
    await w.order({ at: '2026-03-04T10:00:00Z', cents: 1000, first: { source: 'google', medium: 'cpc' }, last: { source: 'facebook', medium: 'paid_social' } });
    const first = (await w.attribution(`${R}&model=first&dimension=source`)).json.rows;
    expect(first[0]).toMatchObject({ source: 'google', revenue: 10 });
    const last = (await w.attribution(`${R}&model=last&dimension=source`)).json.rows;
    expect(last[0]).toMatchObject({ source: 'facebook', revenue: 10 });
  });

  it('is workspace-scoped and permission-gated', async () => {
    const w = await adsWorld();
    await w.order({ at: '2026-03-04T10:00:00Z', cents: 1000, last: { source: 'google' } });
    const other = await w.h.register();
    expect((await w.attribution(R, other.token)).json.rows).toEqual([]);
    const member = await w.h.member(w.owner, 'member');
    expect((await w.attribution(R, member.token)).status).toBe(200);
    const nobody = await w.h.memberWith(w.owner, ['funnels:read']);
    expect((await w.attribution(R, nobody.token)).status).toBe(403);
    expect((await w.report(R, nobody.token)).status).toBe(403);
    expect((await w.h.call('GET', '/api/ads/attribution/export?' + R, { token: w.owner.token })).text).toContain('Source,Medium,Campaign');
  });
});
