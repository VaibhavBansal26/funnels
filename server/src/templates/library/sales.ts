import {
  HERO, PASTEL, browserMock, chartMock, createPageBuilder, ctaBand, discs, faqSection, feature, field, finish, footer, iconBadge as kitBadge, logoStrip, nav, priceCard, ratingLine, ringMock, stat,
  testimonial, thanksSection, type GjsNode, type PageBuilder,
} from '../kit.js';
import type { TemplateDef, TemplateProduct } from '../types.js';

/** Commerce templates: single-product store, SaaS trial and demo, course membership, coaching, donations and the upsell/downsell pack. */

const iconBadge = (pm: PageBuilder, glyph: string, bg: string, fg: string, size?: string): GjsNode => kitBadge(pm, glyph, bg as never, fg, size);

const slot = (key: string, role: TemplateProduct['role'], name: string, description: string, amount: number, extra: Partial<TemplateProduct> = {}): TemplateProduct =>
  ({ key, role, name, description, type: 'one_time', amount, currency: 'USD', ...extra });

const bullets = (pm: PageBuilder, items: string[], dark = false): GjsNode =>
  pm.box(items.map((t) => pm.box([iconBadge(pm, '✓', dark ? '#14532d' : PASTEL.green, dark ? '#dcfce7' : '#14532d', '28px'), pm.text(t)], { name: 'Point', style: { display: 'flex', 'align-items': 'center', gap: '12px' } })), { name: 'Points', style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } });

