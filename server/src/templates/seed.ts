import { field } from '../blocks/defaults.js';
import type { Db } from '../db/index.js';
import { normalizeDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { createPageBuilder, type PageBuilder } from '../pagemodel/shared/build.js';
import type { GjsNode } from '../pagemodel/shared/clean.js';

/**
 * The seven starter templates, authored natively as GrapesJS project data with the page builder DSL (no conversion from block trees).
 * Every colour pairing meets WCAG AA (verified by test/pagemodel.templates.test.ts): copy inherits its colour from the section theme
 * (light, dark or accent), so nothing is dark-on-dark. Mock imagery is CSS gradients, so templates render offline and never hotlink.
 */
export interface SeedTemplate {
  slug: string;
  name: string;
  description: string;
  category: string;
  basePath: string;
  steps: { name: string; path: string; doc: ProjectDoc }[];
}

export const CATEGORIES = [
  { slug: 'lead-generation', name: 'Lead generation' },
  { slug: 'events', name: 'Events' },
  { slug: 'sales', name: 'Sales' },
  { slug: 'follow-up', name: 'Follow-up' },
  { slug: 'booking', name: 'Booking' },
];

const HERO_BLUE = 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)';
const HERO_VIOLET = 'linear-gradient(135deg,#1e1b4b 0%,#4c1d95 100%)';
const HERO_GREEN = 'linear-gradient(135deg,#052e2b 0%,#0f5132 100%)';

const finish = (pm: PageBuilder, sections: GjsNode[], o: Parameters<PageBuilder['project']>[1] = {}): ProjectDoc => {
  const r = normalizeDoc({ version: 2, project: pm.project(sections, o) }, { scriptsOk: true });
  if (!r.ok) throw new Error(`Invalid seed template: ${JSON.stringify(r.issues)}`);
  return r.doc;
};

const avatar = (pm: PageBuilder, initials: string, bg = '#c7d2fe', fg = '#1e1b4b') =>
  pm.box([pm.text(initials, { align: 'center' })], { name: 'Avatar', style: { width: '44px', height: '44px', 'border-radius': '50%', background: bg, color: fg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '700', 'flex-shrink': '0' } });

function testimonial(pm: PageBuilder, quote: string, name: string, role: string, initials: string): GjsNode {
  return pm.card([
    pm.text(`“${quote}”`, { name: 'Quote' }),
    pm.box([avatar(pm, initials), pm.box([pm.text(`**${name}**`, {}), pm.text(role, { muted: true, size: '.9rem' })], { name: 'Person' })], { name: 'Person', style: { display: 'flex', 'align-items': 'center', gap: '12px' } }),
  ], { name: 'Testimonial' });
}

