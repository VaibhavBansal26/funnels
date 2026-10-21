import { describe, expect, it } from 'vitest';
import { corsOriginFor, forgetCorsCache } from '../src/services/cors.js';
import { normalizePlace } from '../src/services/googlereviews.js';
import { renderProject } from '../src/pagemodel/render.js';
import { createPageBuilder } from '../src/pagemodel/shared/build.js';
import { ratingLabel, reviewsInner, starCount } from '../src/pagemodel/shared/markup.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from './helpers.js';

/** Shapes follow the Places API (New) documentation (Place Details and Text Search, field masks as sent). Not exercised against the real Google API. */
const PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const review = (over: Record<string, unknown> = {}) => ({
  name: `places/${PLACE_ID}/reviews/abc`, relativePublishTimeDescription: 'a month ago', rating: 5,
  text: { text: 'Lovely bakery, the sourdough is superb.', languageCode: 'en' }, originalText: { text: 'Lovely bakery, the sourdough is superb.', languageCode: 'en' },
  authorAttribution: { displayName: 'Ann Lee', uri: 'https://www.google.com/maps/contrib/1234567890', photoUri: 'https://lh3.googleusercontent.com/a-/photo=s128-c0x00000000-cc-rp-mo' },
  publishTime: '2026-09-01T10:00:00Z', ...over,
});
const placeBody = (over: Record<string, unknown> = {}) => ({ id: PLACE_ID, displayName: { text: 'Corner Bakery', languageCode: 'en' }, rating: 4.66, userRatingCount: 128, googleMapsUri: 'https://maps.google.com/?cid=123', reviews: [review(), review({ rating: 3, authorAttribution: { displayName: 'Bob' } }), review({ rating: 4, text: { text: 'שירות מצוין ולחם טרי', languageCode: 'he' }, originalText: { text: 'שירות מצוין ולחם טרי', languageCode: 'he' }, authorAttribution: { displayName: 'דנה' } })], ...over });