/** Numbered steps; the digit carries its own colour so the pairing is explicit. */
const stepsRow = (pm: PageBuilder, items: { title: string; body: string }[]): GjsNode =>
  pm.cols(items.map((it, i) => [pm.box([
    pm.box([pm.text(String(i + 1), { align: 'center', color: '#ffffff' })], { name: 'Step number', style: { width: '44px', height: '44px', 'border-radius': '50%', background: '#4338ca', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(it.title, { level: 3 }), pm.text(it.body, { muted: true }),
  ], { name: 'Step', style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } })]));

// ---- 1. ecommerce single product ------------------------------------------------------------------------------------------------------------------------

function candle(pm: PageBuilder): GjsNode {
  const flame = pm.box([], { name: 'Flame', style: { width: '26px', height: '44px', 'border-radius': '50% 50% 50% 50% / 70% 70% 30% 30%', background: 'linear-gradient(180deg,#fde68a,#f97316)', margin: '0 auto -4px' } });
  const wick = pm.box([], { name: 'Wick', style: { width: '4px', height: '16px', background: '#1c1917', margin: '0 auto' } });
  const jar = pm.box([pm.box([], { name: 'Label', style: { width: '58%', height: '84px', margin: '70px auto 0', background: '#fef3c7', 'border-radius': '10px', border: '2px solid #92400e' } })], { name: 'Jar', style: { width: '190px', height: '210px', margin: '0 auto', 'border-radius': '16px 16px 40px 40px', background: 'linear-gradient(135deg,#78350f,#b45309 55%,#92400e)', 'box-shadow': '0 24px 40px -18px rgba(67,20,7,.7)' } });
  return pm.box([flame, wick, jar], { name: 'Product art', style: { padding: '48px 24px 40px', 'border-radius': '24px', background: 'radial-gradient(circle at 50% 30%,#fff7ed 0%,#fed7aa 100%)', width: '100%' } });
}

function ecommerce(): TemplateDef {
  const pm = createPageBuilder('ec');
  const product = finish(pm, [
    nav(pm, 'Ember & Oak', [['Reviews', '#reviews'], ['FAQ', '#faq']]),
    pm.section([
      pm.row([
        pm.col([candle(pm)]),
        pm.col([
          pm.eyebrow('Small-batch, hand-poured'),
          pm.heading('The Ember Glass Candle', { level: 1 }),
          ratingLine(pm, '4.9', 'from 2,310 reviews'),
          pm.text('Sixty hours of slow, even light and a scent of cedar, amber and warm vanilla. Poured by hand in a reusable amber glass jar.', { muted: true, size: '1.1rem' }),
          bullets(pm, ['Soy and coconut wax, no paraffin', 'Lead-free cotton wick, 60-hour burn', 'Jar reusable as a tumbler or planter', 'Free shipping over $35, 30-day returns']),
          pm.button('Order for $38', { type: 'anchor', anchor: 'order' }, { size: 'lg' }),
        ], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow('Why people reorder', { align: 'center' }), pm.heading('Made slowly, burns cleanly', { align: 'center' })]),
      pm.cols([[feature(pm, '1', 'Clean burn', 'A wide wick and plant wax mean no soot on the jar and no smoke in the room.')], [feature(pm, '2', 'Layered scent', 'Cedar on top, amber in the middle, vanilla at the base. It fills a room without taking it over.')], [feature(pm, '3', 'Made to keep', 'When the wax is gone, wash the jar and use it again. We also sell refills.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Take it home today', { level: 2 }), pm.text('Add the candle to your order below. Gift wrap is one tick away.', { muted: true }), pm.list(['Ships in 1 to 2 business days', 'Secure payment by card', 'Love it or send it back within 30 days'])]),
        pm.col([
          pm.checkout('ec-main', { slot: 'main', productName: 'Ember Glass Candle', price: 38, description: '8 oz hand-poured candle in an amber glass jar.', buttonLabel: 'Buy the candle' }),
          pm.checkout('ec-bump', { slot: 'bump', productName: 'Gift wrap and note', price: 6, orderBump: true, description: 'Wrapped in recycled paper with a handwritten card.' }),
        ]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide', anchor: 'order' }),
    pm.section([pm.stack([pm.heading('What customers say', { align: 'center' })]), pm.cols([
      [testimonial(pm, 'Smells like a cabin in the woods. I have bought four.', 'Hannah W.', 'Verified buyer', 'HW')],
      [testimonial(pm, 'No soot, no headache, and the jar is now my pen holder.', 'Marcus T.', 'Verified buyer', 'MT')],
      [testimonial(pm, 'Gave it as a gift and the whole family asked where to get one.', 'Elena R.', 'Verified buyer', 'ER')],
    ])], { theme: 'soft', padding: 'lg', width: 'wide', anchor: 'reviews' }),
    pm.section([pm.stack([pm.heading('Questions', { align: 'center', level: 2 }), pm.faq([
      { q: 'How long does it burn?', a: 'About 60 hours when you trim the wick to 5 mm and burn it for up to 4 hours at a time.' },
      { q: 'Do you ship internationally?', a: 'We ship to the US, Canada, the UK and the EU. Delivery takes 3 to 10 business days.' },
      { q: 'What if it arrives damaged?', a: 'Send us a photo and we will replace it at no cost.' },
    ])])], { padding: 'lg', width: 'small', anchor: 'faq' }),
    footer(pm, 'Ember & Oak'),
  ], { accent: '#b45309' });

  const pm2 = createPageBuilder('eu');
  const upsell = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.badgeText('Your order is almost done'),
      pm2.heading('Never run out: add the 3-pack of refills', { level: 1, align: 'center' }),
      pm2.text('Refill pours fit your Ember jar and save you 25 percent. One click, shipped with your candle.', { align: 'center', muted: true, size: '1.1rem' }),
      pm2.row([pm2.col([candle(pm2)]), pm2.col([
        bullets(pm2, ['Three 6 oz refills, same scent', 'Pour into your clean jar and relight', 'Ships together with today\'s order']),
        pm2.checkout('eu-up', { slot: 'upsell', productName: 'Candle refill 3-pack', price: 45, oneClickUpsell: true, buttonLabel: 'Yes, add the refills', description: 'Charged to the card you just used.' }),
      ])], { valign: 'center', gap: 'lg' }),
    ])], { padding: 'xl', width: 'medium', align: 'center' }),
  ], { accent: '#b45309' });

  const pm3 = createPageBuilder('et');
  const thanks = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'Order confirmed', title: 'Thank you, your candle is on its way', text: 'A receipt and tracking details are in your inbox. Most orders ship within two business days.', bullets: ['Check your email for the receipt', 'Look out for the tracking link', 'Tag us with your glow'] }),
    footer(pm3, 'Ember & Oak'),
  ], { accent: '#b45309' });

  return {
    slug: 'ecommerce-single-product', version: 1, name: 'Single-product store', description: 'A one-product shop page with reviews, an order bump for gift wrap, a one-click refill upsell and an order confirmation.',
    category: 'ecommerce', industry: 'ecommerce', goal: 'sales', tags: ['ecommerce', 'product page', 'order bump', 'upsell', 'reviews'], basePath: '/candle', accent: '#b45309',
    products: [slot('main', 'main', 'Ember Glass Candle', '8 oz hand-poured candle in an amber glass jar.', 38), slot('bump', 'bump', 'Gift wrap and note', 'Wrapped in recycled paper with a handwritten card.', 6), slot('upsell', 'upsell', 'Candle refill 3-pack', 'Three refills that fit the Ember jar.', 45)],
    steps: [{ name: 'Product page', path: '/candle', kind: 'sales', doc: product }, { name: 'Refill offer', path: '/candle-refills', kind: 'upsell', doc: upsell }, { name: 'Thank you', path: '/candle-thanks', kind: 'thankyou', doc: thanks }],
  };
}