function feature(pm: PageBuilder, num: string, title: string, body: string): GjsNode {
  return pm.card([
    pm.box([pm.text(num, { align: 'center' })], { name: 'Badge', style: { width: '40px', height: '40px', 'border-radius': '12px', background: '#dbeafe', color: '#1e3a8a', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(title, { level: 3 }),
    pm.text(body, { muted: true }),
  ], { name: 'Feature' });
}

const footer = (pm: PageBuilder, brand = 'Your Company') => pm.footer(`© ${brand}. All rights reserved.`, [{ label: 'Privacy', href: '#' }, { label: 'Terms', href: '#' }, { label: 'Contact', href: '#' }]);

function leadMagnet(): SeedTemplate {
  const pm = createPageBuilder('lm');
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Free guide'),
          pm.heading('7 ways to double your email list in 30 days', { level: 1 }),
          pm.text('A practical, step-by-step playbook you can finish in one afternoon. No fluff, just what works.', { muted: true, size: '1.15rem' }),
          pm.list(['The 3 pages every list-builder needs', 'Copy formulas that convert cold traffic', 'A 30-day plan you can copy', 'Bonus: 12 proven subject lines']),
        ], { grow: 1 }),
        pm.col([
          pm.form('lm-form', {
            name: 'Get the guide',
            fields: [field('name', 'name', 'First name', true), field('email', 'email', 'Email address', true)],
            submitLabel: 'Send me the free guide',
            consent: { enabled: true, text: 'I agree to receive emails and can unsubscribe at any time.' },
          }),
          pm.text('No spam. Unsubscribe in one click.', { align: 'center', muted: true, size: '.85rem' }),
        ], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO_BLUE, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow("What's inside", { align: 'center' }), pm.heading('Everything you need to grow your list', { align: 'center' })]),
      pm.cols([[feature(pm, '1', 'Build', 'Set up a high-converting opt-in page in under an hour.')], [feature(pm, '2', 'Attract', 'Drive qualified traffic with three simple, repeatable tactics.')], [feature(pm, '3', 'Nurture', 'Turn subscribers into buyers with a short welcome sequence.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Loved by marketers and founders', { align: 'center' })]),
      pm.cols([
        [testimonial(pm, 'I added 400 subscribers in two weeks.', 'Maya Reed', 'Founder, Brightline', 'MR')],
        [testimonial(pm, 'The clearest guide I have read on the subject.', 'Tom Becker', 'Marketing lead', 'TB')],
        [testimonial(pm, 'Short, practical, and it worked on day one.', 'Priya Shah', 'Consultant', 'PS')],
      ]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([pm.stack([pm.heading('Ready to grow your list?', { align: 'center', level: 2 }), pm.text('Get the free guide in your inbox in under a minute.', { align: 'center' }), pm.button('Get the free guide', { type: 'anchor', anchor: 'top' }, { variant: 'secondary', size: 'lg', align: 'center' })])], { theme: 'accent', padding: 'lg', width: 'medium', align: 'center' }),
    footer(pm),
  ]);
  const pm2 = createPageBuilder('lt');
  const thanks = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.eyebrow('Almost there', { align: 'center' }),
        pm2.heading('Check your inbox!', { level: 1, align: 'center' }),
        pm2.text('Your guide is on its way. If you do not see it in a few minutes, check your spam folder.', { align: 'center', muted: true }),
        pm2.button('Back to the homepage', { type: 'link', url: '/' }, { variant: 'outline', size: 'lg', align: 'center' }),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
  ]);
  return { slug: 'lead-magnet', name: 'Lead magnet', description: 'Trade a free guide for an email address, then confirm on a thank-you page.', category: 'lead-generation', basePath: '/free-guide', steps: [{ name: 'Landing page', path: '/free-guide', doc: landing }, { name: 'Thank you', path: '/free-guide-thanks', doc: thanks }] };
}

function webinar(): SeedTemplate {
  const pm = createPageBuilder('wb');
  const reg = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Free live training', { align: 'center' }),
        pm.heading('How to launch your first online course in 30 days', { level: 1, align: 'center' }),
        pm.text('Join us live and walk away with a complete launch plan.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.countdown({ mode: 'evergreen', minutes: 60 * 24, label: 'Next session starts in' }),
        pm.form('wb-form', { name: 'Webinar registration', fields: [field('name', 'name', 'Your name', true), field('email', 'email', 'Email', true)], submitLabel: 'Save my seat', consent: { enabled: true, text: 'I agree to receive the joining link and reminders by email.' } }),
      ]),
    ], { theme: 'dark', background: HERO_VIOLET, padding: 'xl', width: 'small', align: 'center' }),
    pm.section([
      pm.stack([pm.heading('What you will learn', { align: 'center' })]),
      pm.cols([
        [feature(pm, '1', 'Pick your topic', 'Choose a subject people will actually pay for.')],
        [feature(pm, '2', 'Build it fast', 'Outline and record your course in a weekend.')],
        [feature(pm, '3', 'Get your first 10 customers', 'A simple sales page and a launch checklist.')],
      ]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([avatar(pm, 'AL', '#ddd6fe', '#3b0764')], { grow: 0, style: { 'flex-basis': '64px' } }),
        pm.col([pm.heading('Your host: Alex Lin', { level: 3 }), pm.text('Alex has helped more than 2,000 creators launch their first course. Expect practical examples, not theory.', { muted: true })]),
      ], { valign: 'center', keep: true }),
    ], { theme: 'soft', padding: 'md', width: 'small' }),
    pm.section([pm.stack([pm.heading('Questions', { align: 'center', level: 2 }), pm.faq([{ q: 'Will there be a replay?', a: 'Yes. Everyone who registers gets the recording.' }, { q: 'How long is it?', a: 'About 60 minutes including Q&A.' }, { q: 'Is it really free?', a: 'Yes. There is nothing to buy to attend.' }])])], { padding: 'lg', width: 'small' }),
    footer(pm),
  ]);
  const pm2 = createPageBuilder('wc');
  const confirm = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.eyebrow('Seat reserved', { align: 'center' }),
        pm2.heading('You are registered!', { level: 1, align: 'center' }),
        pm2.text('We emailed you the joining link and a calendar invite. See you there.', { align: 'center', muted: true }),
        pm2.list(['Add the session to your calendar', 'Prepare one question to ask', 'Join five minutes early']),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
  ]);
  return { slug: 'webinar-registration', name: 'Webinar registration', description: 'Registration page with an evergreen countdown and a confirmation step.', category: 'events', basePath: '/webinar', steps: [{ name: 'Registration', path: '/webinar', doc: reg }, { name: 'Confirmation', path: '/webinar-confirmed', doc: confirm }] };
}

