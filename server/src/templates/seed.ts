import { createBuilder, documentOf, field, type Block, type PageDocument } from '../blocks/index.js';
import type { Db } from '../db/index.js';

export interface SeedTemplate {
  slug: string;
  name: string;
  description: string;
  category: string;
  basePath: string;
  steps: { name: string; path: string; doc: PageDocument }[];
}

export const CATEGORIES = [
  { slug: 'lead-generation', name: 'Lead generation' },
  { slug: 'events', name: 'Events' },
  { slug: 'sales', name: 'Sales' },
  { slug: 'follow-up', name: 'Follow-up' },
  { slug: 'booking', name: 'Booking' },
];

const DARK = '#0f172a';
const SOFT = '#f1f5f9';
const img = (text: string, w = 640, h = 400, bg = '2563eb') => `https://placehold.co/${w}x${h}/${bg}/ffffff/png?text=${encodeURIComponent(text)}`;

function leadMagnet(): SeedTemplate {
  const b = createBuilder('lm');
  const landing = documentOf([
    b.section([
      b.heading('Free guide: 7 ways to double your email list', { level: 1, align: 'center', color: '#ffffff' }),
      b.paragraph('A practical, step-by-step playbook you can finish in one afternoon. No fluff, just what works.', { align: 'center', color: '#cbd5e1' }),
      b.spacer(8),
      b.columns([
        [b.image(img('Your guide', 480, 520), 'Cover of the free guide', { align: 'center', width: 360 })],
        [
          b.list(['The 3 pages every list-builder needs', 'Copy formulas that convert cold traffic', 'A 30-day plan you can copy', 'Bonus: 12 proven subject lines']),
          b.form({ name: 'Get the guide', fields: [field('name', 'name', 'First name', true), field('email', 'email', 'Email address', true)], submitLabel: 'Send me the guide', consent: true }),
        ],
      ]),
    ], { background: DARK, padding: 'xl', width: 'wide' }),
    b.section([
      b.heading('What readers say', { align: 'center' }),
      b.columns([
        [b.paragraph('"I added 400 subscribers in two weeks." **Maya R.**')],
        [b.paragraph('"The clearest guide I have read on the subject." **Tom B.**')],
        [b.paragraph('"Short, practical, and it worked." **Priya S.**')],
      ]),
    ], { background: SOFT, padding: 'lg', width: 'wide' }),
  ]);
  const thanks = documentOf([
    b.section([
      b.heading('Check your inbox!', { level: 1, align: 'center' }),
      b.paragraph('Your guide is on its way. If you do not see it in a few minutes, check your spam folder.', { align: 'center' }),
      b.button('Back to the homepage', { type: 'link', url: '/' }, { style: 'outline', size: 'lg', align: 'center' }),
    ], { padding: 'xl', align: 'center', width: 'narrow' }),
  ]);
  return { slug: 'lead-magnet', name: 'Lead magnet', description: 'Trade a free guide for an email address, then confirm on a thank-you page.', category: 'lead-generation', basePath: '/free-guide', steps: [{ name: 'Landing page', path: '/free-guide', doc: landing }, { name: 'Thank you', path: '/free-guide-thanks', doc: thanks }] };
}