// ---- 2. SaaS free trial ---------------------------------------------------------------------------------------------------------------------------------

function saasTrial(): TemplateDef {
  const pm = createPageBuilder('st');
  const landing = finish(pm, [
    nav(pm, 'Tidewise', [['Features', '#features'], ['Customers', '#customers']]),
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('14 days free, no charge today'),
          pm.heading('Know where every project stands, without the status meetings', { level: 1 }),
          pm.text('Tidewise turns scattered tasks into one live timeline your whole team can read. Set it up in ten minutes.', { size: '1.15rem', muted: true }),
          pm.row([pm.col([pm.button('Start your free trial', { type: 'next_step' }, { size: 'lg' })], { grow: 0 }), pm.col([pm.button('See how it works', { type: 'anchor', anchor: 'features' }, { variant: 'secondary', size: 'lg' })], { grow: 0 })], { keep: true, gap: 'sm' }),
          pm.text('Cancel any time. No card needed until day 14.', { muted: true, size: '.9rem' }),
        ], { grow: 1 }),
        pm.col([browserMock(pm, '#4338ca', { tint: '#0e7490', height: '240px' })]),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'soft', padding: 'xl', width: 'wide' }),
    pm.section([logoStrip(pm, 'Trusted by 4,000 teams at', ['NORTHWIND', 'LUMEN&CO', 'BRIGHTPATH', 'KESTREL', 'OAKLINE'])], { padding: 'md', width: 'wide', anchor: 'customers' }),
    pm.section([
      pm.stack([pm.eyebrow('Features', { align: 'center' }), pm.heading('Everything a team needs, nothing it does not', { align: 'center' })]),
      pm.cols([
        [feature(pm, '▤', 'Live timeline', 'Drag work across weeks and see dependencies shift in real time.')],
        [feature(pm, '✦', 'Automatic updates', 'Weekly summaries are written for you from what actually changed.')],
        [feature(pm, '⇄', 'Plays well with others', 'Connect Slack, GitHub and Google Calendar in two clicks.')],
      ]),
    ], { theme: 'soft', padding: 'lg', width: 'wide', anchor: 'features' }),
    pm.section([pm.row([pm.col([chartMock(pm, [30, 42, 38, 55, 70, 88], '#4338ca')]), pm.col([pm.heading('Teams ship 31 percent faster', { level: 2 }), pm.text('In a survey of 600 Tidewise teams, the median project finished almost a third sooner after one quarter of use.', { muted: true }), pm.list(['Fewer status meetings', 'Earlier warnings on slipping work', 'One source of truth for deadlines'])])], { valign: 'center', gap: 'lg' })], { padding: 'lg', width: 'wide' }),
    ctaBand(pm, 'Try Tidewise free for 14 days', 'Full access to every feature. Pick a plan only if you love it.', 'Start your free trial'),
    footer(pm, 'Tidewise'),
  ], { accent: '#4338ca' });

  const pm2 = createPageBuilder('sc');
  const trial = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.eyebrow('Step 1 of 2', { align: 'center' }),
      pm2.heading('Start your 14-day free trial', { level: 1, align: 'center' }),
      pm2.text('Enter your email to create your workspace. You will not be charged during the trial, and we remind you three days before it ends.', { align: 'center', muted: true }),
      pm2.checkout('sc-main', { slot: 'main', productName: 'Pro plan', price: 29, description: '14 days free, then $29 per month. Cancel any time.', buttonLabel: 'Start free trial' }),
      bullets(pm2, ['Unlimited projects and teammates on trial', 'Export your data whenever you like', 'Pro plan renews at $29 a month after day 14']),
    ])], { padding: 'xl', width: 'small', align: 'center' }),
    footer(pm2, 'Tidewise'),
  ], { accent: '#4338ca' });

  const pm3 = createPageBuilder('sw');
  const welcome = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'Trial started', title: 'Welcome to Tidewise', text: 'Your workspace is ready. These three steps take about ten minutes and make the first week count.' }),
    pm3.section([stepsRow(pm3, [{ title: 'Create a project', body: 'Import a spreadsheet or start from a template.' }, { title: 'Invite your team', body: 'Teammates are free during the trial.' }, { title: 'Connect Slack', body: 'Get the weekly summary where you already work.' }])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm3, 'Tidewise'),
  ], { accent: '#4338ca' });

  return {
    slug: 'saas-free-trial', version: 1, name: 'SaaS free trial', description: 'Landing page, a subscription checkout with a 14-day trial and an onboarding welcome page for a software product.',
    category: 'saas', industry: 'saas', goal: 'sales', tags: ['saas', 'free trial', 'subscription', 'software', 'onboarding'], basePath: '/trial', accent: '#4338ca',
    products: [slot('main', 'main', 'Pro plan', '14 days free, then $29 per month. Cancel any time.', 29, { type: 'subscription', interval: 'month', trialDays: 14 })],
    steps: [{ name: 'Landing page', path: '/trial', kind: 'landing', doc: landing }, { name: 'Start trial', path: '/trial-start', kind: 'checkout', doc: trial }, { name: 'Welcome', path: '/trial-welcome', kind: 'thankyou', doc: welcome }],
  };
}