class FakePlaces {
  calls: { url: string; method: string; headers: Record<string, string>; body?: any }[] = [];
  status = 200;
  place: Record<string, unknown> = placeBody();
  search: unknown = { places: [{ id: PLACE_ID, displayName: { text: 'Corner Bakery' }, formattedAddress: '1 Main St, Austin', rating: 4.7, userRatingCount: 128 }] };
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (this.status !== 200) return new Response('{}', { status: this.status });
    return new Response(JSON.stringify(url.includes(':searchText') ? this.search : this.place), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function setup(env: Record<string, string> = {}, fake = new FakePlaces()) {
  const h = await makeHarness({ env, deps: { outbound: fake.fetch as typeof fetch } });
  const u = await h.register();
  return { h, u, fake };
}
/** The page content without the platform's inline <style> and <script> (which legitimately contain words such as "Google Maps"). */
const bodyOf = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const putKey = (h: Harness, token: string, body: object = {}) => h.call('PUT', '/api/google-reviews/settings', { token, body: { apiKey: 'AIzaSyD-0000000000000000000000000000', defaultPlaceId: PLACE_ID, defaultPlaceName: 'Corner Bakery', ...body } });

async function pageWithReviews(h: Harness, token: string, props: object = {}, extra?: (pm: ReturnType<typeof createPageBuilder>) => any[]) {
  const f = await makeFunnel(h, token);
  const step = f.steps[0];
  const pm = createPageBuilder('r');
  const project = pm.project([pm.section([pm.stack([pm.heading('Hello'), pm.reviews('rv-1', { fallback: [{ name: 'Sam (our own testimonial)', text: 'Great service.' }], ...props }), ...(extra?.(pm) ?? [])])])]);
  const saved = await h.call('PUT', `/api/funnels/${f.id}/steps/${step.id}/page`, { token, body: { doc: { version: 2, project }, version: step.version } });
  expect(saved.status).toBe(200);
  const html = bodyOf((await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', step.id))!.html);
  const row = await h.deps.db.get<{ token: string; workspace_id: string }>('SELECT token, workspace_id FROM review_blocks WHERE step_id = ?', step.id);
  return { f, step, html, token: row?.token };
}

describe('Google reviews settings', () => {
  it('stores the key encrypted, never returns it, shows a masked hint, and clears it', async () => {
    const { h, u } = await setup();
    const put = await putKey(h, u.token);
    expect(put.status).toBe(200);
    expect(put.json.keySource).toBe('workspace');
    expect(put.json.workspaceKeyHint).toBe('…0000');
    expect(JSON.stringify(put.json)).not.toContain('AIzaSy');
    const row = await h.deps.db.get<{ key_enc: string }>('SELECT key_enc FROM google_reviews_settings WHERE workspace_id = ?', u.wsId);
    expect(row!.key_enc).not.toContain('AIzaSy');
    expect(row!.key_enc.startsWith('v1.')).toBe(true);
    const get = await h.call('GET', '/api/google-reviews/settings', { token: u.token });
    expect(JSON.stringify(get.json)).not.toContain('AIzaSy');
    expect(get.json.defaultPlaceId).toBe(PLACE_ID);
    expect((await h.call('PUT', '/api/google-reviews/settings', { token: u.token, body: { apiKey: 'short' } })).status).toBe(400);
    expect((await h.call('PUT', '/api/google-reviews/settings', { token: u.token, body: { clearKey: true } })).json.keySource).toBe('none');
    const audit = await h.deps.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE action LIKE 'google_reviews.%'");
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('AIzaSy');
  });

  it('a platform key is used when the workspace has none; permissions are enforced', async () => {
    const { h, u } = await setup({ GOOGLE_PLACES_API_KEY: 'AIzaSyPLATFORM00000000000000000000' });
    const s = await h.call('GET', '/api/google-reviews/settings', { token: u.token });
    expect(s.json.keySource).toBe('platform');
    expect(s.json.workspaceKeyHint).toBeNull();
    expect(JSON.stringify(s.json)).not.toContain('PLATFORM');
    const member = await h.member(u, 'member');
    expect((await h.call('GET', '/api/google-reviews/settings', { token: member.token })).status).toBe(403);
    expect((await h.call('PUT', '/api/google-reviews/settings', { token: member.token, body: { clearKey: true } })).status).toBe(403);
  });

  it('test fetch reports the place, sends the key and field mask in headers (never in the URL), and reports a rejected key', async () => {
    const { h, u, fake } = await setup();
    await putKey(h, u.token);
    const t = await h.call('POST', '/api/google-reviews/test', { token: u.token, body: {} });
    expect(t.json).toMatchObject({ ok: true, keySource: 'workspace', place: { name: 'Corner Bakery', rating: 4.66, total: 128 }, reviewsReturned: 3 });
    const call = fake.calls[0]!;
    expect(call.url).toBe(`https://places.googleapis.com/v1/places/${PLACE_ID}`);
    expect(call.url).not.toContain('AIza');
    expect(call.headers['X-Goog-Api-Key']).toBe('AIzaSyD-0000000000000000000000000000');
    expect(call.headers['X-Goog-FieldMask']).toBe('id,displayName,rating,userRatingCount,googleMapsUri,reviews');
    fake.status = 403;
    const bad = await h.call('POST', '/api/google-reviews/test', { token: u.token, body: {} });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error.code).toBe('PLACES_KEY_REJECTED');
    const s = await h.call('GET', '/api/google-reviews/settings', { token: u.token });
    expect(s.json.status).toBe('error');
    expect(s.json.lastError).toMatch(/rejected the API key/);
  });
});

describe('place search (builder)', () => {
  it('searches with Text Search and the right mask, returns at most 5 normalised results, and needs a key', async () => {
    const { h, u, fake } = await setup();
    const none = await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'corner bakery austin' } });
    expect(none.status).toBe(409);
    await putKey(h, u.token);
    const r = await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'corner bakery austin' } });
    expect(r.json.data).toEqual([{ placeId: PLACE_ID, name: 'Corner Bakery', address: '1 Main St, Austin', rating: 4.7, total: 128 }]);
    const c = fake.calls.at(-1)!;
    expect(c.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({ textQuery: 'corner bakery austin', pageSize: 5 });
    expect(c.headers['X-Goog-FieldMask']).toBe('places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount');
    fake.search = { places: [{ id: 'bad id with spaces', displayName: { text: '<script>x</script>' } }, { id: PLACE_ID, displayName: { text: '<b>Evil</b>\u202e' }, formattedAddress: 'x' }] };
    const x = await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'zz' } });
    expect(x.json.data).toHaveLength(1);
    expect(x.json.data[0].name).toBe('<b>Evil</b>'); // data, escaped by the UI; control and bidi characters are removed
    expect((await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'a' } })).status).toBe(400);
  });

  it('the per-workspace daily budget limits lookups', async () => {
    const { h, u } = await setup({ GOOGLE_REVIEWS_DAILY_FETCHES: '2' });
    await putKey(h, u.token);
    expect((await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'bakery' } })).status).toBe(200);
    expect((await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'bakery' } })).status).toBe(200);
    const over = await h.call('POST', '/api/google-reviews/search', { token: u.token, body: { query: 'bakery' } });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe('PLACES_QUOTA');
  });
});

