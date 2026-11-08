import { createPageBuilder, faqSection, feature, finish, footer, thanksSection, type GjsNode, type PageBuilder } from '../kit.js';
import type { TemplateDef, TemplateProduct } from '../types.js';

/** Templates that use the cart and the on-page Payment form (docs/USER-GUIDE.md#cart-and-payment-form). */

const slot = (key: string, role: TemplateProduct['role'], name: string, description: string, amount: number): TemplateProduct => ({ key, role, name, description, type: 'one_time', amount, currency: 'USD' });

const art = (pm: PageBuilder, a: string, b: string, label: string): GjsNode =>
  pm.box([pm.text(label, { align: 'center', color: '#1f2937' })], { name: 'Product art', style: { height: '180px', 'border-radius': '18px', background: `linear-gradient(135deg,${a},${b})`, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '700' } });

// ---- Store with cart --------------------------------------------------------------------------------------------------------------------------------

function storeWithCart(): TemplateDef {
  const accent = '#0f766e';
  const pm = createPageBuilder('sh');
  const shop = finish(pm, [
    pm.section([pm.row([
      pm.col([pm.text('**Field & Kettle**')], { grow: 1 }),
      pm.col([pm.cartCount({ label: 'Cart' }, { style: { 'text-align': 'right' } })], { grow: 0 }),
    ], { valign: 'center', keep: true })], { padding: 'sm', width: 'wide' }),
    pm.section([pm.stack([
      pm.eyebrow('Small-batch tea, packed to order', { align: 'center' }),
      pm.heading('Build your tea box', { level: 1, align: 'center' }),
      pm.text('Pick your favourites, choose how many, and check out on one page. Free shipping over $40.', { align: 'center', muted: true, size: '1.1rem' }),
    ])], { theme: 'soft', padding: 'lg', width: 'medium', align: 'center' }),
    pm.section([
      // The Product catalog lists the three teas (bound to catalog products when the template is used); prices, names and images come from Products.
      pm.stack([pm.catalog('sh-catalog', { source: 'picked', picks: [{ slot: 'green' }, { slot: 'black' }, { slot: 'herbal' }], columns: 3, quantity: { enabled: true, min: 1, max: 10, default: 1 }, buttonLabel: 'Add to cart', emptyText: 'Our teas are being restocked. Check back soon.' })]),
      pm.stack([pm.button('View your cart', { type: 'next_step' }, { size: 'lg', align: 'center' })]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([pm.cols([[feature(pm, '1', 'Packed to order', 'Every tin is filled the day you order it.')], [feature(pm, '2', 'Plastic free', 'Paper pouches inside recyclable tins.')], [feature(pm, '3', 'Easy returns', 'Not your cup? We refund within 30 days.')]])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm, 'Field & Kettle'),
  ], { accent });

  const pm2 = createPageBuilder('sc');
  const cart = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.heading('Your cart', { level: 1, align: 'center' }),
      pm2.text('Change quantities or remove items, then continue to payment.', { align: 'center', muted: true }),
      pm2.cart('sc-cart', { title: '', checkoutLabel: 'Continue to payment' }),
    ])], { padding: 'lg', width: 'small' }),
    footer(pm2, 'Field & Kettle'),
  ], { accent });

  const pm3 = createPageBuilder('sp');
  const pay = finish(pm3, [
    pm3.section([pm3.stack([
      pm3.heading('Checkout', { level: 1, align: 'center' }),
      pm3.checkout('sp-bump', { slot: 'bump', productName: 'Bamboo tea infuser', price: 6, orderBump: true, description: 'A reusable infuser for loose leaf, shipped with your box.' }),
      pm3.payment('sp-pay', { source: 'cart', mode: 'embedded', title: 'Your order', buttonLabel: 'Pay now' }),
    ])], { padding: 'lg', width: 'small' }),
    footer(pm3, 'Field & Kettle'),
  ], { accent });

  const pm4 = createPageBuilder('st');
  const thanks = finish(pm4, [
    thanksSection(pm4, { eyebrow: 'Order confirmed', title: 'Thank you, your tea box is on its way', text: 'A receipt is in your inbox. We pack orders the same day and ship within two business days.', bullets: ['Check your email for the receipt', 'Tracking follows when it ships', 'Steep at 80°C for green, 95°C for black'] }),
    footer(pm4, 'Field & Kettle'),
  ], { accent });

  return {
    slug: 'store-with-cart', version: 2, name: 'Store with cart', description: 'A small shop: a Product catalog grid of your products with Add to cart buttons and a cart badge, a cart page with quantities, a checkout page with the card form on the page and an order bump, and an order confirmation.',
    category: 'ecommerce', industry: 'ecommerce', goal: 'sales', tags: ['ecommerce', 'cart', 'store', 'product catalog', 'payment form', 'order bump', 'multi-product'], basePath: '/shop', accent,
    products: [
      slot('green', 'main', 'Morning green tea', 'Bright sencha with a sweet, grassy finish. 50 g loose leaf.', 14),
      slot('black', 'main', 'Smoky black tea', 'Pine-smoked Lapsang for cold evenings. 50 g loose leaf.', 16),
      slot('herbal', 'main', 'Calm herbal blend', 'Chamomile, lemon balm and lavender, caffeine free. 40 g.', 12),
      slot('bump', 'bump', 'Bamboo tea infuser', 'A reusable infuser for loose leaf.', 6),
    ],
    steps: [{ name: 'Shop', path: '/shop', kind: 'sales', doc: shop }, { name: 'Cart', path: '/shop-cart', kind: 'page', doc: cart }, { name: 'Checkout', path: '/shop-checkout', kind: 'checkout', doc: pay }, { name: 'Thank you', path: '/shop-thanks', kind: 'thankyou', doc: thanks }],
  };
}