// ---- 3. SaaS demo booking -------------------------------------------------------------------------------------------------------------------------------

function saasDemo(): TemplateDef {
  const pm = createPageBuilder('sd');
  const landing = finish(pm, [
    nav(pm, 'Relay', [['Why Relay', '#why'], ['Results', '#results']]),
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Customer support platform'),
          pm.heading('Answer customers in minutes, not days', { level: 1 }),
          pm.text('Relay brings email, chat and social into one inbox with AI-drafted replies your agents approve in a click. See it on your own tickets in a 30-minute demo.', { muted: true, size: '1.15rem' }),
          bullets(pm, ['Live walkthrough tailored to your team', 'Migration plan and pricing on the call', 'No obligation, no slide deck'], true),
        ], { grow: 1 }),
        pm.col([pm.form('sd-form', { name: 'Book a demo', fields: [field('name', 'name', 'Full name', true), field('email', 'email', 'Work email', true), field('company', 'text', 'Company', true), field('size', 'select', 'Company size', true, { options: ['1-10 people', '11-50 people', '51-200 people', '201-1,000 people', '1,000+ people'] }), field('needs', 'textarea', 'What would you like to see?')], submitLabel: 'Request my demo', consent: { enabled: true, text: 'I agree to be contacted about my demo request.' } })]),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.indigo, padding: 'xl', width: 'wide', anchor: 'demo' }),
    pm.section([statsRow2(pm)], { padding: 'lg', width: 'wide', anchor: 'results' }),
    pm.section([
      pm.stack([pm.eyebrow('Why Relay', { align: 'center' }), pm.heading('Built for teams that care about every reply', { align: 'center' })]),
      pm.cols([[feature(pm, '1', 'One shared inbox', 'Every channel in one queue, with owners, labels and SLA timers.')], [feature(pm, '2', 'Drafts that sound like you', 'Replies are drafted from your help centre and past answers.')], [feature(pm, '3', 'Reports that matter', 'First response time, resolution time and satisfaction by agent.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide', anchor: 'why' }),
    pm.section([pm.cols([[testimonial(pm, 'We cut first response time from nine hours to forty minutes in a month.', 'Dana Ortiz', 'Head of Support, Kestrel', 'DO')], [testimonial(pm, 'The demo showed our own tickets. We signed the same week.', 'Ravi Menon', 'COO, Oakline', 'RM')]])], { padding: 'lg', width: 'wide' }),
    footer(pm, 'Relay'),
  ]);
  const pm2 = createPageBuilder('sq');
  const thanks = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Demo requested', title: 'Thanks, we will be in touch today', text: 'A product specialist will email you within one business day to agree a time.', bullets: ['Watch for an email from demos@relay.example', 'Send us a few sample tickets if you like', 'Invite a colleague to join the call'] }),
    footer(pm2, 'Relay'),
  ]);
  return {
    slug: 'saas-demo-booking', version: 1, name: 'SaaS demo booking', description: 'A B2B landing page with proof, features and a qualifying demo-request form that asks for company size, followed by a confirmation page.',
    category: 'saas', industry: 'saas', goal: 'booking', tags: ['saas', 'demo', 'b2b', 'lead form', 'booking'], basePath: '/demo', accent: '#3730a3', products: [],
    steps: [{ name: 'Landing page', path: '/demo', kind: 'landing', doc: landing }, { name: 'Demo requested', path: '/demo-requested', kind: 'thankyou', doc: thanks }],
  };
}

function statsRow2(pm: PageBuilder): GjsNode {
  return pm.cols([[stat(pm, '4.8x', 'faster first replies')], [stat(pm, '92%', 'customer satisfaction')], [stat(pm, '1,200+', 'support teams')], [stat(pm, '10 min', 'typical setup')]], { keep: true, gap: 'sm' });
}