function webinar(): SeedTemplate {
  const b = createBuilder('wb');
  const reg = documentOf([
    b.section([
      b.paragraph('**FREE LIVE TRAINING**', { align: 'center', color: '#fde68a' }),
      b.heading('How to launch your first online course in 30 days', { level: 1, align: 'center', color: '#ffffff' }),
      b.countdown({ mode: 'evergreen', minutes: 60 * 24, label: 'Next session starts in' }),
      b.spacer(16),
      b.form({ name: 'Webinar registration', fields: [field('name', 'name', 'Your name', true), field('email', 'email', 'Email', true)], submitLabel: 'Save my seat', consent: true }),
    ], { background: '#1e1b4b', padding: 'xl', width: 'narrow', align: 'center' }),
    b.section([
      b.heading('What you will learn', { align: 'center' }),
      b.list(['Pick a topic people will actually pay for', 'Outline and record your course fast', 'Set up a simple sales page', 'Get your first 10 customers']),
    ], { padding: 'lg' }),
    b.section([
      b.heading('Questions', { level: 3 }),
      b.faq([{ q: 'Will there be a replay?', a: 'Yes. Everyone who registers gets the recording.' }, { q: 'How long is it?', a: 'About 60 minutes including Q&A.' }]),
    ], { background: SOFT, padding: 'md' }),
  ]);
  const confirm = documentOf([
    b.section([
      b.heading('You are registered!', { level: 1, align: 'center' }),
      b.paragraph('We emailed you the joining link and a calendar invite. See you there.', { align: 'center' }),
      b.list(['Add the session to your calendar', 'Prepare one question to ask', 'Join five minutes early'], { icon: 'check' }),
    ], { padding: 'xl', width: 'narrow', align: 'center' }),
  ]);
  return { slug: 'webinar-registration', name: 'Webinar registration', description: 'Registration page with an evergreen countdown and a confirmation step.', category: 'events', basePath: '/webinar', steps: [{ name: 'Registration', path: '/webinar', doc: reg }, { name: 'Confirmation', path: '/webinar-confirmed', doc: confirm }] };
}

function launch(): SeedTemplate {
  const b = createBuilder('pl');
  const teaser = documentOf([
    b.section([
      b.heading('Something big is coming', { level: 1, align: 'center', color: '#ffffff' }),
      b.paragraph('Join the waitlist and get early-bird pricing before anyone else.', { align: 'center', color: '#e2e8f0' }),
      b.countdown({ mode: 'fixed', endsAt: '2030-01-01T09:00:00Z', label: 'Launch in' }),
      b.spacer(16),
      b.form({ name: 'Waitlist', fields: [field('email', 'email', 'Email', true)], submitLabel: 'Join the waitlist', consent: false, success: { type: 'message', message: 'You are on the list! We will email you at launch.' } }),
    ], { background: '#0b3b2e', padding: 'xl', width: 'narrow', align: 'center' }),
  ]);
  const page = documentOf([
    b.section([
      b.heading('Meet the all-new Aurora Pack', { level: 1, align: 'center' }),
      b.paragraph('Everything you need to ship faster, in one bundle.', { align: 'center', color: '#475569' }),
      b.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Product tour'),
      b.columns([
        [b.heading('Fast', { level: 3 }), b.paragraph('Set up in minutes, not weeks.')],
        [b.heading('Flexible', { level: 3 }), b.paragraph('Works with the tools you already use.')],
        [b.heading('Friendly', { level: 3 }), b.paragraph('Support that answers in hours.')],
      ]),
      b.checkout({ productName: 'Aurora Pack (launch price)', price: 129, description: 'Lifetime access and all future updates.', buttonLabel: 'Get the Aurora Pack' }),
    ], { padding: 'xl', width: 'wide' }),
  ]);
  const thanks = documentOf([b.section([b.heading('Welcome aboard!', { level: 1, align: 'center' }), b.paragraph('Your receipt and access details are on the way.', { align: 'center' })], { padding: 'xl', width: 'narrow', align: 'center' })]);
  return { slug: 'product-launch', name: 'Product launch', description: 'Waitlist teaser with a countdown, a launch page with video and checkout, and a thank-you page.', category: 'sales', basePath: '/launch', steps: [{ name: 'Teaser', path: '/launch', doc: teaser }, { name: 'Launch page', path: '/launch-now', doc: page }, { name: 'Thank you', path: '/launch-thanks', doc: thanks }] };
}