describe('reviews block on a page', () => {
  it('without a key the page shows the author\'s own testimonials, labelled, and no Google attribution or structured data', async () => {
    const { h, u } = await setup();
    const { html, token } = await pageWithReviews(h, u.token);
    expect(token).toMatch(/^rv[A-Za-z0-9_-]{24}$/);
    expect(html).toContain('Sam (our own testimonial)');
    expect(html).toContain('Customer feedback');
    expect(html).not.toContain('Google Maps');
    expect(html).not.toMatch(/itemprop|ld\+json|schema\.org|AggregateRating/i);
    expect(html).toContain('data-fn-reviews');
    const pub = await h.call('GET', `/public/reviews/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.json.source).toBe('fallback');
    expect(pub.json.reviews).toEqual([]);
  });

  it('with a key: public endpoint returns Google data with attribution, honours the cache TTL, and refetches after it', async () => {
    const { h, u, fake } = await setup({ GOOGLE_REVIEWS_CACHE_TTL_S: '600' });
    await putKey(h, u.token);
    const { token } = await pageWithReviews(h, u.token);
    const a = await h.call('GET', `/public/reviews/${token}`);
    expect(a.json).toMatchObject({ source: 'google', rating: 4.66, total: 128, mapsUri: 'https://maps.google.com/?cid=123', attribution: 'Google Maps' });
    expect(a.json.reviews).toHaveLength(3);
    expect(a.json.reviews[0].authorUri).toBe('https://www.google.com/maps/contrib/1234567890');
    expect(a.headers.get('cache-control')).toContain('max-age=300');
    expect(fake.calls).toHaveLength(1);
    await h.call('GET', `/public/reviews/${token}`);
    expect(fake.calls).toHaveLength(1); // cached
    h.clock.advance(601_000);
    await h.call('GET', `/public/reviews/${token}`);
    expect(fake.calls).toHaveLength(2); // expired -> live
    const expired = await h.deps.db.get<{ expires_at: string }>('SELECT expires_at FROM google_places_cache WHERE place_id = ?', PLACE_ID);
    expect(new Date(expired!.expires_at).getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it('TTL 0 never stores review content', async () => {
    const { h, u, fake } = await setup({ GOOGLE_REVIEWS_CACHE_TTL_S: '0' });
    await putKey(h, u.token);
    const { token } = await pageWithReviews(h, u.token);
    await h.call('GET', `/public/reviews/${token}`);
    await h.call('GET', `/public/reviews/${token}`);
    expect(fake.calls).toHaveLength(2);
    expect((await h.deps.db.all("SELECT 1 FROM google_places_cache WHERE payload_json IS NOT NULL")).length).toBe(0);
  });

  it('renders cached content into the page with attribution, author links, rounding, RTL text unchanged and the min-rating/count filters', async () => {
    const { h, u } = await setup();
    await putKey(h, u.token);
    const first = await pageWithReviews(h, u.token, { minRating: 4, count: 2 });
    await h.call('GET', `/public/reviews/${first.token}`); // fills the cache
    // saving again primes the snapshot from the cache and renders it into the stored page
    const cur = (await h.call('GET', `/api/funnels/${first.f.id}/steps/${first.step.id}/page`, { token: u.token })).json;
    const second = await h.call('PUT', `/api/funnels/${first.f.id}/steps/${first.step.id}/page`, { token: u.token, body: { doc: cur.doc, version: cur.version } });
    expect(second.status).toBe(200);
    const html = bodyOf((await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', first.step.id))!.html);
    expect(html).toContain('Reviews from <a href="https://maps.google.com/?cid=123"');
    expect(html).toContain('Google Maps');
    expect(html).toContain('href="https://www.google.com/maps/contrib/1234567890"');
    expect(html).toContain('4.7 out of 5 stars');
    expect(html).toContain('(128 Google reviews)');
    expect(html).toContain('Lovely bakery, the sourdough is superb.');
    expect(html).toContain('שירות מצוין ולחם טרי');
    expect(html).toContain('dir="auto"');
    expect(html).toContain('lang="he"');
    expect(html).not.toContain('Bob'); // 3 stars < minimum 4
    expect(html).not.toContain('Sam (our own testimonial)'); // fallback replaced while Google data exists
    expect(html).toContain('googleusercontent.com');
  });

  it('star and rating rounding', () => {
    expect([4.66, 4.5, 4.49, 5, 0, 3.04].map(ratingLabel)).toEqual(['4.7', '4.5', '4.5', '5.0', '0.0', '3.0']);
    expect([4.66, 4.5, 4.49, 5, 0, 1.5].map(starCount)).toEqual([5, 5, 4, 5, 0, 2]);
  });

  it('XSS: hostile author names, text, language codes and links are escaped or dropped', () => {
    const data = normalizePlace(placeBody({
      displayName: { text: '<img src=x onerror=alert(1)>' }, googleMapsUri: 'javascript:alert(1)',
      reviews: [review({ text: { text: '<script>alert(1)</script> "quoted" & <b>bold</b>', languageCode: '"><script>' }, originalText: undefined, authorAttribution: { displayName: '<img src=x onerror=alert(2)>', uri: 'https://evil.example/profile', photoUri: 'https://evil.example/x.png" onerror="alert(3)' } })],
    }), '2026-01-01T00:00:00Z');
    expect(data.mapsUri).toBeNull();
    expect(data.reviews[0]!.authorUri).toBeUndefined();
    expect(data.reviews[0]!.photoUri).toBeUndefined();
    expect(data.reviews[0]!.lang).toBeUndefined();
    const html = reviewsInner('rv-1', { placeId: '', placeName: '', variant: 'list', count: 3, minRating: 1, showText: true, layout: 'grid', fallback: [] }, data, { mode: 'live', funnelId: 'f', stepId: 's', nextHref: '#' });
    expect(html).not.toMatch(/<script|<img src=x|<b>|href="javascript/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const page = renderProject(createPageBuilder('x').project([createPageBuilder('y').section([createPageBuilder('z').reviews('rv-2', { minRating: 1 })])]), { funnelId: 'f', stepId: 's', stepName: 'S' });
    expect(page.html).not.toContain('<script>alert');
  });

  it('badge and carousel variants render; the badge needs data to show', async () => {
    const data = normalizePlace(placeBody(), 'x');
    const ctx = { mode: 'live' as const, funnelId: 'f', stepId: 's', nextHref: '#' };
    const base = { placeId: '', placeName: '', count: 3, minRating: 1, showText: true, layout: 'grid' as const, fallback: [] };
    expect(reviewsInner('a', { ...base, variant: 'badge' }, data, ctx)).toContain('class="fn-rv-badge"');
    expect(reviewsInner('a', { ...base, variant: 'badge' }, null, ctx)).not.toContain('class="fn-rv-badge"');
    expect(reviewsInner('a', { ...base, variant: 'carousel' }, data, ctx)).toContain('fn-rv-carousel');
    expect(reviewsInner('a', { ...base, variant: 'list', showText: false }, data, ctx)).not.toContain('Lovely bakery');
  });
});

describe('failures, circuit breaker and tenant isolation', () => {
  it('upstream errors fall back quietly; repeated failures open a circuit that stops calling Google, then it closes', async () => {
    const { h, u, fake } = await setup({ GOOGLE_REVIEWS_CACHE_TTL_S: '600' });
    await putKey(h, u.token);
    const { token } = await pageWithReviews(h, u.token);
    fake.status = 500;
    for (let i = 0; i < 3; i++) {
      const r = await h.call('GET', `/public/reviews/${token}`);
      expect(r.status).toBe(200);
      expect(r.json.source).toBe('fallback');
    }
    expect(fake.calls).toHaveLength(3);
    await h.call('GET', `/public/reviews/${token}`);
    expect(fake.calls).toHaveLength(3); // circuit open
    fake.status = 200;
    h.clock.advance(6 * 60_000);
    expect((await h.call('GET', `/public/reviews/${token}`)).json.source).toBe('google');
    expect(fake.calls).toHaveLength(4);
  });

  it('malformed Google answers are survived', async () => {
    const { h, u, fake } = await setup();
    await putKey(h, u.token);
    const { token } = await pageWithReviews(h, u.token);
    fake.place = { reviews: 'nope', rating: 'five', userRatingCount: -3 };
    const r = await h.call('GET', `/public/reviews/${token}`);
    expect(r.status).toBe(200);
    expect(r.json.rating).toBeNull();
    expect(r.json.reviews).toEqual([]);
  });

  it('a token only ever serves its own workspace\'s data; unknown or malformed tokens are 404', async () => {
    const fake = new FakePlaces();
    const { h, u } = await setup({}, fake);
    await putKey(h, u.token);
    const a = await pageWithReviews(h, u.token);
    await h.call('GET', `/public/reviews/${a.token}`);
    const other = await h.register();
    const b = await pageWithReviews(h, other.token); // no key, no default place in workspace B
    const pub = await h.call('GET', `/public/reviews/${b.token}`);
    expect(pub.json.source).toBe('fallback');
    expect(fake.calls).toHaveLength(1);
    expect((await h.deps.db.all("SELECT 1 FROM google_places_cache WHERE workspace_id = ?", other.wsId)).length).toBe(0);
    expect((await h.call('GET', '/public/reviews/rvdoesnotexistdoesnotex')).status).toBe(404);
    expect((await h.call('GET', '/public/reviews/x')).status).toBe(404);
    expect((await h.call('GET', '/api/google-reviews/places/' + PLACE_ID, { token: other.token })).status).toBe(409);
    expect(JSON.stringify((await h.call('GET', '/api/google-reviews/settings', { token: other.token })).json)).not.toContain(PLACE_ID);
  });

  it('calls go through the SSRF-guarded fetch: a base URL on a private address is never contacted', async () => {
    const h = await makeHarness({ env: { GOOGLE_PLACES_API_BASE: 'https://127.0.0.1' } });
    const u = await h.register();
    await putKey(h, u.token);
    const t = await h.call('POST', '/api/google-reviews/test', { token: u.token, body: {} });
    expect(t.json.ok).toBe(false);
    expect(t.json.error.code).toBe('PLACES_UPSTREAM');
  });
});

describe('both serving paths', () => {
  it('origin pages fetch from the same origin; Cloudflare Pages bundles carry the snapshot, an absolute endpoint and CORS for the published host only', async () => {
    const { h, u } = await setup({ GOOGLE_REVIEWS_CACHE_TTL_S: '600', APP_PUBLIC_URL: 'https://app.funnels.test' });
    await putKey(h, u.token);
    const { f, step, token } = await pageWithReviews(h, u.token);
    await h.call('GET', `/public/reviews/${token}`);
    const { buildFunnelBundle } = await import('../src/services/publishing.js');
    const funnel = (await h.deps.db.get<any>('SELECT * FROM funnels WHERE id = ?', f.id))!;
    const bundle = await buildFunnelBundle(h.deps, funnel);
    const files = JSON.stringify(bundle.files.map((x) => [x.path, Buffer.from(x.bytes).toString('utf8')])) + bundle.headers;
    expect(files).toContain('Lovely bakery, the sourdough is superb.'); // static snapshot taken at publish time
    expect(files).toContain('Reviews from');
    expect(files).toContain('data-api=\\"https://app.funnels.test\\"');
    expect(files).toContain(`data-token=\\"${token}\\"`);
    expect(files).toMatch(/connect-src[^;]*https:\/\/app\.funnels\.test/);
    // CORS: a registered domain may read the endpoint, a stranger may not
    await activeDomain(h, u.token, 'offers.example.com');
    forgetCorsCache();
    const ok = await h.call('GET', `/public/reviews/${token}`, { headers: { origin: 'https://offers.example.com' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://offers.example.com');
    const bad = await h.call('GET', `/public/reviews/${token}`, { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect(await corsOriginFor(h.deps, 'https://evil.example')).toBeNull();
    void step;
  });
});

describe('ask for a Google review', () => {
  it('links to the write-review form of the place, with an optional CSS-only delay; nothing without a place', async () => {
    const { h, u } = await setup();
    const f = await makeFunnel(h, u.token);
    const step = f.steps[0];
    const save = async (props: object) => {
      const pm = createPageBuilder('c');
      await h.call('PUT', `/api/funnels/${f.id}/steps/${step.id}/page`, { token: u.token, body: { doc: { version: 2, project: pm.project([pm.section([pm.stack([pm.heading('Thanks'), pm.reviewCta('rc-1', props)])])]) } } });
      return bodyOf((await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', step.id))!.html);
    };
    expect(await save({})).not.toContain('writereview');
    const withPlace = await save({ placeId: PLACE_ID, prompt: 'Enjoyed your visit?', delaySeconds: 10 });
    expect(withPlace).toContain(`href="https://search.google.com/local/writereview?placeid=${PLACE_ID}"`);
    expect(withPlace).toContain('rel="noopener noreferrer"');
    expect(withPlace).toContain('fn-rc-d10');
    expect(withPlace).toContain('Enjoyed your visit?');
    await putKey(h, u.token);
    const viaDefault = await save({});
    expect(viaDefault).toContain(`placeid=${PLACE_ID}`);
    expect(viaDefault).not.toContain('fn-rc-wait');
    const bad = await h.call('PUT', `/api/funnels/${f.id}/steps/${step.id}/page`, { token: u.token, body: { doc: { version: 2, project: (() => { const pm = createPageBuilder('d'); return pm.project([pm.section([pm.stack([pm.reviewCta('rc-2', { placeId: 'x"><script>' })])])]); })() } } });
    expect(bad.status).toBe(400);
  });
});

describe('browser runtime (static bundles refresh reviews client-side)', () => {
  it('replaces the snapshot with fresh data using text nodes only, validates links, and keeps the snapshot when the call fails', async () => {
    const { JSDOM } = await import('jsdom');
    const { RUNTIME_JS } = await import('../src/pagemodel/render.js');
    const dom = (fetchImpl: (u: string, i?: RequestInit) => Promise<any>) => {
      const d = new JSDOM('<!doctype html><body><div class="fn-rv" data-fn-reviews data-variant="list" data-layout="grid" data-count="2" data-min="4" data-text="1" data-token="rvAAAAAAAAAAAAAAAAAAAAAAAA" data-api="https://app.example.com"><p>static snapshot</p></div></body>', { runScripts: 'outside-only' });
      (d.window as any).fetch = fetchImpl;
      d.window.eval(RUNTIME_JS);
      return d;
    };
    const payload = { source: 'google', rating: 4.66, total: 10, mapsUri: 'https://maps.google.com/?cid=1', fetchedAt: 'x', attribution: 'Google Maps', reviews: [
      { author: '<img src=x onerror=alert(1)>', authorUri: 'https://evil.example/p', photoUri: 'https://evil.example/a.png', rating: 5, text: '<script>alert(1)</script> שלום', lang: '"><x' },
      { author: 'Low', rating: 2, text: 'filtered' },
      { author: 'Ann', authorUri: 'https://www.google.com/maps/contrib/1', photoUri: 'https://lh3.googleusercontent.com/a', rating: 4, text: 'Nice', lang: 'en', when: 'a week ago' },
    ] };
    const seen: string[] = [];
    const d = dom(async (u) => { seen.push(u); return { ok: true, json: async () => payload }; });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['https://app.example.com/public/reviews/rvAAAAAAAAAAAAAAAAAAAAAAAA']);
    const el = d.window.document.querySelector('[data-fn-reviews]')!;
    expect(el.textContent).not.toContain('static snapshot');
    expect(el.textContent).toContain('4.7');
    expect(el.textContent).toContain('Reviews from Google Maps');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('script, img[onerror]')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script> שלום'); // shown as text, unchanged
    expect(el.textContent).not.toContain('filtered'); // minimum rating
    const links = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://www.google.com/maps/contrib/1', 'https://maps.google.com/?cid=1']);
    expect(links).not.toContain('https://evil.example/p');
    expect(el.querySelectorAll('img')).toHaveLength(1);
    expect([...el.querySelectorAll('blockquote')].every((q) => !(q.getAttribute('lang') ?? '').includes('"'))).toBe(true);
    const failed = dom(async () => { throw new Error('offline'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(failed.window.document.body.textContent).toContain('static snapshot');
    const fb = dom(async () => ({ ok: true, json: async () => ({ source: 'fallback', reviews: [] }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fb.window.document.body.textContent).toContain('static snapshot');
  });
});