// ---- 4. online course and membership --------------------------------------------------------------------------------------------------------------------

function course(): TemplateDef {
  const pm = createPageBuilder('oc');
  const sales = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Founding members open'),
          pm.heading('Learn to photograph people with confidence', { level: 1 }),
          pm.text('The Portrait Lab is a year of weekly lessons, monthly live critiques and a friendly community, taught by working photographer Mira Castellan.', { muted: true, size: '1.15rem' }),
          pm.button('Join as a founding member', { type: 'anchor', anchor: 'join' }, { size: 'lg' }),
          ratingLine(pm, '4.9', 'from 780 members', true),
        ], { grow: 1 }),
        pm.col([pm.box([pm.box([], { name: 'Play', style: { width: '72px', height: '72px', 'border-radius': '50%', background: 'rgba(255,255,255,.2)', border: '2px solid #ffffff' } }), discs(pm, ['#fda4af', '#c4b5fd', '#fcd34d'], '150px')], { name: 'Lesson art', style: { display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '8px', padding: '24px', 'border-radius': '20px', background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.2)' } })]),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.plum, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow('Curriculum', { align: 'center' }), pm.heading('Four modules, 48 lessons', { align: 'center' })]),
      pm.cols([
        [pm.card([iconBadge(pm, '1', PASTEL.violet, '#3b0764'), pm.heading('Light', { level: 3 }), pm.list(['Reading window light in ten minutes', 'Golden hour, open shade and overcast', 'One speedlight, three looks', 'Fixing bad light on the spot'])], { name: 'Module 1' })],
        [pm.card([iconBadge(pm, '2', PASTEL.rose, '#881337'), pm.heading('Posing', { level: 3 }), pm.list(['Directing shy and confident subjects', 'Hands, chins and shoulders', 'Couples and groups', 'Candid moments that feel natural'])], { name: 'Module 2' })],
      ]),
      pm.cols([
        [pm.card([iconBadge(pm, '3', PASTEL.amber, '#78350f'), pm.heading('Editing', { level: 3 }), pm.list(['A calm, repeatable colour workflow', 'Skin tones that stay true', 'Retouching without plastic skin', 'Exporting for print and web'])], { name: 'Module 3' })],
        [pm.card([iconBadge(pm, '4', PASTEL.teal, '#134e4a'), pm.heading('Business', { level: 3 }), pm.list(['Pricing your first paid shoots', 'Contracts and model releases', 'Finding clients locally', 'Building a portfolio in 90 days'])], { name: 'Module 4' })],
      ]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([pm.cols([[feature(pm, '▶', 'Weekly lessons', 'A new short lesson every week, plus the full back catalogue.')], [feature(pm, '◉', 'Monthly live critique', 'Submit a photo and get honest, kind feedback on camera.')], [feature(pm, '☺', 'Private community', 'Share work and swap tips with 2,000 fellow photographers.')]])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Join the founding class', { level: 2 }), pm.text('Founding members lock in this price for as long as they stay, and get the workbook bundle at a discount.', { muted: true }), pm.list(['Full curriculum and every future lesson', 'Monthly live critique', 'Private community', '30-day money-back guarantee'])]),
        pm.col([
          pm.checkout('oc-main', { slot: 'main', productName: 'Founding membership (annual)', price: 249, description: 'Billed once a year. Cancel any time.', buttonLabel: 'Join for $249 a year' }),
          pm.checkout('oc-bump', { slot: 'bump', productName: 'Workbook bundle', price: 19, orderBump: true, description: 'Printable shot lists, posing cards and an editing checklist.' }),
        ]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide', anchor: 'join' }),
    faqSection(pm, 'Questions', [{ q: 'Do I need a fancy camera?', a: 'No. Every lesson works with an entry-level camera or a recent phone.' }, { q: 'What if it is not for me?', a: 'Email us in the first 30 days for a full refund.' }, { q: 'How much time does it take?', a: 'Most members spend two to three hours a week.' }]),
    footer(pm, 'The Portrait Lab'),
  ], { accent: '#86198f' });
  const pm2 = createPageBuilder('ow');
  const welcome = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Membership active', title: 'Welcome to the Portrait Lab', text: 'Your membership is active and a login link is on its way to your inbox.', bullets: ['Open the welcome email and set your password', 'Watch the 10-minute orientation lesson', 'Introduce yourself in the community'] }),
    footer(pm2, 'The Portrait Lab'),
  ], { accent: '#86198f' });
  return {
    slug: 'online-course-membership', version: 1, name: 'Course and membership', description: 'A sales page for a membership course with a tabbed curriculum, an annual subscription, a workbook order bump and a welcome page.',
    category: 'education', industry: 'education', goal: 'sales', tags: ['course', 'membership', 'subscription', 'order bump', 'education'], basePath: '/membership', accent: '#86198f',
    products: [slot('main', 'main', 'Founding membership (annual)', 'Billed once a year. Cancel any time.', 249, { type: 'subscription', interval: 'year' }), slot('bump', 'bump', 'Workbook bundle', 'Printable shot lists, posing cards and an editing checklist.', 19)],
    steps: [{ name: 'Sales page', path: '/membership', kind: 'sales', doc: sales }, { name: 'Welcome', path: '/membership-welcome', kind: 'thankyou', doc: welcome }],
  };
}

// ---- 5. coaching ----------------------------------------------------------------------------------------------------------------------------------------

function coaching(): TemplateDef {
  const pm = createPageBuilder('co');
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('1:1 leadership coaching'),
          pm.heading('Lead with clarity, and keep your weekends', { level: 1 }),
          pm.text('I help first-time managers and founders build teams that run without them. Twelve weeks, one call a week, a plan you can use on Monday.', { muted: true, size: '1.15rem' }),
          pm.button('Apply for a spot', { type: 'next_step' }, { size: 'lg' }),
        ], { grow: 1 }),
        pm.col([discs(pm, ['#5eead4', '#a7f3d0', '#fcd34d'], '240px')]),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.teal, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([iconBadge(pm, 'JA', '#ccfbf1', '#134e4a', '88px')], { grow: 0, style: { 'flex-basis': '96px' } }),
        pm.col([pm.heading('Hi, I am Jordan Ames', { level: 2 }), pm.text('For twelve years I led engineering teams from five people to eighty. Now I coach leaders through the same hard moments: the first hire, the first firing, the first time everything depends on you.', { muted: true })]),
      ], { valign: 'center', gap: 'lg', keep: true }),
    ], { padding: 'lg', width: 'medium' }),
    pm.section([
      pm.stack([pm.eyebrow('Programmes', { align: 'center' }), pm.heading('Choose how we work together', { align: 'center' })]),
      pm.cols([
        [priceCard(pm, { name: 'Focus', price: '$1,200', period: 'one-off', blurb: 'A single deep-dive for one big decision.', features: ['Two 60-minute sessions', 'Written action plan', 'Email support for 2 weeks'], cta: 'Apply', action: { type: 'next_step' } })],
        [priceCard(pm, { name: 'Lead', price: '$3,600', period: '12 weeks', blurb: 'Weekly coaching to change how you lead.', features: ['12 weekly 60-minute calls', 'Team and 360 feedback review', 'Unlimited async support'], cta: 'Apply', action: { type: 'next_step' }, featured: true, badge: 'Most popular' })],
        [priceCard(pm, { name: 'Scale', price: '$7,800', period: '6 months', blurb: 'For founders growing a leadership team.', features: ['Fortnightly 90-minute calls', 'Coaching for two direct reports', 'Quarterly offsite planning'], cta: 'Apply', action: { type: 'next_step' } })],
      ]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([testimonial(pm, 'In three months I stopped being the bottleneck. My team now ships without asking me for permission.', 'Priya Nair', 'Founder, Brightwell', 'PN')], { padding: 'lg', width: 'small' }),
    footer(pm, 'Jordan Ames Coaching'),
  ], { accent: '#0f766e' });
  const pm2 = createPageBuilder('ca');
  const apply = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.eyebrow('Application', { align: 'center' }),
      pm2.heading('Tell me about you', { level: 1, align: 'center' }),
      pm2.text('Two minutes. I read every application personally and reply within three working days.', { align: 'center', muted: true }),
      pm2.form('ca-form', { name: 'Coaching application', fields: [field('name', 'name', 'Full name', true), field('email', 'email', 'Email', true), field('role', 'select', 'Your role', true, { options: ['First-time manager', 'Senior manager or director', 'Founder or CEO', 'Other'] }), field('program', 'select', 'Programme of interest', true, { options: ['Focus', 'Lead', 'Scale', 'Not sure yet'] }), field('goal', 'textarea', 'What is the one thing you want to change?', true)], submitLabel: 'Send my application', consent: { enabled: true, text: 'I agree to be contacted about my application.' } }),
    ])], { padding: 'xl', width: 'small' }),
    footer(pm2, 'Jordan Ames Coaching'),
  ], { accent: '#0f766e' });
  const pm3 = createPageBuilder('cr');
  const done = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'Application received', title: 'Thank you, I will be in touch', text: 'I will review your application and email you within three working days.', bullets: ['Look out for an email from Jordan', 'Pick a time for a free 20-minute intro call', 'Prepare one question you want answered'] }),
    footer(pm3, 'Jordan Ames Coaching'),
  ], { accent: '#0f766e' });
  return {
    slug: 'coaching-program', version: 1, name: 'Coaching programme', description: 'A coach introduction with three programme tiers, a qualifying application form and a confirmation page.',
    category: 'booking', industry: 'coaching', goal: 'booking', tags: ['coaching', 'application', 'programme', 'consulting', 'booking'], basePath: '/coaching', accent: '#0f766e', products: [],
    steps: [{ name: 'Landing page', path: '/coaching', kind: 'landing', doc: landing }, { name: 'Apply', path: '/coaching-apply', kind: 'application', doc: apply }, { name: 'Request received', path: '/coaching-received', kind: 'thankyou', doc: done }],
  };
}

