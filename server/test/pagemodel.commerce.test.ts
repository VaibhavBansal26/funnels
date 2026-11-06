import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { normalizeDoc, remapStepRefs } from '../src/pagemodel/doc.js';
import { renderProject } from '../src/pagemodel/render.js';
import { createPageBuilder } from '../src/pagemodel/shared/build.js';
import { cleanProject } from '../src/pagemodel/shared/clean.js';
import { cartAddInner, cartInner, paymentInner, type MarkupCtx } from '../src/pagemodel/shared/markup.js';
import { CartAddPropsSchema, PaymentPropsSchema } from '../src/pagemodel/shared/props.js';

// Add to cart, Cart, Cart count and Payment form components in the page model: cleaning, derived list, rendering, escaping, step references.
const ctx = { funnelId: 'fn_1', stepId: 'st_1', stepName: 'Shop', apiBase: 'https://app.example.com', steps: [{ id: 'st_1', href: '/shop' }, { id: 'st_2', href: '/cart' }, { id: 'st_3', href: '/pay' }] };

describe('commerce components', () => {
  it('are cleaned against their schemas and derived into the commerce list (props from the request are never trusted)', () => {
    const pm = createPageBuilder('c');
    const project = pm.project([pm.section([pm.stack([
      pm.cartAdd('atc1', { productName: 'Mug', price: 24, then: { type: 'step', stepId: 'st_2' } }),
      pm.cart('cart1', { checkoutStepId: 'st_3' }),
      pm.cartCount({ cartStepId: 'st_2' }),
      pm.payment('pay1', { mode: 'hosted' }),
    ])])]);
    const r = cleanProject(project);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commerce.map((b) => [b.type, b.id])).toEqual([['cart-add', 'atc1'], ['cart', 'cart1'], ['payment', 'pay1']]);
    expect(r.commerce[2]).toMatchObject({ source: 'cart', mode: 'hosted', buttonLabel: 'Pay now', collectName: true, collectAddress: false });
    const bad = cleanProject(pm.project([pm.section([pm.stack([{ type: 'fn-payment', tagName: 'div', fnPayment: { mode: 'iframe' } }, { type: 'fn-cart-add', tagName: 'div', fnCartAdd: { productName: '', price: -1 } }])])]));
    expect(bad.ok).toBe(false);
    expect(CartAddPropsSchema.safeParse({ productName: 'x', price: 1, then: { type: 'url', url: 'javascript:alert(1)' } }).success).toBe(false);
    expect(PaymentPropsSchema.parse({}).source).toBe('cart');
  });

  it('documents without commerce components stay byte-identical (no empty list is added)', () => {
    const pm = createPageBuilder('d');
    const r = normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.heading('Hi', { level: 1 })])])]) });
    expect(r.ok && 'commerce' in r.doc).toBe(false);
  });

  it('escape every author string and keep forms pointed at the public API', () => {
    const pm = createPageBuilder('x');
    const evil = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
    const { html, body } = renderProject(pm.project([pm.section([pm.stack([
      pm.cartAdd('atc1', { productName: evil, price: 5, label: evil }),
      pm.cart('cart1', { title: evil, emptyText: evil, checkoutLabel: evil }),
      pm.cartCount({ label: '"><b onclick=x>' }),
      pm.payment('pay1', { title: evil, buttonLabel: evil, collectAddress: true }),
    ])])]), ctx);
    expect(body).not.toMatch(/<script|<img|<b /i);
    expect(body).toContain('&lt;script&gt;');
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('form[data-fn-cart-add]')!.getAttribute('action')).toBe('https://app.example.com/api/public/cart/fn_1/st_1/atc1/add');
    expect(doc.querySelector('form[data-fn-pay]')!.getAttribute('action')).toBe('https://app.example.com/api/public/pay/fn_1/st_1/pay1');
    expect(doc.querySelector('form[data-fn-pay]')!.getAttribute('data-mode')).toBe('embedded');
    expect(doc.querySelectorAll('form[data-fn-pay] input[name=line1], form[data-fn-pay] input[name=postalCode], form[data-fn-pay] input[name=country]')).toHaveLength(3);
    expect(doc.querySelector('[data-fn-cart-count]')).toBeTruthy();
    expect(doc.querySelector('script[data-fn-commerce]')!.getAttribute('src')).toBe('https://app.example.com/commerce.js');
    // Card fields are never part of the markup: the runtime mounts Stripe's iframe or the TEST form.
    expect(doc.querySelector('form[data-fn-pay] input[autocomplete^="cc-"]')).toBeNull();
  });

  it('link to steps by id, and order bumps attach to the Payment form when the page has no checkout', () => {
    const pm = createPageBuilder('y');
    const { html } = renderProject(pm.project([pm.section([pm.stack([
      pm.cartAdd('atc1', { productName: 'Mug', price: 24, then: { type: 'step', stepId: 'st_2' } }),
      pm.cart('cart1', { checkoutStepId: 'st_3' }),
      pm.checkout('bump1', { productName: 'Wrap', price: 5, orderBump: true }),
      pm.payment('pay1'),
    ])])]), ctx);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('form[data-fn-cart-add]')!.getAttribute('data-href')).toBe('/cart');
    expect(doc.querySelector('[data-fn-cart-checkout]')!.getAttribute('href')).toBe('/pay');
    expect(doc.querySelector('input[name=bump]')!.getAttribute('form')).toBe('co-pay1');
    expect(doc.querySelector('form#co-pay1[data-fn-pay]')).toBeTruthy();
  });

  it('renders inert sample content on the builder canvas', () => {
    const b: MarkupCtx = { mode: 'builder', funnelId: 'f', stepId: 's', nextHref: '#' };
    expect(cartInner('c', { title: 'Your cart', emptyText: 'Empty', checkoutLabel: 'Checkout', showBumps: true }, b)).toContain('Sample lines (editor only)');
    expect(paymentInner('p', PaymentPropsSchema.parse({}), b)).toContain('Card fields appear here on the published page');
    expect(cartAddInner('a', CartAddPropsSchema.parse({ productName: 'Mug', price: 24 }), b)).toContain('$24.00');
  });

  it('copying a funnel rewrites the step references of commerce components', () => {
    const pm = createPageBuilder('z');
    const r = normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.cartAdd('a', { productName: 'Mug', price: 1, then: { type: 'step', stepId: 'old2' } }), pm.cart('c', { checkoutStepId: 'old3' }), pm.cartCount({ cartStepId: 'gone' })])])]) });
    if (!r.ok) throw new Error('invalid');
    const copy = remapStepRefs(r.doc, new Map([['old2', 'new2'], ['old3', 'new3']]));
    const json = JSON.stringify(copy.project);
    expect(json).toContain('"stepId":"new2"');
    expect(json).toContain('"checkoutStepId":"new3"');
    expect(json).not.toContain('gone');
  });
});