function salesFunnel(): SeedTemplate {
  const b = createBuilder('sf');
  const sales = documentOf([
    b.section([
      b.heading('Master email marketing in 21 days', { level: 1, align: 'center' }),
      b.paragraph('The step-by-step course used by 3,000+ small businesses.', { align: 'center', color: '#475569' }),
      b.video('https://vimeo.com/76979871', 'Course preview'),
      b.list(['21 short video lessons', 'Templates and swipe files', 'Private community access', '30-day money-back guarantee']),
    ], { padding: 'lg', width: 'medium' }),
    b.section([
      b.checkout({ productName: 'Email Marketing Masterclass', price: 97, description: 'Instant access to all lessons and templates.', buttonLabel: 'Get instant access' }),
      b.checkout({ productName: 'Done-for-you subject line pack', price: 17, orderBump: true, description: '100 proven subject lines, ready to copy.' }),
    ], { background: SOFT, padding: 'lg', width: 'narrow' }),
    b.section([
      b.heading('Frequently asked questions', { level: 2, align: 'center' }),
      b.faq([{ q: 'Is there a guarantee?', a: 'Yes, 30 days, no questions asked.' }, { q: 'How long do I get access?', a: 'Forever, including all updates.' }, { q: 'Do I need experience?', a: 'No. The course starts from zero.' }]),
    ], { padding: 'lg' }),
  ]);
  const upsell = documentOf([
    b.section([
      b.paragraph('**Wait! Your order is not complete yet.**', { align: 'center', color: '#b91c1c' }),
      b.heading('Add the 1:1 coaching call for half price', { level: 1, align: 'center' }),
      b.paragraph('Get a personal review of your first campaign. One-time offer, only on this page.', { align: 'center' }),
      b.checkout({ productName: '1:1 coaching call (45 min)', price: 97, oneClickUpsell: true, buttonLabel: 'Yes, add it to my order', description: 'We will use the payment method you just used.' }),
    ], { padding: 'xl', width: 'narrow', align: 'center' }),
  ]);
  const thanks = documentOf([
    b.section([
      b.heading('Thank you, your order is confirmed', { level: 1, align: 'center' }),
      b.paragraph('A receipt and your login details are in your inbox.', { align: 'center' }),
      b.list(['Open your welcome email', 'Log in and start lesson 1', 'Join the community'], { ordered: true }),
    ], { padding: 'xl', width: 'narrow', align: 'center' }),
  ]);
  return { slug: 'sales-page-bump-upsell', name: 'Sales page with order bump and upsell', description: 'Full sales flow: offer with an order bump, a one-click upsell, then a confirmation page.', category: 'sales', basePath: '/masterclass', steps: [{ name: 'Sales page', path: '/masterclass', doc: sales }, { name: 'One-click upsell', path: '/masterclass-upsell', doc: upsell }, { name: 'Thank you', path: '/masterclass-thanks', doc: thanks }] };
}

function thankYou(): SeedTemplate {
  const b = createBuilder('ty');
  const doc = documentOf([
    b.section([
      b.heading('Thank you!', { level: 1, align: 'center' }),
      b.paragraph('We have received your details and will be in touch shortly.', { align: 'center' }),
      b.divider(),
      b.heading('What happens next', { level: 3 }),
      b.list(['You will get a confirmation email within minutes', 'A team member reviews your request', 'We reply within one business day'], { ordered: true }),
      b.button('Follow us', { type: 'link', url: 'https://example.com', newTab: true }, { style: 'outline', align: 'center' }),
    ], { padding: 'xl', width: 'narrow', align: 'center' }),
  ]);
  return { slug: 'thank-you-page', name: 'Thank-you page', description: 'A friendly confirmation page with clear next steps.', category: 'follow-up', basePath: '/thank-you', steps: [{ name: 'Thank you', path: '/thank-you', doc }] };
}

