import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { BEACON_JS } from '../src/beacon.js';
import { COMMERCE_JS } from '../src/commerce.js';
import { buildBundle } from '../src/publish/bundle.js';
import { renderProject } from '../src/pagemodel/render.js';
import { createPageBuilder } from '../src/pagemodel/shared/build.js';
import { makeHarness, type Harness } from './helpers.js';
import { shop } from './support/shopworld.js';

// The cart and Payment form runtime (/commerce.js) in a DOM (jsdom), talking to the real app in process. The TEST card form is exercised end to end.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Requests the runtime has in flight: settling waits for them (a fixed delay was too short on a slow PostgreSQL in CI), then lets the DOM update.
const inflight = new Set<Promise<unknown>>();
const settle = async (ms = 40) => {
  await sleep(ms);
  while (inflight.size) {
    await Promise.allSettled([...inflight]);
    await sleep(10);
  }
};

async function page(h: Harness, path: string, cookie = '') {
  const res = await h.call('GET', path, { headers: cookie ? { cookie } : {} });
  expect(res.status, res.text.slice(0, 200)).toBe(200);
  const dom = new JSDOM(res.text, { url: `https://app.funnels.test${path}`, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window as unknown as Window & typeof globalThis & { eval: (s: string) => unknown };
  if (cookie) for (const c of cookie.split('; ')) w.document.cookie = `${c}; path=/`;
  const calls: { url: string; body: any }[] = [];
  w.fetch = ((url: string, init: RequestInit) => {
    const u = new URL(url, 'https://app.funnels.test');
    calls.push({ url: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    const p = (async () => {
      const r = await h.app.request(u.pathname + u.search, { method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120', 'x-forwarded-for': '198.51.100.9' }, body: init?.body as string });
      const text = await r.text();
      return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) } as Response;
    })();
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  }) as typeof fetch;
  // jsdom has no layout: give elements a size so the runtime's visibility check of the TEST label can run (it still sees display/visibility/opacity).
  (w.Element.prototype as any).getBoundingClientRect = function () { return { width: 320, height: 40, top: 0, left: 0, right: 320, bottom: 40 }; };
  // jsdom cannot navigate: the runtime's navigations are recorded instead.
  let went: string | null = null;
  Object.defineProperty(w, '__go', { set: (v: string) => { went = v; }, configurable: true });
  w.eval(COMMERCE_JS.replace(/location\.href=/g, 'window.__go='));
  await settle();
  return { w, doc: w.document, calls, went: () => went };
}

describe('commerce runtime', () => {
  it('adds to the cart, shows the badge, renders the cart lines, and pays with a TEST card', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000', PUBLIC_CART_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const s = await shop(h, owner.token);
    const go = await h.call('POST', `/api/funnels/${s.funnelId}/go-live`, { token: owner.token, body: { address: { kind: 'builtin' } } });
    const base = new URL(go.json.funnel.address.base).pathname.replace(/\/$/, '');

    // Shop: the page loads the runtime (and only pages with commerce blocks do).
    const shopRes = await h.call('GET', `${base}/`);
    expect(shopRes.text).toContain('/commerce.js" data-fn-commerce');
    expect((await h.call('GET', `${base}/thanks`)).text).not.toContain('commerce.js');
    const one = await page(h, `${base}/`);
    expect(one.calls.map((c) => c.url)).toEqual([`/api/public/cart/${s.funnelId}/view`]);
    const form = one.doc.querySelector('form[data-fn-cart-add]') as HTMLFormElement;
    (form.elements.namedItem('quantity') as HTMLSelectElement).value = '2';
    form.dispatchEvent(new one.w.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(one.doc.querySelector('[data-fn-cart-n]')!.textContent).toBe('2');
    expect(form.querySelector('.fn-status')!.textContent).toBe('Added to your cart.');
    const cookie = one.doc.cookie;
    expect(cookie).toMatch(new RegExp(`fn_cart_${s.funnelId}=crt_`));

    // Cart page: lines, quantity buttons, remove, bump, totals.
    const cart = await page(h, `${base}/cart`, cookie);
    const lines = cart.doc.querySelectorAll('.fn-cart-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toContain('Mug');
    expect(cart.doc.querySelector('.fn-total')!.textContent).toBe('Total$48.00');
    (cart.doc.querySelector('button[aria-label="One more Mug"]') as HTMLButtonElement).click();
    await settle();
    expect(cart.doc.querySelector('.fn-cart-line output')!.textContent).toBe('3');
    const bump = cart.doc.querySelector('.fn-cart .fn-bump input') as HTMLInputElement;
    bump.checked = true;
    bump.dispatchEvent(new cart.w.Event('change'));
    await settle();
    expect(cart.doc.querySelector('.fn-total')!.textContent).toBe('Total$77.00');

    // Pay page: summary from the server, TEST label, local card check, decline, then a successful payment.
    const pay = await page(h, `${base}/pay`, cookie);
    expect(pay.doc.querySelector('[data-fn-pay-summary]')!.textContent).toContain('Mug × 3$72.00');
    expect((pay.doc.querySelector('input[name="bump"]') as HTMLInputElement).checked).toBe(true); // carried over from the cart
    const label = pay.doc.querySelector('[data-fn-test]') as HTMLElement;
    expect(label.textContent).toMatch(/^TEST MODE/);
    expect(label.getAttribute('style')).toContain('display:block!important');
    const f = pay.doc.querySelector('form[data-fn-pay]') as HTMLFormElement;
    const [num, exp, cvc] = [...f.querySelectorAll('input[data-fn-test-card]')] as HTMLInputElement[];
    expect(num!.getAttribute('name')).toBeNull(); // card inputs have no name: they are never part of a form submission
    const submit = () => { f.dispatchEvent(new pay.w.Event('submit', { bubbles: true, cancelable: true })); return settle(80); };
    (f.elements.namedItem('email') as HTMLInputElement).value = 'buyer@example.com';
    num!.value = '4242 4242 4242 4241';
    exp!.value = '12/40';
    cvc!.value = '123';
    await submit();
    expect(f.querySelector('.fn-status')!.textContent).toBe('Enter a valid card number.');
    num!.value = '4000 0000 0000 0002';
    await submit();
    expect(f.querySelector('.fn-status')!.textContent).toBe('Your card was declined. Please try another card.');
    num!.value = '4242 4242 4242 4242';
    await submit();
    const orders = await h.deps.db.all<{ product_name: string; role: string; amount_cents: number }>('SELECT product_name, role, amount_cents FROM orders ORDER BY created_at, id');
    expect(orders.map((o) => [o.product_name, o.role, o.amount_cents])).toEqual([['Mug', 'cart', 7200], ['Gift wrap', 'bump', 500]]);
    // No card number ever reached the server.
    const sent = JSON.stringify(pay.calls);
    expect(sent).not.toMatch(/4242|4000 0000|0002/);
    expect(f.querySelector('.fn-status')!.textContent).toBe('Payment received. Thank you!');
    expect(pay.went()).toBe(`${base}/thanks`); // on to the next step
  });

  it('refuses to take a test payment when the page hides the TEST label', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', PUBLIC_FORMS_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const s = await shop(h, owner.token, { payment: { source: 'product', productName: 'x', price: 1 } });
    const go = await h.call('POST', `/api/funnels/${s.funnelId}/go-live`, { token: owner.token, body: { address: { kind: 'builtin' } } });
    const base = new URL(go.json.funnel.address.base).pathname.replace(/\/$/, '');
    // Link the payment form to a real price so it can quote.
    const page0 = (await h.call('GET', `/api/funnels/${s.funnelId}/steps/${s.payStepId}/page`, { token: owner.token })).json;
    const pm = createPageBuilder('z');
    const project = pm.project([pm.section([pm.stack([pm.heading('Pay', { level: 1 }), pm.payment('payform', { source: 'product', productName: s.tee.name, price: 12, productId: s.tee.productId, priceId: s.tee.priceId })])])]);
    expect((await h.call('PUT', `/api/funnels/${s.funnelId}/steps/${s.payStepId}/page`, { token: owner.token, body: { doc: { version: 2, project }, version: page0.version } })).status).toBe(200);
    const pay = await page(h, `${base}/pay`);
    const label = pay.doc.querySelector('[data-fn-test]') as HTMLElement;
    (label.parentElement as HTMLElement).style.display = 'none'; // what an owner's CSS or script could do
    const f = pay.doc.querySelector('form[data-fn-pay]') as HTMLFormElement;
    (f.elements.namedItem('email') as HTMLInputElement).value = 'buyer@example.com';
    const [num, exp, cvc] = [...f.querySelectorAll('input[data-fn-test-card]')] as HTMLInputElement[];
    num!.value = '4242424242424242'; exp!.value = '12/40'; cvc!.value = '123';
    f.dispatchEvent(new pay.w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(80);
    expect(f.querySelector('.fn-status')!.textContent).toBe('This test payment form must show its TEST label.');
    expect(pay.calls.filter((c) => c.url === '/api/public/pay/complete')).toHaveLength(0);
  });

  it('is served as cacheable javascript and copied into a Pages bundle only when a page loads it', async () => {
    const h = await makeHarness();
    const res = await h.call('GET', '/commerce.js');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.text).toBe(COMMERCE_JS);
    expect(BEACON_JS.length).toBeLessThan(8000); // the beacon stays small: commerce is its own file
    const pm = createPageBuilder('p');
    const html = (blocks: unknown[]) => renderProject(pm.project([pm.section([pm.stack(blocks as never[])])]), { funnelId: 'f', stepId: 's', stepName: 'x', apiBase: 'https://app.example.com', commerceSrc: '/_fn/commerce.x.js' }).html;
    const withCart = html([pm.cartCount()]);
    const plain = html([pm.text('hi')]);
    expect(withCart).toContain('<script async src="/_fn/commerce.x.js" data-fn-commerce');
    expect(plain).not.toContain('commerce');
    const bundle = (h1: string) => buildBundle({ steps: [{ id: 's', basePath: '/', html: h1, knownInline: [], vendors: { script: [], connect: [], img: [], frame: [] } }], assets: new Map(), beaconJs: BEACON_JS, commerceJs: COMMERCE_JS, apiOrigin: 'https://app.example.com', limits: { maxFiles: 100, maxFileBytes: 1_000_000 } });
    expect(bundle(withCart).files.some((f) => /^\/_fn\/commerce\.[0-9a-f]{10}\.js$/.test(f.path))).toBe(true);
    expect(bundle(plain).files.some((f) => f.path.includes('commerce'))).toBe(false);
  });
});