// ---- Offer page with a payment page ------------------------------------------------------------------------------------------------------------------

function offerWithPaymentPage(): TemplateDef {
  const accent = '#7c3aed';
  const pm = createPageBuilder('op');
  const offer = finish(pm, [
    pm.section([pm.row([
      pm.col([
        pm.eyebrow('Online workshop · 6 lessons'),
        pm.heading('Learn watercolour in a weekend', { level: 1 }),
        pm.text('Short video lessons, printable practice sheets and a supply list that costs less than $30. Start tonight, finish a painting by Sunday.', { muted: true, size: '1.1rem' }),
        pm.list(['Six lessons, 20 minutes each', 'Lifetime access and updates', '30-day money-back guarantee']),
        pm.button('Get the workshop for $49', { type: 'next_step' }, { size: 'lg' }),
      ], { grow: 1 }),
      pm.col([art(pm, '#ddd6fe', '#fbcfe8', 'Watercolour weekend')]),
    ], { valign: 'center', gap: 'lg' })], { padding: 'xl', width: 'wide' }),
    faqSection(pm, 'Questions', [
      { q: 'Do I need experience?', a: 'No. Lesson one starts with how to hold the brush.' },
      { q: 'How do I pay?', a: 'By card on the next page. Your card details go straight to our payment provider.' },
    ]),
    footer(pm, 'Studio Wash'),
  ], { accent });

  const pm2 = createPageBuilder('oc');
  const checkout = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.heading('Complete your enrolment', { level: 1, align: 'center' }),
      pm2.text('One payment, lifetime access. You will get your login by email right after paying.', { align: 'center', muted: true }),
      pm2.checkout('oc-bump', { slot: 'bump', productName: 'Printable practice pack', price: 9, orderBump: true, description: '40 pages of exercises to print at home.' }),
      pm2.payment('oc-pay', { source: 'product', slot: 'main', productName: 'Watercolour weekend workshop', price: 49, title: 'Watercolour weekend workshop', buttonLabel: 'Pay and start learning' }),
    ])], { padding: 'lg', width: 'small' }),
    footer(pm2, 'Studio Wash'),
  ], { accent });

  const pm3 = createPageBuilder('ot');
  const thanks = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'You are in', title: 'Welcome to Watercolour weekend', text: 'Your login is on its way by email. Lesson one takes 20 minutes: grab a brush and a glass of water.' }),
    footer(pm3, 'Studio Wash'),
  ], { accent });

  return {
    slug: 'offer-with-payment-page', version: 1, name: 'Offer with a payment page', description: 'An offer page that leads to a dedicated checkout page with the card form on the page (Payment form) and an order bump, then a welcome page.',
    category: 'ecommerce', industry: 'education', goal: 'sales', tags: ['payment form', 'checkout page', 'course', 'order bump', 'card on page'], basePath: '/watercolour', accent,
    products: [slot('main', 'main', 'Watercolour weekend workshop', 'Six video lessons with lifetime access.', 49), slot('bump', 'bump', 'Printable practice pack', '40 pages of exercises.', 9)],
    steps: [{ name: 'Offer', path: '/watercolour', kind: 'sales', doc: offer }, { name: 'Checkout', path: '/watercolour-checkout', kind: 'checkout', doc: checkout }, { name: 'Welcome', path: '/watercolour-welcome', kind: 'thankyou', doc: thanks }],
  };
}

export const templates: TemplateDef[] = [storeWithCart(), offerWithPaymentPage()];