function launch(): SeedTemplate {
  const pm = createPageBuilder('pl');
  const teaser = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Launching soon', { align: 'center' }),
        pm.heading('Something big is coming', { level: 1, align: 'center' }),
        pm.text('Join the waitlist and get early-bird pricing before anyone else.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.countdown({ mode: 'fixed', endsAt: '2030-01-01T09:00:00Z', label: 'Launch in' }),
        pm.form('pl-wait', { name: 'Waitlist', fields: [field('email', 'email', 'Email', true)], submitLabel: 'Join the waitlist', success: { type: 'message', message: 'You are on the list! We will email you at launch.' } }),
      ]),
    ], { theme: 'dark', background: HERO_GREEN, padding: 'xl', width: 'small', align: 'center' }),
  ]);
  const pm2 = createPageBuilder('pm');
  const page = finish(pm2, [
    pm2.section([pm2.stack([pm2.eyebrow('New', { align: 'center' }), pm2.heading('Meet the all-new Aurora Pack', { level: 1, align: 'center' }), pm2.text('Everything you need to ship faster, in one bundle.', { align: 'center', muted: true, size: '1.15rem' }), pm2.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Product tour')])], { padding: 'xl', width: 'medium', align: 'center' }),
    pm2.section([
      pm2.cols([[feature(pm2, '⚡', 'Fast', 'Set up in minutes, not weeks.')], [feature(pm2, '🔧', 'Flexible', 'Works with the tools you already use.')], [feature(pm2, '💬', 'Friendly', 'Support that answers in hours.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm2.section([
      pm2.row([
        pm2.col([pm2.heading('Get the Aurora Pack', { level: 2 }), pm2.text('One payment, lifetime access and every future update.', { muted: true }), pm2.list(['All templates and components', 'Private community', '30-day money-back guarantee'])]),
        pm2.col([pm2.checkout('pm-main', { productName: 'Aurora Pack (launch price)', price: 129, description: 'Lifetime access and all future updates.', buttonLabel: 'Get the Aurora Pack' })]),
      ], { valign: 'center', gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    pm2.section([pm2.stack([pm2.heading('Questions', { align: 'center' }), pm2.faq([{ q: 'Is there a refund?', a: 'Yes, within 30 days, no questions asked.' }, { q: 'Do I get updates?', a: 'Yes. Every future update is included.' }])])], { theme: 'soft', padding: 'lg', width: 'small' }),
    footer(pm2, 'Aurora'),
  ]);
  const pm3 = createPageBuilder('pt');
  const thanks = finish(pm3, [pm3.section([pm3.stack([pm3.heading('Welcome aboard!', { level: 1, align: 'center' }), pm3.text('Your receipt and access details are on the way.', { align: 'center', muted: true })])], { padding: 'xl', width: 'small', align: 'center' })]);
  return { slug: 'product-launch', name: 'Product launch', description: 'Waitlist teaser with a countdown, a launch page with video and checkout, and a thank-you page.', category: 'sales', basePath: '/launch', steps: [{ name: 'Teaser', path: '/launch', doc: teaser }, { name: 'Launch page', path: '/launch-now', doc: page }, { name: 'Thank you', path: '/launch-thanks', doc: thanks }] };
}

function salesFunnel(): SeedTemplate {
  const pm = createPageBuilder('sf');
  const sales = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Online course', { align: 'center' }),
        pm.heading('Master email marketing in 21 days', { level: 1, align: 'center' }),
        pm.text('The step-by-step course used by 3,000+ small businesses.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.video('https://vimeo.com/76979871', 'Course preview'),
      ]),
    ], { theme: 'dark', background: HERO_BLUE, padding: 'xl', width: 'medium', align: 'center' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('What you get', { level: 2 }), pm.list(['21 short video lessons', 'Templates and swipe files', 'Private community access', '30-day money-back guarantee'])]),
        pm.col([
          pm.checkout('sf-main', { productName: 'Email Marketing Masterclass', price: 97, description: 'Instant access to all lessons and templates.', buttonLabel: 'Get instant access' }),
          pm.checkout('sf-bump', { productName: 'Done-for-you subject line pack', price: 17, orderBump: true, description: '100 proven subject lines, ready to copy.' }),
        ]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([pm.stack([pm.heading('Frequently asked questions', { level: 2, align: 'center' }), pm.faq([{ q: 'Is there a guarantee?', a: 'Yes, 30 days, no questions asked.' }, { q: 'How long do I get access?', a: 'Forever, including all updates.' }, { q: 'Do I need experience?', a: 'No. The course starts from zero.' }])])], { theme: 'soft', padding: 'lg', width: 'small' }),
    footer(pm),
  ]);
  const pm2 = createPageBuilder('su');
  const upsell = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.badgeText('Wait! Your order is not complete yet'),
        pm2.heading('Add the 1:1 coaching call for half price', { level: 1, align: 'center' }),
        pm2.text('Get a personal review of your first campaign. One-time offer, only on this page.', { align: 'center', muted: true }),
        pm2.checkout('su-up', { productName: '1:1 coaching call (45 min)', price: 97, oneClickUpsell: true, buttonLabel: 'Yes, add it to my order', description: 'We will use the payment method you just used.' }),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
  ]);
  const pm3 = createPageBuilder('st');
  const thanks = finish(pm3, [
    pm3.section([
      pm3.stack([
        pm3.heading('Thank you, your order is confirmed', { level: 1, align: 'center' }),
        pm3.text('A receipt and your login details are in your inbox.', { align: 'center', muted: true }),
        pm3.list(['Open your welcome email', 'Log in and start lesson 1', 'Join the community'], { ordered: true }),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
  ]);
  return { slug: 'sales-page-bump-upsell', name: 'Sales page with order bump and upsell', description: 'Full sales flow: offer with an order bump, a one-click upsell, then a confirmation page.', category: 'sales', basePath: '/masterclass', steps: [{ name: 'Sales page', path: '/masterclass', doc: sales }, { name: 'One-click upsell', path: '/masterclass-upsell', doc: upsell }, { name: 'Thank you', path: '/masterclass-thanks', doc: thanks }] };
}

function thankYou(): SeedTemplate {
  const pm = createPageBuilder('ty');
  const doc = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('All done', { align: 'center' }),
        pm.heading('Thank you!', { level: 1, align: 'center' }),
        pm.text('We have received your details and will be in touch shortly.', { align: 'center', muted: true }),
        pm.divider(),
        pm.heading('What happens next', { level: 3 }),
        pm.list(['You will get a confirmation email within minutes', 'A team member reviews your request', 'We reply within one business day'], { ordered: true }),
        pm.button('Follow us', { type: 'link', url: 'https://example.com', newTab: true }, { variant: 'outline', align: 'center' }),
      ]),
    ], { padding: 'xl', width: 'small' }),
  ]);
  return { slug: 'thank-you-page', name: 'Thank-you page', description: 'A friendly confirmation page with clear next steps.', category: 'follow-up', basePath: '/thank-you', steps: [{ name: 'Thank you', path: '/thank-you', doc }] };
}

function bookCall(): SeedTemplate {
  const pm = createPageBuilder('bc');
  const book = finish(pm, [
    pm.section([pm.stack([pm.eyebrow('Free strategy call', { align: 'center' }), pm.heading('Book your free strategy call', { level: 1, align: 'center' }), pm.text('30 minutes. We review your funnel and give you three quick wins.', { align: 'center', muted: true, size: '1.15rem' })])], { theme: 'dark', background: HERO_BLUE, padding: 'lg', width: 'small', align: 'center' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('On the call', { level: 3 }), pm.list(['A review of your current funnel', 'Three prioritised fixes', 'Honest advice, no pressure']), testimonial(pm, 'One call and we fixed a leak that had cost us leads for months.', 'Dana Cole', 'Owner, Cole & Co', 'DC')]),
        pm.col([pm.form('bc-form', { name: 'Call request', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Work email', true), field('phone', 'phone', 'Phone (optional)'), field('topic', 'select', 'What do you need help with?', true, { options: ['More leads', 'Higher conversion', 'Sales funnel', 'Something else'] }), field('notes', 'textarea', 'Anything we should know?')], submitLabel: 'Request my call', consent: { enabled: true, text: 'I agree to be contacted about my request.' } })]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    footer(pm),
  ]);
  const pm2 = createPageBuilder('bt');
  const thanks = finish(pm2, [pm2.section([pm2.stack([pm2.heading('Request received', { level: 1, align: 'center' }), pm2.text('We will email you within one business day with available times.', { align: 'center', muted: true })])], { padding: 'xl', width: 'small', align: 'center' })]);
  return { slug: 'book-a-call', name: 'Book a call', description: 'Qualify prospects with a short form and confirm their call request.', category: 'booking', basePath: '/book', steps: [{ name: 'Booking page', path: '/book', doc: book }, { name: 'Confirmation', path: '/book-confirmed', doc: thanks }] };
}

function newsletter(): SeedTemplate {
  const pm = createPageBuilder('nl');
  const doc = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Weekly newsletter', { align: 'center' }),
        pm.heading('The Friday Brief', { level: 1, align: 'center' }),
        pm.text('One email every Friday with the five best ideas in marketing. Free, short, useful.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.form('nl-form', { name: 'Newsletter', fields: [field('email', 'email', 'Email', true)], submitLabel: 'Subscribe', consent: { enabled: true, text: 'I agree to receive the newsletter.' }, success: { type: 'message', message: 'Subscribed! Check your inbox to confirm.' } }),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
    pm.section([pm.cols([[feature(pm, '5', 'Five ideas', 'Hand-picked and easy to try the same day.')], [feature(pm, '3', 'Three minutes', 'Short enough to read with your coffee.')], [feature(pm, '0', 'Zero spam', 'Unsubscribe any time in one click.')]])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm, 'The Friday Brief'),
  ]);
  return { slug: 'newsletter-signup', name: 'Newsletter signup', description: 'A minimal single-page signup for a newsletter.', category: 'lead-generation', basePath: '/newsletter', steps: [{ name: 'Signup', path: '/newsletter', doc }] };
}

export const SEED_TEMPLATES: SeedTemplate[] = [leadMagnet(), webinar(), launch(), salesFunnel(), thankYou(), bookCall(), newsletter()];

/**
 * Idempotent: inserts missing categories and templates by slug. A seeded template whose steps are still stored as legacy block documents
 * (version 1) is upgraded to the native version-2 content; everything else (including templates platform administrators created) is left alone.
 * Ids are deterministic and every insert is `ON CONFLICT DO NOTHING`, so several replicas booting at once cannot collide.
 */
export async function seedTemplates(db: Db, now = new Date()): Promise<{ inserted: number; upgraded: number }> {
  const at = now.toISOString();
  const skip = db.dialect.onConflictDoNothing();
  return db.transaction(async (tx) => {
    let inserted = 0;
    let upgraded = 0;
    for (const [i, c] of CATEGORIES.entries()) {
      await tx.run(`INSERT INTO template_categories (id, name, slug, position) VALUES (?, ?, ?, ?)${skip}`, `cat_${c.slug}`, c.name, c.slug, i);
    }
    for (const t of SEED_TEMPLATES) {
      const id = `tpl_${t.slug}`;
      if (await tx.get('SELECT 1 FROM templates WHERE slug = ?', t.slug)) {
        for (const [i, s] of t.steps.entries()) {
          const row = await tx.get<{ doc_json: string }>('SELECT doc_json FROM template_steps WHERE id = ?', `${id}_${i + 1}`);
          if (row && !/^\s*\{\s*"version"\s*:\s*2\b/.test(row.doc_json)) {
            await tx.run('UPDATE template_steps SET doc_json = ?, name = ? WHERE id = ?', JSON.stringify(s.doc), s.name, `${id}_${i + 1}`);
            upgraded++;
          }
        }
        continue;
      }
      const r = await tx.run(`INSERT INTO templates (id, slug, name, description, category_id, base_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)${skip}`, id, t.slug, t.name, t.description, `cat_${t.category}`, t.basePath, at, at);
      if (r.changes === 0) continue;
      for (const [i, s] of t.steps.entries()) {
        await tx.run(`INSERT INTO template_steps (id, template_id, name, base_path, position, doc_json) VALUES (?, ?, ?, ?, ?, ?)${skip}`, `${id}_${i + 1}`, id, s.name, s.path, i + 1, JSON.stringify(s.doc));
      }
      inserted++;
    }
    return { inserted, upgraded };
  });
}
