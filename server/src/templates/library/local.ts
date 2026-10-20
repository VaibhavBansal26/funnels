import {
  browserMock, chartMock, createPageBuilder, discs, faqSection, feature, field, finish, footer, HERO, iconBadge, logoStrip, nav, PASTEL, ringMock, statsRow,
  testimonial, thanksSection, type GjsNode, type PageBuilder,
} from '../kit.js';
import type { TemplateDef } from '../types.js';

/**
 * Local businesses (dentist, gym, restaurant or bakery, real estate, home services), an application funnel and an agency lead-gen funnel. All are
 * form funnels (no checkout): a landing page with one clear request form, then a confirmation that says what happens next.
 */

const consent = (text: string) => ({ enabled: true, text });

/** A row of small trust marks ("Licensed", "4.9 rating"...). */
const trustRow = (pm: PageBuilder, items: string[], bg: string = PASTEL.slate) =>
  pm.box(items.map((t) => pm.text(t, { align: 'center', style: { background: bg, color: '#0f172a', padding: '8px 14px', 'border-radius': '999px', 'font-weight': '600', 'font-size': '.9rem' } })), { name: 'Trust marks', style: { display: 'flex', 'flex-wrap': 'wrap', gap: '10px' } });

/** Numbered steps; the number's colour is set on the text itself (the contrast audit reads explicit colours per element). */
const stepsRow = (pm: PageBuilder, accent: string, items: { title: string; body: string }[]): GjsNode =>
  pm.cols(items.map((it, i) => [pm.box([
    pm.box([pm.text(String(i + 1), { align: 'center', color: '#ffffff' })], { name: 'Step number', style: { width: '44px', height: '44px', 'border-radius': '50%', background: accent, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(it.title, { level: 3 }), pm.text(it.body, { muted: true }),
  ], { name: 'Step', style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } })]));

const badge = (pm: PageBuilder, glyph: string, bg: string, fg: string) => iconBadge(pm, glyph, bg as typeof PASTEL.blue, fg);

const infoCard = (pm: PageBuilder, glyph: string, title: string, lines: string[], bg: string, fg: string) =>
  pm.card([badge(pm, glyph, bg, fg), pm.heading(title, { level: 3 }), ...lines.map((l) => pm.text(l, { muted: true }))], { name: title });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function dentist(): TemplateDef {
  const accent = '#0f766e';
  const pm = createPageBuilder('dn');
  const landing = finish(pm, [
    nav(pm, 'Brightside Dental', [['Services', '#services'], ['Hours', '#visit']], ['Book a visit', { type: 'anchor', anchor: 'book' }]),
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('New patients welcome'),
          pm.heading('Gentle dental care for the whole family', { level: 1 }),
          pm.text('Check-up, X-rays and a professional clean for **$99** for new patients. Same-week appointments, clear pricing and a dentist who explains every step.', { muted: true, size: '1.15rem' }),
          trustRow(pm, ['Rated 4.9 by 1,200 patients', 'Open Saturdays', 'Anxious patients welcome'], '#ccfbf1'),
          pm.button('Request an appointment', { type: 'anchor', anchor: 'book' }, { size: 'lg' }),
        ], { grow: 1 }),
        pm.col([discs(pm, ['#5eead4', '#99f6e4', '#bae6fd'], '300px')], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'soft', padding: 'xl', width: 'wide', background: '#f0fdfa' }),
    pm.section([
      pm.stack([pm.eyebrow('What we do', { align: 'center' }), pm.heading('Everything under one roof', { align: 'center' })]),
      pm.cols([
        [infoCard(pm, '✓', 'Check-ups and cleans', ['Thorough exam, digital X-rays and a scale and polish every six months.'], '#ccfbf1', '#134e4a')],
        [infoCard(pm, '★', 'Whitening', ['Professional whitening in one 60-minute visit, up to eight shades brighter.'], '#fef3c7', '#78350f')],
        [infoCard(pm, '♥', 'Fillings and crowns', ['Tooth-coloured fillings and same-day crowns so you leave with a finished smile.'], '#ffe4e6', '#881337')],
        [infoCard(pm, '☺', 'Kids and teens', ['Friendly first visits, sealants and mouthguards for growing smiles.'], '#dbeafe', '#1e3a8a')],
      ], { gap: 'sm' }),
    ], { id: 'services', anchor: 'services', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.eyebrow('Visit us'), pm.heading('Opening hours and location', { level: 2 }), pm.list(['Monday to Friday: 8:00 to 18:00', 'Saturday: 9:00 to 14:00', '12 Linden Street, next to the library', 'Free parking behind the building'])], { grow: 1 }),
        pm.col([testimonial(pm, 'I had avoided the dentist for years. Dr. Okafor made it easy, and I was in and out in 40 minutes.', 'Rita Alvarez', 'Patient since 2022', 'RA')], { grow: 1 }),
      ], { gap: 'lg', valign: 'center' }),
    ], { anchor: 'visit', theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Book your first visit', { level: 2 }), pm.text('Tell us when suits you and we will call to confirm within one working day. Emergency? Call the practice and we will fit you in.', { muted: true }), pm.list(['No obligation, no hidden fees', 'We handle your insurance paperwork', 'Reminder by text the day before'])], { grow: 1 }),
        pm.col([pm.form('dn-form', {
          name: 'Appointment request',
          fields: [field('name', 'name', 'Full name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone', true), field('reason', 'select', 'Reason for your visit', true, { options: ['Check-up and clean', 'Toothache or emergency', 'Whitening', 'Fillings or crowns', 'Child appointment', 'Something else'] }), field('when', 'select', 'Preferred time', false, { options: ['Weekday morning', 'Weekday afternoon', 'Saturday'] })],
          submitLabel: 'Request appointment', consent: consent('I agree to be contacted about my appointment.'),
        })], { grow: 1 }),
      ], { gap: 'lg' }),
    ], { anchor: 'book', padding: 'lg', width: 'wide' }),
    footer(pm, 'Brightside Dental'),
  ], { accent });
  const pm2 = createPageBuilder('dt');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'Request received', title: 'Thank you, we will call you shortly', text: 'A member of our team will confirm your appointment within one working day.', bullets: ['We call or text to agree a time', 'You get a reminder the day before', 'Bring your insurance card and a list of any medication'] })], { accent });
  return { slug: 'local-dentist', version: 1, name: 'Dentist appointment', description: 'A calm, trustworthy page for a dental practice: new-patient offer, services, opening hours and an appointment request form.', category: 'local-services', industry: 'dental', goal: 'booking', tags: ['dentist', 'dental', 'appointment', 'new patients', 'local business'], basePath: '/book-a-dentist', accent, products: [], steps: [{ name: 'Landing page', path: '/book-a-dentist', kind: 'landing', doc: landing }, { name: 'Request received', path: '/appointment-requested', kind: 'thankyou', doc: thanks }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function gym(): TemplateDef {
  const accent = '#b45309';
  const pm = createPageBuilder('gy');
  const klass = (time: string, name: string, coach: string) => pm.card([pm.text(`**${time}**`, { style: { 'font-size': '1.3rem' } }), pm.heading(name, { level: 3 }), pm.text(coach, { muted: true })], { name });
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Ironworks Fitness'),
          pm.heading('Your first 7 days are on us', { level: 1 }),
          pm.text('Unlimited classes, the full gym floor and a free coaching session. No contract, no joining fee, no pressure.', { muted: true, size: '1.15rem' }),
          pm.list(['40 classes a week, all levels', 'Open 5:00 to 23:00 every day', 'Showers, towels and lockers included']),
        ], { grow: 1 }),
        pm.col([pm.form('gy-form', {
          name: 'Free pass', fields: [field('name', 'name', 'First name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Mobile (optional)'), field('goal', 'select', 'Your main goal', true, { options: ['Lose weight', 'Build strength', 'Improve fitness', 'Try classes', 'Just getting started'] })],
          submitLabel: 'Claim my free week', consent: consent('Send me my pass and the occasional offer. I can opt out any time.'),
        })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.slate, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow('This week', { align: 'center' }), pm.heading('Classes for every level', { align: 'center' })]),
      pm.cols([[klass(' 06:00', 'Strength basics', 'with Dana, 45 min')], [klass('12:15', 'Lunchtime HIIT', 'with Marcus, 30 min')], [klass('18:30', 'Spin and sweat', 'with Priya, 45 min')], [klass('19:30', 'Yoga flow', 'with Leo, 60 min')]], { gap: 'sm' }),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Simple memberships', { align: 'center' }), pm.text('Cancel any time with 30 days notice.', { align: 'center', muted: true })]),
      pm.cols([
        [pm.card([pm.heading('Off-peak', { level: 3 }), pm.text('**$29** a month', { style: { 'font-size': '2rem' } }), pm.list(['Gym floor 9:00 to 16:00', 'All classes before 16:00'])])],
        [pm.card([pm.badgeText('Most popular'), pm.heading('Anytime', { level: 3 }), pm.text('**$49** a month', { style: { 'font-size': '2rem' } }), pm.list(['Open 5:00 to 23:00', 'Every class', 'One coaching session a month'])], { featured: true })],
        [pm.card([pm.heading('Duo', { level: 3 }), pm.text('**$85** a month', { style: { 'font-size': '2rem' } }), pm.list(['Two Anytime memberships', 'Bring a friend free on Sundays'])])],
      ], { gap: 'sm' }),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([pm.stack([pm.heading('Members say it best', { align: 'center' }), testimonial(pm, 'Down 9 kilos in four months, and I actually look forward to Tuesday strength class.', 'Chris Dobbs', 'Member for 14 months', 'CD')])], { padding: 'lg', width: 'small' }),
    footer(pm, 'Ironworks Fitness'),
  ], { accent });
  const pm2 = createPageBuilder('gt');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'You are in', title: 'Your free pass is on its way', text: 'Check your inbox for the pass and a link to book your first class.', bullets: ['Show the pass at reception', 'Book a class from the schedule link', 'Wear trainers and bring water'] })], { accent });
  return { slug: 'local-gym', version: 1, name: 'Gym free trial', description: 'A bold gym page that trades a free 7-day pass for a name and email: class schedule, simple membership plans and a member story.', category: 'local-services', industry: 'fitness', goal: 'leads', tags: ['gym', 'fitness', 'free trial', 'classes', 'membership'], basePath: '/free-week', accent, products: [], steps: [{ name: 'Landing page', path: '/free-week', kind: 'landing', doc: landing }, { name: 'Pass on its way', path: '/free-week-confirmed', kind: 'thankyou', doc: thanks }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function bakery(): TemplateDef {
  const accent = '#9f1239';
  const pm = createPageBuilder('bk');
  const dish = (name: string, price: string, text: string) => pm.box([pm.box([pm.text(`**${name}**`), pm.text(price, { style: { 'font-weight': '700' } })], { name: 'Item', style: { display: 'flex', 'justify-content': 'space-between', gap: '12px' } }), pm.text(text, { muted: true, size: '.95rem' })], { name: name, style: { 'padding-bottom': '14px', 'border-bottom': '1px dashed #cbd5e1' } });
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Fresh from the oven since 2009'),
          pm.heading('Hearth & Crumb bakery and kitchen', { level: 1 }),
          pm.text('Sourdough, pastries and seasonal plates made from scratch every morning. Reserve a table, or pre-order a celebration cake.', { muted: true, size: '1.15rem' }),
          pm.button('Reserve or pre-order', { type: 'anchor', anchor: 'reserve' }, { size: 'lg' }),
        ], { grow: 1 }),
        pm.col([pm.box([pm.box([], { name: 'Loaf', style: { width: '170px', height: '110px', 'border-radius': '90px 90px 40px 40px', background: 'linear-gradient(180deg,#d97706,#92400e)' } }), pm.box([], { name: 'Plate', style: { width: '230px', height: '24px', 'border-radius': '50%', background: '#fde68a', 'margin-top': '-8px' } })], { name: 'Illustration', style: { display: 'flex', 'flex-direction': 'column', 'align-items': 'center', padding: '50px 20px', 'border-radius': '24px', background: '#ffe4e6' } })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { background: '#fff7ed', theme: 'soft', padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Today on the counter', { align: 'center' }), pm.tabs([
        { label: 'Bakery', children: [dish('Country sourdough', '$7', 'Slow-fermented for 36 hours, crisp crust and open crumb.'), dish('Almond croissant', '$4.50', 'Twice-baked with frangipane and toasted flakes.'), dish('Cardamom bun', '$4', 'Soft, sticky and not too sweet.')] },
        { label: 'Brunch', children: [dish('Eggs on toast', '$13', 'Two soft eggs, whipped ricotta, chilli oil, sourdough.'), dish('Shakshuka', '$15', 'Spiced tomato, peppers, feta and warm flatbread.'), dish('Granola bowl', '$11', 'House granola, yoghurt and roasted fruit.')] },
        { label: 'Cakes', children: [dish('Lemon and thyme loaf', 'from $38', 'Serves 8 to 10. Order 48 hours ahead.'), dish('Chocolate layer cake', 'from $55', 'Three layers, salted caramel, serves 12.'), dish('Custom celebration cake', 'from $75', 'Tell us the occasion and we will design it.')] },
      ])]),
    ], { padding: 'lg', width: 'small' }),
    pm.section([
      pm.cols([[feature(pm, '1', 'Baked daily', 'Everything leaves the oven the morning you eat it.')], [feature(pm, '2', 'Local flour and eggs', 'We buy from three farms within 40 km.')], [feature(pm, '3', 'Allergy aware', 'Vegan and gluten-free options every day. Just ask.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Reserve a table or pre-order', { level: 2 }), pm.text('Tables for up to eight. For cakes, order at least two days ahead and we will confirm the design and price by email.', { muted: true }), pm.list(['Open Tuesday to Sunday, 7:30 to 15:00', 'Walk-ins welcome, reservations held 15 minutes', '48 Mill Lane, behind the market'])], { grow: 1 }),
        pm.col([pm.form('bk-form', {
          name: 'Reservation or pre-order', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone'), field('type', 'select', 'I would like to', true, { options: ['Reserve a table', 'Pre-order a cake', 'Order for a party'] }), field('guests', 'select', 'Guests or servings', true, { options: ['1 to 2', '3 to 4', '5 to 8', '9 to 12', 'More than 12'] }), field('date', 'text', 'Preferred date and time', true), field('notes', 'textarea', 'Allergies or notes')],
          submitLabel: 'Send request',
        })], { grow: 1 }),
      ], { gap: 'lg' }),
    ], { anchor: 'reserve', padding: 'lg', width: 'wide' }),
    footer(pm, 'Hearth & Crumb'),
  ], { accent, font: 'Serif' });
  const pm2 = createPageBuilder('bt');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'Request received', title: 'We will see you soon', text: 'We will confirm your table or cake by email within a few hours (we are baking until noon).', bullets: ['Check your inbox for our confirmation', 'Tell us early about any allergies', 'Cake pick-up is from 8:00 on the day'] })], { accent, font: 'Serif' });
  return { slug: 'local-restaurant-bakery', version: 1, name: 'Restaurant or bakery', description: 'A warm, appetising page for a bakery or café: menu highlights in tabs, a reservation and cake pre-order form, and opening hours.', category: 'local-services', industry: 'food', goal: 'booking', tags: ['restaurant', 'bakery', 'reservation', 'menu', 'cake pre-order'], basePath: '/reserve', accent, products: [], steps: [{ name: 'Landing page', path: '/reserve', kind: 'landing', doc: landing }, { name: 'Confirmed', path: '/reservation-received', kind: 'thankyou', doc: thanks }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function realEstate(): TemplateDef {
  const accent = '#1e3a8a';
  const pm = createPageBuilder('re');
  const landing = finish(pm, [
    nav(pm, 'Harbor & Pine Realty', [['Market', '#market'], ['Your agent', '#agent']], ['Get my valuation', { type: 'anchor', anchor: 'value' }]),
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Free home valuation'),
          pm.heading('What is your home worth today?', { level: 1 }),
          pm.text('Get a data-backed estimate from a local agent within 24 hours. No obligation, and we never share your address.', { muted: true, size: '1.15rem' }),
          pm.list(['Based on recent sales on your street', 'Reviewed by an agent, not an algorithm', 'Includes advice on what adds value']),
        ], { grow: 1 }),
        pm.col([pm.form('re-form', {
          name: 'Home valuation', fields: [field('address', 'text', 'Property address', true), field('name', 'name', 'Your name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone'), field('timeline', 'select', 'When are you thinking of selling?', true, { options: ['As soon as possible', 'In 1 to 3 months', 'In 3 to 6 months', 'Just curious'] })],
          submitLabel: 'Get my valuation', consent: consent('I agree to be contacted about my valuation.'),
        })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { anchor: 'value', theme: 'dark', background: HERO.indigo, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow('Local market', { align: 'center' }), pm.heading('Homes are selling fast in your area', { align: 'center' })]),
      statsRow(pm, [['14 days', 'average time on market'], ['101.8%', 'of asking price achieved'], ['312', 'homes sold last year'], ['+6.4%', 'price growth in 12 months']]),
      pm.row([pm.col([chartMock(pm, [38, 44, 47, 55, 61, 72, 86], accent)], { grow: 1 }), pm.col([pm.text('Median sale price has climbed steadily for seven quarters. Homes that are priced right in the first week sell for more, in less time.', { muted: true })], { grow: 1 })], { valign: 'center', gap: 'lg' }),
    ], { anchor: 'market', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([discs(pm, ['#93c5fd', '#c7d2fe', '#bfdbfe'], '220px')], { grow: 1 }),
        pm.col([pm.eyebrow('Your agent'), pm.heading('Meet Elena Marsh', { level: 2 }), pm.text('Elena has sold more than 280 homes in this neighbourhood over 12 years. She lives two streets from the park, answers her own phone and will tell you honestly what your home is worth.', { muted: true }), testimonial(pm, 'She sold in nine days, above asking. I would not use anyone else.', 'The Okoro family', 'Sold in Maple Heights', 'OF')], { grow: 2 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { anchor: 'agent', theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm, 'Harbor & Pine Realty'),
  ], { accent });
  const pm2 = createPageBuilder('rt');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'Valuation in progress', title: 'We are preparing your valuation', text: 'Elena reviews recent sales near you and will email your estimate within 24 hours.', bullets: ['Watch for an email from Harbor & Pine', 'Have recent renovations or photos handy', 'Book a no-pressure walk-through if you would like'] })], { accent });
  return { slug: 'local-real-estate', version: 1, name: 'Real estate home valuation', description: 'Generate seller leads with a free home valuation: market statistics, a short qualifying form and an agent profile.', category: 'local-services', industry: 'real-estate', goal: 'leads', tags: ['real estate', 'home valuation', 'seller leads', 'agent'], basePath: '/home-valuation', accent, products: [], steps: [{ name: 'Landing page', path: '/home-valuation', kind: 'landing', doc: landing }, { name: 'Valuation in progress', path: '/valuation-requested', kind: 'thankyou', doc: thanks }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function homeServices(): TemplateDef {
  const accent = '#166534';
  const pm = createPageBuilder('hs');
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Free, no-obligation quote'),
          pm.heading('Plumbing, heating and repairs done right', { level: 1 }),
          pm.text('Licensed local tradespeople, fixed prices and a 12-month guarantee on every job. Tell us what you need and we reply within two hours.', { muted: true, size: '1.15rem' }),
          trustRow(pm, ['Licensed and insured', '4.8 from 640 reviews', '12-month guarantee'], '#dcfce7'),
        ], { grow: 1 }),
        pm.col([pm.form('hs-form', {
          name: 'Free quote', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone', true), field('service', 'select', 'What do you need?', true, { options: ['Plumbing repair', 'Boiler or heating', 'Bathroom refit', 'Electrical work', 'Roof or gutters', 'Something else'] }), field('postcode', 'text', 'Postcode', true), field('details', 'textarea', 'Tell us a little more')],
          submitLabel: 'Get my free quote', consent: consent('I agree to be contacted about my quote.'),
        })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'soft', background: '#f0fdf4', padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('How it works', { align: 'center' })]),
      stepsRow(pm, accent, [{ title: 'Tell us the job', body: 'Fill in the short form or call us. Photos help but are not needed.' }, { title: 'Get a fixed quote', body: 'Within two hours you get a clear price. No call-out fee, no surprises.' }, { title: 'We fix it', body: 'A named, uniformed technician arrives on time and tidies up after.' }]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Why neighbours choose us', { align: 'center' })]),
      pm.cols([
        [infoCard(pm, '✓', 'Licensed and insured', ['Fully qualified, background-checked technicians.'], '#dcfce7', '#14532d')],
        [infoCard(pm, '⚡', 'Same-day emergency', ['Burst pipe or no heating? We are on the road within hours.'], '#ffedd5', '#7c2d12')],
        [infoCard(pm, '★', 'Guaranteed work', ['Twelve months on labour, and manufacturer warranty on parts.'], '#fef3c7', '#78350f')],
      ], { gap: 'sm' }),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('What customers say', { align: 'center' })]),
      pm.cols([
        [testimonial(pm, 'Boiler failed on a Sunday, fixed by lunchtime and the price matched the quote.', 'Helen P.', 'Boiler repair', 'HP')],
        [testimonial(pm, 'Polite, on time and left the bathroom spotless. Already booked them for the kitchen.', 'Amir S.', 'Bathroom refit', 'AS')],
      ]),
    ], { padding: 'lg', width: 'wide' }),
    footer(pm, 'Greenfield Home Services'),
  ], { accent });
  const pm2 = createPageBuilder('ht');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'Quote requested', title: 'Thanks, we are on it', text: 'Expect your fixed-price quote by email or phone within two hours (8:00 to 20:00 daily).', bullets: ['A coordinator reviews your request', 'You receive a clear, fixed price', 'Accept it and pick a time that suits you'] })], { accent });
  return { slug: 'local-home-services', version: 1, name: 'Home services quote', description: 'A trust-first page for plumbers, electricians and repair crews: free quote form with a service picker, process, guarantees and reviews.', category: 'local-services', industry: 'home-services', goal: 'leads', tags: ['plumber', 'home services', 'free quote', 'repairs', 'local business'], basePath: '/free-quote', accent, products: [], steps: [{ name: 'Landing page', path: '/free-quote', kind: 'landing', doc: landing }, { name: 'Quote requested', path: '/quote-requested', kind: 'thankyou', doc: thanks }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function application(): TemplateDef {
  const accent = '#4338ca';
  const pm = createPageBuilder('ap');
  const landing = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Limited places', { align: 'center' }),
        pm.heading('Apply for the 12-week Growth Partnership', { level: 1, align: 'center' }),
        pm.text('A small group program for founders at $10k to $100k a month who want a clear plan, weekly accountability and a team that helps implement.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.button('Start my application', { type: 'next_step' }, { size: 'lg', align: 'center', variant: 'secondary' }),
        pm.text('Takes 4 minutes. We reply within 2 working days.', { align: 'center', muted: true, size: '.9rem' }),
      ]),
    ], { theme: 'dark', background: HERO.indigo, padding: 'xl', width: 'medium', align: 'center' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('This is for you if', { level: 3 }), pm.list(['You already have paying customers', 'You can commit 4 hours a week', 'You want honest feedback, not cheerleading'])]),
        pm.col([pm.heading('This is not for you if', { level: 3 }), pm.list(['You are still choosing an idea', 'You want a done-for-you service', 'You cannot join a weekly call'], { icon: 'dot' })]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'medium' }),
    pm.section([
      pm.stack([pm.heading('How the application works', { align: 'center' })]),
      stepsRow(pm, accent, [{ title: 'Apply', body: 'Answer a few questions about you and your business.' }, { title: 'Review', body: 'We read every application and reply within two working days.' }, { title: 'Meet', body: 'Shortlisted founders get a 20-minute call to check mutual fit.' }]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([pm.stack([testimonial(pm, 'Revenue went from $22k to $61k a month in the program, and I finally have a team that runs without me.', 'Nadia Rahman', 'Founder, Loomtide', 'NR')])], { padding: 'lg', width: 'small' }),
    faqSection(pm, 'Before you apply', [{ q: 'How much does it cost?', a: 'We share pricing on the call. It is an investment, and we only accept people we are confident we can help.' }, { q: 'Is there a guarantee?', a: 'If you attend every session and do the work and see no value by week four, we refund you in full.' }], 'light'),
    footer(pm, 'Growth Partnership'),
  ], { accent });
  const pm2 = createPageBuilder('aq');
  const form = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.progress(50, 'Step 1 of 2: your application'),
        pm2.heading('Tell us about you and your business', { level: 1 }),
        pm2.text('Be specific: it helps us decide quickly. All answers are confidential.', { muted: true }),
        pm2.form('ap-form', {
          name: 'Application', fields: [field('name', 'name', 'Full name', true), field('email', 'email', 'Email', true), field('phone', 'phone', 'Phone (for the call)'), field('company', 'text', 'Business name and website', true), field('revenue', 'select', 'Current monthly revenue', true, { options: ['Under $10k', '$10k to $25k', '$25k to $50k', '$50k to $100k', 'Over $100k'] }), field('team', 'select', 'Team size', true, { options: ['Just me', '2 to 5', '6 to 15', 'More than 15'] }), field('goal', 'textarea', 'What is the one result you want in the next 12 weeks?', true, { maxLength: 800 }), field('blocker', 'textarea', 'What is stopping you today?', true, { maxLength: 800 }), field('hours', 'select', 'Can you commit 4 hours a week?', true, { options: ['Yes', 'Probably', 'Not right now'] })],
          submitLabel: 'Submit application', consent: consent('I agree that you may contact me about my application.'),
        }),
      ]),
    ], { padding: 'lg', width: 'small' }),
  ], { accent });
  const pm3 = createPageBuilder('ar');
  const review = finish(pm3, [thanksSection(pm3, { eyebrow: 'Application received', title: 'Thank you, we are reviewing it', text: 'We read every application personally. You will hear from us within two working days.', bullets: ['We review your answers', 'If it looks like a fit, we send a link to book a 20-minute call', 'Either way, you get an honest reply'] })], { accent });
  return { slug: 'application-funnel', version: 1, name: 'Application funnel', description: 'Qualify high-ticket prospects: a selective landing page, a structured application with qualifying questions and a clear what-happens-next page.', category: 'booking', industry: 'coaching', goal: 'booking', tags: ['application', 'high ticket', 'qualification', 'coaching', 'program'], basePath: '/apply', accent, products: [], steps: [{ name: 'Landing page', path: '/apply', kind: 'landing', doc: landing }, { name: 'Application', path: '/apply-now', kind: 'application', doc: form }, { name: 'Under review', path: '/application-received', kind: 'thankyou', doc: review }] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------

function agency(): TemplateDef {
  const accent = '#6d28d9';
  const pm = createPageBuilder('ag');
  const landing = finish(pm, [
    nav(pm, 'Northlight Studio', [['Results', '#results'], ['Process', '#process']], ['Free audit', { type: 'anchor', anchor: 'audit' }]),
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Performance marketing agency'),
          pm.heading('We turn ad spend into predictable revenue', { level: 1 }),
          pm.text('Get a free 20-point audit of your paid and organic funnels, with the three fixes most likely to lift revenue in the next 30 days.', { muted: true, size: '1.15rem' }),
          pm.button('Get my free audit', { type: 'anchor', anchor: 'audit' }, { size: 'lg' }),
        ], { grow: 1 }),
        pm.col([browserMock(pm, accent, { tint: '#1e1b4b' })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.plum, padding: 'xl', width: 'wide' }),
    pm.section([logoStrip(pm, 'Trusted by growing brands', ['LOOMTIDE', 'KESTREL', 'BRIGHTFORD', 'OAKLEAF', 'PIXELMILL'])], { padding: 'md', width: 'wide' }),
    pm.section([
      pm.stack([pm.eyebrow('Results', { align: 'center' }), pm.heading('Numbers our clients can point to', { align: 'center' })]),
      pm.row([pm.col([statsRow(pm, [['3.8x', 'average return on ad spend'], ['-41%', 'cost per lead in 90 days'], ['$12M', 'revenue generated in 2024']]), pm.text('Case study: Loomtide, a subscription-box brand, grew paid revenue from $38k to $142k a month in six months while keeping margin.', { muted: true, align: 'center' })], { grow: 2 }), pm.col([ringMock(pm, 82, '82%', accent), pm.text('of clients stay with us after year one', { muted: true, align: 'center' })], { grow: 1 })], { valign: 'center', gap: 'lg' }),
    ], { anchor: 'results', theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('How we work', { align: 'center' })]),
      stepsRow(pm, accent, [{ title: 'Audit', body: 'We review your accounts, funnels and tracking and show where money leaks.' }, { title: 'Plan', body: 'A 90-day roadmap ranked by impact, with clear targets for each channel.' }, { title: 'Launch', body: 'We build, test and scale, reporting every week in plain language.' }]),
    ], { anchor: 'process', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('Request your free audit', { level: 2 }), pm.text('Share a few details and we will send your audit within three working days.', { muted: true }), pm.list(['No contract and no sales pressure', 'Delivered as a short video and a PDF', 'Yours to keep, whether or not we work together'])], { grow: 1 }),
        pm.col([pm.form('ag-form', {
          name: 'Audit request', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Work email', true), field('site', 'text', 'Website', true), field('budget', 'select', 'Monthly ad budget', true, { options: ['Under $5k', '$5k to $20k', '$20k to $50k', 'Over $50k', 'Not advertising yet'] }), field('goal', 'select', 'Main goal', true, { options: ['More leads', 'More online sales', 'Lower acquisition cost', 'Better reporting'] })],
          submitLabel: 'Send my free audit', consent: consent('I agree to be contacted about my audit.'),
        })], { grow: 1 }),
      ], { gap: 'lg' }),
    ], { anchor: 'audit', theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm, 'Northlight Studio'),
  ], { accent });
  const pm2 = createPageBuilder('at');
  const thanks = finish(pm2, [thanksSection(pm2, { eyebrow: 'Audit requested', title: 'Thanks, your audit is in the queue', text: 'A strategist will review your accounts and send your audit within three working days.', bullets: ['We may email with one or two questions', 'You receive a video walkthrough and PDF', 'Book a call if you want to talk it through'], button: { label: 'See our case studies', action: { type: 'link', url: 'https://example.com/case-studies', newTab: true } } })], { accent });
  return { slug: 'agency-lead-gen', version: 1, name: 'Agency lead generation', description: 'Win clients with a free audit offer: results and case-study numbers, a three-step process, a logo strip and an audit request form.', category: 'agency', industry: 'agency', goal: 'leads', tags: ['agency', 'free audit', 'marketing', 'case study', 'b2b'], basePath: '/free-audit', accent, products: [], steps: [{ name: 'Landing page', path: '/free-audit', kind: 'landing', doc: landing }, { name: 'Audit requested', path: '/audit-requested', kind: 'thankyou', doc: thanks }] };
}

export const templates: TemplateDef[] = [dentist(), gym(), bakery(), realEstate(), homeServices(), application(), agency()];