// ---- 6. donation ----------------------------------------------------------------------------------------------------------------------------------------

function donation(): TemplateDef {
  const pm = createPageBuilder('dn');
  const campaign = finish(pm, [
    pm.section([pm.stack([
      pm.eyebrow('Clean water campaign', { align: 'center' }),
      pm.heading('Bring clean water to 5,000 people this year', { level: 1, align: 'center' }),
      pm.text('Every $50 builds a safe tap stand for a family in rural Kenya. Join 1,900 donors who have already given.', { align: 'center', muted: true, size: '1.15rem' }),
      pm.progress(68, '$68,000 raised of $100,000'),
      pm.button('Give today', { type: 'anchor', anchor: 'give' }, { variant: 'secondary', size: 'lg', align: 'center' }),
    ])], { theme: 'dark', background: HERO.forest, padding: 'xl', width: 'medium', align: 'center' }),
    pm.section([
      pm.stack([pm.heading('What your gift does', { align: 'center' })]),
      pm.cols([
        [pm.card([iconBadge(pm, '$25', PASTEL.blue, '#1e3a8a'), pm.heading('Clean water for a month', { level: 3 }), pm.text('Treats and delivers safe drinking water to one family for a month.', { muted: true })])],
        [pm.card([iconBadge(pm, '$50', PASTEL.green, '#14532d'), pm.heading('A family tap stand', { level: 3 }), pm.text('Builds a tap stand that serves a household for ten years.', { muted: true })])],
        [pm.card([iconBadge(pm, '$250', PASTEL.amber, '#78350f'), pm.heading('A school filter system', { level: 3 }), pm.text('Gives 300 pupils clean water every day at school.', { muted: true })])],
      ]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Make your gift', { level: 2 }), pm.text('Gifts are tax-deductible. We publish where every dollar goes: 92 cents of each dollar funds projects.', { muted: true }), ringMock(pm, 92, '92%', '#15803d')]),
        pm.col([
          pm.checkout('dn-main', { slot: 'main', productName: 'One-time gift', price: 50, description: 'Builds a safe tap stand for a family.', buttonLabel: 'Donate now' }),
          pm.checkout('dn-bump', { slot: 'bump', productName: 'Cover the processing fees', price: 5, orderBump: true, description: 'So 100 percent of your gift reaches the project.' }),
        ]),
      ], { gap: 'lg', valign: 'center' }),
    ], { theme: 'soft', padding: 'lg', width: 'wide', anchor: 'give' }),
    pm.section([pm.cols([[testimonial(pm, 'Our village used to walk four hours for water. Now it is ten steps from my door.', 'Grace M.', 'Beneficiary, Kitui County', 'GM')], [testimonial(pm, 'I give every year. The reports show exactly what was built.', 'Tom H.', 'Donor since 2019', 'TH')]])], { padding: 'lg', width: 'wide' }),
    footer(pm, 'Clearwater Foundation'),
  ], { accent: '#15803d' });
  const pm2 = createPageBuilder('dt');
  const thanks = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Gift received', title: 'Thank you for your generosity', text: 'Your receipt is in your inbox. In 60 days we will email you a photo of the project your gift helped build.', bullets: ['Keep your email receipt for tax purposes', 'Share the campaign with a friend', 'Follow our progress reports'] }),
    footer(pm2, 'Clearwater Foundation'),
  ], { accent: '#15803d' });
  return {
    slug: 'donation-nonprofit', version: 1, name: 'Donation campaign', description: 'A fundraising page with a progress bar, impact levels, a one-time gift checkout with a cover-the-fees bump and a thank-you page.',
    category: 'nonprofit', industry: 'nonprofit', goal: 'donations', tags: ['donation', 'nonprofit', 'fundraising', 'charity', 'campaign'], basePath: '/donate', accent: '#15803d',
    products: [slot('main', 'main', 'One-time gift', 'Builds a safe tap stand for a family.', 50), slot('bump', 'bump', 'Cover the processing fees', 'So 100 percent of your gift reaches the project.', 5)],
    steps: [{ name: 'Campaign page', path: '/donate', kind: 'landing', doc: campaign }, { name: 'Thank you', path: '/donate-thanks', kind: 'thankyou', doc: thanks }],
  };
}