function bookCall(): SeedTemplate {
  const b = createBuilder('bc');
  const book = documentOf([
    b.section([
      b.heading('Book your free strategy call', { level: 1, align: 'center', color: '#ffffff' }),
      b.paragraph('30 minutes. We review your funnel and give you three quick wins.', { align: 'center', color: '#cbd5e1' }),
    ], { background: DARK, padding: 'lg', width: 'narrow', align: 'center' }),
    b.section([
      b.columns([
        [b.heading('On the call', { level: 3 }), b.list(['A review of your current funnel', 'Three prioritised fixes', 'Honest advice, no pressure'])],
        [b.form({ name: 'Call request', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Work email', true), field('phone', 'phone', 'Phone (optional)'), field('topic', 'select', 'What do you need help with?', true, { options: ['More leads', 'Higher conversion', 'Sales funnel', 'Something else'] }), field('notes', 'textarea', 'Anything we should know?')], submitLabel: 'Request my call', consent: true })],
      ]),
    ], { padding: 'lg', width: 'wide' }),
  ]);
  const thanks = documentOf([b.section([b.heading('Request received', { level: 1, align: 'center' }), b.paragraph('We will email you within one business day with available times.', { align: 'center' })], { padding: 'xl', width: 'narrow', align: 'center' })]);
  return { slug: 'book-a-call', name: 'Book a call', description: 'Qualify prospects with a short form and confirm their call request.', category: 'booking', basePath: '/book', steps: [{ name: 'Booking page', path: '/book', doc: book }, { name: 'Confirmation', path: '/book-confirmed', doc: thanks }] };
}

function newsletter(): SeedTemplate {
  const b = createBuilder('nl');
  const blocks: Block[] = [
    b.section([
      b.heading('The Friday Brief', { level: 1, align: 'center' }),
      b.paragraph('One email every Friday with the five best ideas in marketing. Free, short, useful.', { align: 'center' }),
      b.form({ name: 'Newsletter', fields: [field('email', 'email', 'Email', true)], submitLabel: 'Subscribe', consent: true, success: { type: 'message', message: 'Subscribed! Check your inbox to confirm.' } }),
    ], { padding: 'xl', width: 'narrow', align: 'center' }),
  ];
  return { slug: 'newsletter-signup', name: 'Newsletter signup', description: 'A minimal single-page signup for a newsletter.', category: 'lead-generation', basePath: '/newsletter', steps: [{ name: 'Signup', path: '/newsletter', doc: documentOf(blocks) }] };
}

export const SEED_TEMPLATES: SeedTemplate[] = [leadMagnet(), webinar(), launch(), salesFunnel(), thankYou(), bookCall(), newsletter()];

/**
 * Idempotent: inserts missing categories and templates by slug, never overwrites edits made by platform admins.
 * Ids are deterministic and every insert is `ON CONFLICT DO NOTHING`, so several replicas booting at once cannot collide.
 */
export async function seedTemplates(db: Db, now = new Date()): Promise<{ inserted: number }> {
  const at = now.toISOString();
  const skip = db.dialect.onConflictDoNothing();
  return db.transaction(async (tx) => {
    let inserted = 0;
    for (const [i, c] of CATEGORIES.entries()) {
      await tx.run(`INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, ?)${skip}`, `cat_${c.slug}`, c.name, c.slug, i);
    }
    for (const t of SEED_TEMPLATES) {
      if (await tx.get('SELECT 1 FROM templates WHERE slug = ?', t.slug)) continue;
      const id = `tpl_${t.slug}`;
      const r = await tx.run(`INSERT INTO templates (id, slug, name, description, category_id, base_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)${skip}`, id, t.slug, t.name, t.description, `cat_${t.category}`, t.basePath, at, at);
      if (r.changes === 0) continue;
      for (const [i, s] of t.steps.entries()) {
        await tx.run(`INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json) VALUES (?, ?, ?, ?, ?, ?)${skip}`, `${id}_${i + 1}`, id, s.name, s.path, i + 1, JSON.stringify(s.doc));
      }
      inserted++;
    }
    return { inserted };
  });
}
