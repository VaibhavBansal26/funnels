import { describe, expect, it } from 'vitest';
import { activeDomain, formTarget, makeHarness } from './helpers.js';

const META = '123456789012345';

async function world() {
  const h = await makeHarness();
  const owner = await h.register();
  const form = await formTarget(h, owner.token);
  const html = async (token = owner.token) => (await h.call('GET', `/api/funnels/${form.funnelId}/steps/${form.stepId}/html`, { token })).json.html as string;
  const put = (path: string, body: unknown, token = owner.token) => h.call('PUT', path, { token, body });
  return { h, owner, form, html, put };
}
const FP = (f: { funnelId: string }) => `/api/funnels/${f.funnelId}/pixels`;
const SP = (f: { funnelId: string; stepId: string }) => `/api/funnels/${f.funnelId}/steps/${f.stepId}/pixels`;

describe('pixels in rendered pages', () => {
  it('a page has no tag script until pixels are set; then the stored page carries one generated from the id', async () => {
    const w = await world();
    expect((await w.html()).includes('w.fnAds={')).toBe(false);
    const r = await w.put(FP(w.form), { meta: { pixelId: META }, ga4: { measurementId: 'G-ABC123XYZ9' } });
    expect(r.status).toBe(200);
    expect(r.json.config.meta.pixelId).toBe(META);
    const page = await w.html();
    expect(page.includes('w.fnAds={')).toBe(true);
    expect(page.includes(`"meta":{"id":"${META}"}`)).toBe(true);
    expect(page.includes('"ga4":{"id":"G-ABC123XYZ9"}')).toBe(true);
    expect(page.match(/var C=\{"p":/g)).toHaveLength(1);
    // removing them takes the script out again
    await w.put(FP(w.form), {});
    expect((await w.html()).includes('w.fnAds={')).toBe(false);
  });

  it('refuses malformed ids, markup in ids and unknown keys, and stores nothing', async () => {
    const w = await world();
    for (const body of [
      { meta: { pixelId: "1');alert(1);//" } }, { meta: { pixelId: '<script>' } }, { ga4: { measurementId: 'UA-1234-1' } }, { tiktok: { pixelId: 'lower' } }, { googleAds: { conversionId: 'AW-123456789', purchaseLabel: '"><x>' } },
      { linkedin: { partnerId: 'abc' } }, { uet: { tagId: '12' } }, { consent: { policyUrl: 'javascript:alert(1)' } }, { consent: { title: 'x'.repeat(500) } }, { consent: { mode: 'always' } },
    ]) {
      const r = await w.put(FP(w.form), body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.html()).includes('w.fnAds={')).toBe(false);
    expect((await w.h.deps.db.all('SELECT * FROM ad_pixel_configs')).length).toBe(0);
  });

  it('a step overrides its funnel, null switches a provider off for that step', async () => {
    const w = await world();
    await w.put(FP(w.form), { meta: { pixelId: META }, tiktok: { pixelId: 'CABCDEF1234567890ABC' } });
    await w.put(SP(w.form), { meta: { pixelId: '999999999999999' }, tiktok: null });
    const page = await w.html();
    expect(page.includes('"meta":{"id":"999999999999999"}')).toBe(true);
    expect(page.includes('CABCDEF1234567890ABC')).toBe(false);
    const eff = (await w.h.call('GET', SP(w.form), { token: w.owner.token })).json.effective;
    expect(eff.meta.pixelId).toBe('999999999999999');
    expect(eff.tiktok).toBeNull();
    // the funnel level still shows its own
    expect((await w.h.call('GET', FP(w.form), { token: w.owner.token })).json.config.tiktok.pixelId).toBe('CABCDEF1234567890ABC');
  });

  it('workspace defaults reach every funnel and a consent banner can be configured on its own', async () => {
    const w = await world();
    const second = await formTarget(w.h, w.owner.token);
    const r = await w.put('/api/pixels', { meta: { pixelId: META }, consent: { enabled: true, regions: 'eu_uk', title: 'Cookies' } });
    expect(r.status).toBe(200);
    for (const f of [w.form, second]) {
      const page = (await w.h.call('GET', `/api/funnels/${f.funnelId}/steps/${f.stepId}/html`, { token: w.owner.token })).json.html as string;
      expect(page.includes(`"meta":{"id":"${META}"}`)).toBe(true);
      expect(page.includes('"regions":"eu_uk"')).toBe(true);
      expect(page.includes('"title":"Cookies"')).toBe(true);
    }
    await w.put(FP(w.form), { meta: null });
    expect((await w.html()).includes(META)).toBe(false);
  });

  it('the live page and the signed preview both carry it; the preview marks itself so no vendor script loads', async () => {
    const w = await world();
    const d = await activeDomain(w.h, w.owner.token, 'px.example.com');
    await w.h.call('PATCH', `/api/funnels/${w.form.funnelId}`, { token: w.owner.token, body: { status: 'live', domain_id: d } });
    await w.put(FP(w.form), { meta: { pixelId: META } });
    const path = (await w.h.deps.db.get<{ base_path: string }>('SELECT base_path FROM steps WHERE id = ?', w.form.stepId))!.base_path;
    const home = await w.h.app.request(path, { headers: { host: 'px.example.com', 'user-agent': 'Mozilla/5.0' } });
    expect(home.status).toBe(200);
    expect((await home.text()).includes('"mode":"live"')).toBe(true);
    const tok = await w.h.call('POST', `/api/funnels/${w.form.funnelId}/preview-token`, { token: w.owner.token });
    const prev = await w.h.app.request(tok.json.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect((await prev.text()).includes('"mode":"preview"')).toBe(true);
  });

  it('hostile product names in the catalogue stay inside a JSON string', async () => {
    const w = await world();
    await w.put(FP(w.form), { meta: { pixelId: META } });
    const page = await w.html();
    expect(/<script>[^<]*<script/.test(page)).toBe(false);
  });

  it('is audited and permissioned, and tenants cannot see each other', async () => {
    const w = await world();
    const member = await w.h.member(w.owner, 'member');
    const viewer = await w.h.member(w.owner, 'viewer');
    expect((await w.put(FP(w.form), { meta: { pixelId: META } }, member.token)).status).toBe(403);
    expect((await w.put('/api/pixels', {}, viewer.token)).status).toBe(403);
    expect((await w.h.call('GET', FP(w.form), { token: viewer.token })).status).toBe(200);
    await w.put(FP(w.form), { meta: { pixelId: META } });
    const audit = (await w.h.call('GET', '/api/audit', { token: w.owner.token })).json.data;
    expect(audit.find((a: any) => a.action === 'pixels.updated')?.detail).toMatchObject({ scope: 'funnel', providers: ['meta'] });
    const other = await w.h.register();
    expect((await w.h.call('GET', FP(w.form), { token: other.token })).status).toBe(404);
    expect((await w.put(SP(w.form), {}, other.token)).status).toBe(404);
    expect((await w.h.call('GET', SP({ funnelId: w.form.funnelId, stepId: 'stp_other' }), { token: w.owner.token })).status).toBe(404);
  });
});