// ---- 7. upsell and downsell pack ------------------------------------------------------------------------------------------------------------------------

function pack(): TemplateDef {
  const pm = createPageBuilder('ud');
  const upsell = finish(pm, [
    pm.section([pm.stack([
      pm.badgeText('Wait, your order is not finished'),
      pm.heading('Add the VIP Implementation Pack', { level: 1, align: 'center' }),
      pm.text('Skip the learning curve. Get our done-with-you setup: templates, a 60-minute onboarding call and a private support channel.', { align: 'center', muted: true, size: '1.1rem' }),
      pm.row([pm.col([browserMock(pm, '#be123c', { tint: '#4c0519', height: '190px' })]), pm.col([bullets(pm, ['12 ready-to-use templates', '60-minute onboarding call', '90 days of private support']), pm.checkout('ud-up', { slot: 'upsell', productName: 'VIP Implementation Pack', price: 147, oneClickUpsell: true, buttonLabel: 'Yes, add the VIP pack', description: 'One-time payment. We use the card from your order.' })])], { valign: 'center', gap: 'lg' }),
    ])], { padding: 'xl', width: 'medium', align: 'center' }),
  ], { accent: '#be123c' });
  const pm2 = createPageBuilder('dd');
  const downsell = finish(pm2, [
    pm2.section([pm2.stack([
      pm2.eyebrow('A lighter option', { align: 'center' }),
      pm2.heading('How about the Quick-start Edition?', { level: 1, align: 'center' }),
      pm2.text('The essentials of the VIP pack at less than a third of the price: the templates and a recorded walkthrough.', { align: 'center', muted: true, size: '1.1rem' }),
      pm2.row([pm2.col([ringMock(pm2, 68, '68%', '#be123c')], { grow: 0 }), pm2.col([pm2.text('Save 68 percent compared with the VIP pack.', { muted: true }), bullets(pm2, ['12 ready-to-use templates', 'Recorded 30-minute walkthrough', 'Community access'])])], { valign: 'center', gap: 'lg' }),
      pm2.checkout('dd-down', { slot: 'downsell', productName: 'Quick-start Edition', price: 47, oneClickUpsell: true, downsell: true, buttonLabel: 'Yes, add the Quick-start', description: 'One-time payment on the card from your order.' }),
    ])], { theme: 'soft', padding: 'xl', width: 'small', align: 'center' }),
  ], { accent: '#be123c' });
  const pm3 = createPageBuilder('dy');
  const thanks = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'All set', title: 'Thank you, your order is complete', text: 'Everything you purchased is on its way to your inbox, along with your receipt.', bullets: ['Open your welcome email', 'Download your files', 'Book your onboarding call if you added it'], button: { label: 'Share with a friend', action: { type: 'link', url: 'https://example.com', newTab: true } } }),
    footer(pm3, 'Your Company'),
  ], { accent: '#be123c' });
  return {
    slug: 'upsell-downsell-pack', version: 1, name: 'Upsell and downsell pack', description: 'Add-on pages for any sales funnel: a one-click upsell, a cheaper downsell for those who decline, and a final thank-you page.',
    category: 'follow-up', industry: 'general', goal: 'sales', tags: ['upsell', 'downsell', 'one-click', 'thank you', 'post-purchase'], basePath: '/vip-offer', accent: '#be123c',
    products: [slot('upsell', 'upsell', 'VIP Implementation Pack', 'Templates, onboarding call and 90 days of support.', 147), slot('downsell', 'downsell', 'Quick-start Edition', 'Templates and a recorded walkthrough.', 47)],
    steps: [{ name: 'Upsell', path: '/vip-offer', kind: 'upsell', doc: upsell }, { name: 'Downsell', path: '/quick-start-offer', kind: 'downsell', doc: downsell }, { name: 'Thank you', path: '/order-complete', kind: 'thankyou', doc: thanks }],
  };
}

export const templates: TemplateDef[] = [ecommerce(), saasTrial(), saasDemo(), course(), coaching(), donation(), pack()];
