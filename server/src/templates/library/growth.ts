import {
  HERO, avatar, browserMock, chartMock, createPageBuilder, ctaBand, discs, faqSection, feature, field, finish, footer, phoneMock, ringMock, stat, statsRow, stepsRow, testimonial, thanksSection,
  type GjsNode, type PageBuilder,
} from '../kit.js';
import type { TemplateDef } from '../types.js';

/**
 * Growth templates: lead magnet (checklist style), webinar replay, waitlist, giveaway, quiz, app download and event ticketing.
 * Illustrations are CSS compositions (the page sanitiser does not accept SVG or remote images).
 */

const consent = (text: string) => ({ enabled: true, text });

/** A light "checklist card" illustration: ticked rows built from boxes. */
function checklistCard(pm: PageBuilder, rows: string[]): GjsNode {
  const row = (t: string, done: boolean) =>
    pm.box([
      pm.box(done ? [pm.text('✓', { align: 'center', color: '#ffffff' })] : [], { name: 'Tick', style: { width: '26px', height: '26px', 'border-radius': '8px', background: done ? '#0f766e' : '#ffffff', color: done ? '#ffffff' : '#0f172a', border: done ? '2px solid #0f766e' : '2px solid #94a3b8', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800', 'flex-shrink': '0' } }),
      pm.text(t, { size: '1rem' }),
    ], { name: 'Checklist row', style: { display: 'flex', gap: '12px', 'align-items': 'center', padding: '10px 4px', 'border-bottom': '1px solid #e2e8f0' } });
  return pm.card([pm.eyebrow('Launch checklist'), ...rows.map((r, i) => row(r, i < 3))], { name: 'Checklist card', featured: true, style: { 'max-width': '440px', width: '100%', transform: 'rotate(1.5deg)' } });
}

/** Numbered steps with an explicitly coloured numeral (the contrast audit does not inherit a parent's colour). */
function localSteps(pm: PageBuilder, items: { title: string; body: string }[]): GjsNode {
  return pm.cols(items.map((it, i) => [pm.box([
    pm.box([pm.text(String(i + 1), { align: 'center', color: '#ffffff' })], { name: 'Step number', style: { width: '44px', height: '44px', 'border-radius': '50%', background: '#9a3412', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(it.title, { level: 3 }), pm.text(it.body, { muted: true }),
  ], { name: 'Step', style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } })]));
}

// 1 ---------------------------------------------------------------------------------------------------------------------------------------------------
function leadMagnetChecklist(): TemplateDef {
  const pm = createPageBuilder('lc');
  const optin = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Free download · 2 pages · 10 minutes'),
          pm.heading('The 15-point checklist for a launch that does not flop', { level: 1 }),
          pm.text('Every item we check before sending a single email or ad dollar to a new offer. Print it, tick it, launch with confidence.', { muted: true, size: '1.15rem' }),
          pm.form('lc-form', { name: 'Get the checklist', fields: [field('name', 'name', 'First name', true), field('email', 'email', 'Best email', true)], submitLabel: 'Email me the checklist', consent: consent('Send me the checklist and occasional launch tips. Unsubscribe any time.') }),
          pm.text('Join 12,400 founders. No spam, ever.', { muted: true, size: '.9rem' }),
        ], { grow: 1 }),
        pm.col([checklistCard(pm, ['Offer promise fits on one line', 'Checkout tested on a phone', 'Welcome email scheduled', 'Tracking confirmed end to end', 'Refund policy written in plain words'])], { grow: 1, style: { 'align-items': 'center', 'justify-content': 'center' } }),
      ], { valign: 'center', gap: 'lg' }),
    ], { padding: 'xl', width: 'wide', anchor: 'top' }),
    pm.section([
      pm.stack([pm.eyebrow('What the checklist covers', { align: 'center' }), pm.heading('Five areas, fifteen checks', { align: 'center' })]),
      pm.cols([
        [feature(pm, '1', 'Offer', 'A promise, a price and a guarantee a stranger understands in ten seconds.')],
        [feature(pm, '2', 'Page', 'Headline, proof and a single call to action, checked on mobile first.')],
        [feature(pm, '3', 'Follow-up', 'The first three emails that turn a click into a customer.')],
      ]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([
      pm.cols([[testimonial(pm, 'We caught a broken checkout link two hours before launch. Worth it for that alone.', 'Hannah Ortiz', 'Founder, Loomwell', 'HO')], [testimonial(pm, 'Pinned above my desk. We run it before every campaign now.', 'Marcus Dell', 'Growth lead', 'MD')]]),
    ], { padding: 'lg', width: 'medium' }),
    footer(pm, 'Launchwise'),
  ], { accent: '#0f766e' });
  const pm2 = createPageBuilder('lt');
  const thanks = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Check your inbox', title: 'Your checklist is on its way', text: 'It lands in under a minute from hello@launchwise.example. Not there? Look in Promotions or Spam and move it to your inbox.', bullets: ['Open the email and download the PDF', 'Print it or keep it beside your launch plan', 'Reply and tell us which item surprised you'], button: { label: 'Read the launch blog', action: { type: 'link', url: 'https://example.com/blog', newTab: true } } }),
    footer(pm2, 'Launchwise'),
  ], { accent: '#0f766e' });
  return {
    slug: 'lead-magnet-checklist', version: 1, name: 'Lead magnet: checklist', description: 'A light, minimal opt-in for a printable checklist, with a checklist card illustration and a short thank-you step.', category: 'lead-generation', industry: 'general', goal: 'leads',
    tags: ['lead magnet', 'checklist', 'opt-in', 'minimal'], basePath: '/checklist', accent: '#0f766e', products: [],
    steps: [{ name: 'Opt-in', path: '/checklist', kind: 'optin', doc: optin }, { name: 'Thank you', path: '/checklist-sent', kind: 'thankyou', doc: thanks }],
  };
}

// 2 ---------------------------------------------------------------------------------------------------------------------------------------------------
function webinarReplay(): TemplateDef {
  const pm = createPageBuilder('wr');
  const reg = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Free live workshop · Thursday 12:00 ET'),
          pm.heading('Turn your expertise into a course people finish', { level: 1 }),
          pm.text('A 60-minute workshop on outlining, recording and selling a short course, with live Q&A.', { muted: true, size: '1.1rem' }),
          pm.list(['The 3-module outline that keeps completion above 70%', 'How to record a lesson in one take', 'Pricing your first cohort without guessing']),
        ], { grow: 1 }),
        pm.col([pm.form('wr-form', { name: 'Reserve a seat', fields: [field('name', 'name', 'Your name', true), field('email', 'email', 'Email', true)], submitLabel: 'Reserve my seat', consent: consent('Email me the joining link, reminders and the replay.') })], { grow: 1 }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.indigo, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Your host', { align: 'center' })]),
      pm.row([pm.col([avatar(pm, 'EV', '#c7d2fe', '#1e1b4b')], { grow: 0, style: { 'flex-basis': '64px' } }), pm.col([pm.heading('Elena Voss', { level: 3 }), pm.text('Course designer. Elena has launched 40+ courses for creators and teams, with 18,000 students in total.', { muted: true })])], { valign: 'center', keep: true }),
    ], { padding: 'lg', width: 'small' }),
    faqSection(pm, 'Before you register', [{ q: 'Is there a replay?', a: 'Yes. Everyone who registers gets the recording for 48 hours.' }, { q: 'Do I need slides or equipment?', a: 'No. Bring a topic idea and a notebook.' }]),
    footer(pm, 'Course Studio'),
  ], { accent: '#4338ca' });
  const pm2 = createPageBuilder('wp');
  const replay = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.eyebrow('Workshop replay', { align: 'center' }),
        pm2.heading('Watch: turn your expertise into a course', { level: 1, align: 'center' }),
        pm2.video('https://vimeo.com/76979871', 'Workshop replay'),
        pm2.countdown({ mode: 'evergreen', minutes: 60 * 48, label: 'Replay expires in' }),
      ]),
    ], { theme: 'dark', background: HERO.slate, padding: 'lg', width: 'medium', align: 'center' }),
    pm2.section([
      pm2.row([
        pm2.col([pm2.heading('Ready to build yours?', { level: 2 }), pm2.text('Course Studio walks you from outline to launch in four weeks, with feedback on every lesson.', { muted: true }), pm2.button('See the Course Studio program', { type: 'next_step' }, { size: 'lg' })]),
        pm2.col([pm2.card([pm2.eyebrow('Workshop notes'), pm2.list(['Outline template (Notion and PDF)', 'Lesson recording checklist', 'Pricing worksheet'])], { name: 'Notes' })]),
      ], { valign: 'center', gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    footer(pm2, 'Course Studio'),
  ], { accent: '#4338ca' });
  const pm3 = createPageBuilder('wt');
  const thanks = finish(pm3, [
    thanksSection(pm3, { title: 'Thanks for watching', text: 'The program details are in your inbox. Hit reply with your course idea and Elena will read it personally.', bullets: ['Download the workshop notes', 'Pick a start date for your outline', 'Book a free 15-minute review'], button: { label: 'Back to the replay', action: { type: 'link', url: '/workshop-replay' } } }),
    footer(pm3, 'Course Studio'),
  ], { accent: '#4338ca' });
  return {
    slug: 'webinar-replay', version: 1, name: 'Webinar with replay', description: 'Registration, a replay page with an expiring countdown and a soft call to action, and a thank-you step for the follow-up.', category: 'events', industry: 'education', goal: 'webinar',
    tags: ['webinar', 'replay', 'workshop', 'evergreen'], basePath: '/workshop', accent: '#4338ca', products: [],
    steps: [{ name: 'Registration', path: '/workshop', kind: 'registration', doc: reg }, { name: 'Replay', path: '/workshop-replay', kind: 'replay', doc: replay }, { name: 'Thank you', path: '/workshop-thanks', kind: 'thankyou', doc: thanks }],
  };
}

// 3 ---------------------------------------------------------------------------------------------------------------------------------------------------
function waitlist(): TemplateDef {
  const pm = createPageBuilder('wl');
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('Private beta · opens in'),
          pm.heading('Meet Tidepool, the calm inbox for client work', { level: 1 }),
          pm.text('Join the waitlist and get the first 60 days free plus a founding-member price for life.', { muted: true, size: '1.15rem' }),
          pm.countdown({ mode: 'fixed', endsAt: '2031-03-01T09:00:00Z', label: 'Beta doors open' }),
          pm.progress(64, '1,284 of 2,000 early spots claimed'),
          pm.form('wl-form', { name: 'Join the waitlist', fields: [field('email', 'email', 'Work email', true)], submitLabel: 'Save my early spot', success: { type: 'next_step' } }),
        ], { grow: 1 }),
        pm.col([browserMock(pm, '#7c3aed', { tint: '#312e81' })], { grow: 1, style: { 'align-items': 'center' } }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.violet, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Why people are waiting', { align: 'center' })]),
      pm.cols([[feature(pm, '✦', 'One thread per client', 'Mail, files and approvals grouped by client, not by sender.')], [feature(pm, '⏱', 'Quiet hours', 'Notifications held until you decide to look.')], [feature(pm, '✓', 'Approvals that stick', 'Clients approve in one click and you keep the receipt.')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    faqSection(pm, 'Waitlist questions', [{ q: 'When do I get access?', a: 'Invites go out in the order people joined, in waves of 200 a week.' }, { q: 'Does it cost anything to join?', a: 'No. You only pay if you choose a plan after the free 60 days.' }], 'light'),
    footer(pm, 'Tidepool'),
  ], { accent: '#6d28d9' });
  const pm2 = createPageBuilder('wy');
  const inn = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'You are on the list', title: 'Your early spot is saved', text: 'We will email you the moment your invite is ready. Want to move up? Each friend who joins bumps you forward.', bullets: ['Share your link with one colleague', 'Post it where freelancers hang out', 'Follow the build log for sneak peeks'], button: { label: 'Share on LinkedIn', action: { type: 'link', url: 'https://example.com/share', newTab: true } } }),
    pm2.section([pm2.cols([[stat(pm2, '1,284', 'on the waitlist')], [stat(pm2, '200', 'invites per week')], [stat(pm2, '60 days', 'free for founders')]], { keep: true })], { theme: 'soft', padding: 'md', width: 'medium' }),
    footer(pm2, 'Tidepool'),
  ], { accent: '#6d28d9' });
  return {
    slug: 'waitlist-prelaunch', version: 1, name: 'Waitlist and pre-launch', description: 'A pre-launch page with a countdown, a progress bar of early spots and a product mock-up, followed by a share-to-move-up confirmation.', category: 'lead-generation', industry: 'saas', goal: 'leads',
    tags: ['waitlist', 'pre-launch', 'countdown', 'beta'], basePath: '/waitlist', accent: '#6d28d9', products: [],
    steps: [{ name: 'Waitlist', path: '/waitlist', kind: 'landing', doc: landing }, { name: 'You are in', path: '/waitlist-joined', kind: 'thankyou', doc: inn }],
  };
}

// 4 ---------------------------------------------------------------------------------------------------------------------------------------------------
function giveaway(): TemplateDef {
  const pm = createPageBuilder('gv');
  const prize = (title: string, sub: string, bg: string) =>
    pm.card([pm.box([], { name: 'Prize art', style: { height: '110px', 'border-radius': '12px', background: 'radial-gradient(circle at 30% 40%,#fdba74 0,#fdba74 28%,transparent 29%),radial-gradient(circle at 62% 55%,#fda4af 0,#fda4af 24%,transparent 25%),radial-gradient(circle at 78% 30%,#fde68a 0,#fde68a 16%,transparent 17%),#ffedd5' } }), pm.heading(title, { level: 3 }), pm.text(sub, { muted: true })], { name: 'Prize', style: { background: bg } });
  const enter = finish(pm, [
    pm.section([
      pm.stack([
        pm.badgeText('Giveaway · 3 winners'),
        pm.heading('Win the Slow Mornings kit worth $480', { level: 1, align: 'center' }),
        pm.text('A hand-thrown ceramic set, a year of single-origin coffee and a pour-over stand. Enter in 20 seconds.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.countdown({ mode: 'fixed', endsAt: '2031-02-14T23:59:00Z', label: 'Entries close in' }),
      ]),
    ], { theme: 'dark', background: HERO.amber, padding: 'xl', width: 'medium', align: 'center' }),
    pm.section([
      pm.row([
        pm.col([pm.heading('What you could win', { level: 2 }), pm.cols([[prize('Grand prize', 'The full kit: mugs, dripper and 12 bags of beans.', '#fff7ed')], [prize('Runner-up x2', 'A mug set and three bags of beans each.', '#fff7ed')]])], { grow: 2 }),
        pm.col([pm.form('gv-form', { name: 'Enter the giveaway', fields: [field('name', 'name', 'Your name', true), field('email', 'email', 'Email', true), field('handle', 'text', 'Instagram handle (optional)')], submitLabel: 'Enter the giveaway', consent: consent('I agree to the rules and to receive the Slow Mornings newsletter.') })], { grow: 1 }),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide', anchor: 'enter' }),
    pm.section([pm.stack([pm.heading('How it works', { align: 'center' }), localSteps(pm, [{ title: 'Enter', body: 'Add your name and email above.' }, { title: 'Confirm', body: 'Click the link we email you to lock in your entry.' }, { title: 'Win', body: 'Winners are drawn at random and announced on 15 February.' }])])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    pm.section([pm.stack([pm.text('Open worldwide, 18+. No purchase necessary. Odds depend on the number of entries. Winners are notified by email and have 7 days to reply.', { align: 'center', muted: true, size: '.85rem' })])], { padding: 'sm', width: 'small' }),
    footer(pm, 'Slow Mornings'),
  ], { accent: '#c2410c' });
  const pm2 = createPageBuilder('ge');
  const done = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Entry received', title: 'You are in the draw!', text: 'Check your inbox and click the confirmation link, or your entry will not count. Want more chances?', bullets: ['Forward the giveaway to a friend: +3 entries', 'Follow @slowmornings: +2 entries', 'Share your entry link on stories: +5 entries'], button: { label: 'Share the giveaway', action: { type: 'link', url: 'https://example.com/share', newTab: true } } }),
    footer(pm2, 'Slow Mornings'),
  ], { accent: '#c2410c' });
  return {
    slug: 'giveaway-contest', version: 1, name: 'Giveaway and contest', description: 'A warm giveaway page with prize cards, a closing countdown and an entry form, then a confirmation with bonus-entry ideas.', category: 'lead-generation', industry: 'ecommerce', goal: 'engagement',
    tags: ['giveaway', 'contest', 'sweepstakes', 'countdown'], basePath: '/giveaway', accent: '#c2410c', products: [],
    steps: [{ name: 'Enter', path: '/giveaway', kind: 'landing', doc: enter }, { name: 'Entered', path: '/giveaway-entered', kind: 'thankyou', doc: done }],
  };
}

// 5 ---------------------------------------------------------------------------------------------------------------------------------------------------
function quiz(): TemplateDef {
  const pm = createPageBuilder('qz');
  const intro = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('2-minute quiz'),
          pm.heading('What is your money personality?', { level: 1 }),
          pm.text('Answer four quick questions and get a personal plan: where your money leaks, and the one habit to change first.', { muted: true, size: '1.15rem' }),
          pm.button('Start the quiz', { type: 'next_step' }, { size: 'lg' }),
          pm.text('48,000 quizzes taken · takes about 2 minutes', { muted: true, size: '.9rem' }),
        ], { grow: 1 }),
        pm.col([pm.box([ringMock(pm, 72, '72%', '#be123c'), pm.box([chartMock(pm, [30, 45, 40, 62, 80], '#be123c')], { name: 'Chart frame', style: { width: '240px', 'max-width': '100%' } })], { name: 'Result preview', style: { display: 'flex', gap: '20px', 'align-items': 'flex-end', 'flex-wrap': 'wrap', 'justify-content': 'center' } })], { grow: 1, style: { 'align-items': 'center' } }),
      ], { valign: 'center', gap: 'lg' }),
    ], { padding: 'xl', width: 'wide' }),
    pm.section([pm.stack([pm.heading('Why take it', { align: 'center' })]), pm.cols([[feature(pm, '1', 'Personal', 'Your answers shape the plan. No generic tips.')], [feature(pm, '2', 'Fast', 'Four questions, one result page.')], [feature(pm, '3', 'Free', 'No card, no account. Just your email for the result.')]])], { theme: 'soft', padding: 'lg', width: 'wide' }),
    footer(pm, 'Pennywise'),
  ], { accent: '#be123c' });
  const pm2 = createPageBuilder('qq');
  const questions = finish(pm2, [
    pm2.section([
      pm2.stack([
        pm2.progress(66, 'Almost done: step 2 of 3'),
        pm2.heading('Tell us about your money habits', { level: 1 }),
        pm2.form('qq-form', {
          name: 'Money quiz',
          fields: [
            field('spending', 'select', 'When money arrives, what do you do first?', true, { options: ['Pay bills, then spend the rest', 'Move some to savings straight away', 'Check what I want to buy', 'I am not sure where it goes'] }),
            field('tracking', 'select', 'How often do you check your balance?', true, { options: ['Daily', 'A few times a week', 'Once a month', 'Only when I have to'] }),
            field('goal', 'select', 'Your biggest goal this year?', true, { options: ['Build an emergency fund', 'Pay off debt', 'Save for a big purchase', 'Start investing'] }),
            field('stress', 'select', 'How does money make you feel?', true, { options: ['Calm', 'Mostly fine', 'Anxious', 'I avoid thinking about it'] }),
            field('email', 'email', 'Where should we send your result?', true),
          ],
          submitLabel: 'Show my result', consent: consent('Email me my result and a short money-tips series.'),
        }),
      ]),
    ], { padding: 'lg', width: 'small' }),
    footer(pm2, 'Pennywise'),
  ], { accent: '#be123c' });
  const pm3 = createPageBuilder('qr');
  const result = finish(pm3, [
    pm3.section([
      pm3.stack([
        pm3.eyebrow('Your result', { align: 'center' }),
        pm3.heading('You are a Planner in progress', { level: 1, align: 'center' }),
        pm3.box([ringMock(pm3, 72, '72%', '#be123c')], { name: 'Score', style: { display: 'flex', 'justify-content': 'center' } }),
        pm3.text('You know where your money goes, but it is not working hard yet. Your biggest leak is small recurring spending; your biggest win is an automatic transfer on payday.', { align: 'center', muted: true }),
        pm3.card([pm3.heading('Your first habit', { level: 3 }), pm3.list(['Move 10% to savings the day you are paid', 'Cancel one subscription you have not used this month', 'Review spending every Sunday for 10 minutes'])], { name: 'Plan' }),
        pm3.button('Get the full plan by email', { type: 'link', url: 'https://example.com/plan', newTab: true }, { size: 'lg', align: 'center' }),
      ]),
    ], { padding: 'xl', width: 'small', align: 'center' }),
    footer(pm3, 'Pennywise'),
  ], { accent: '#be123c' });
  return {
    slug: 'survey-quiz', version: 1, name: 'Survey and quiz', description: 'A three-step quiz: an inviting intro, a select-question form that captures the email, and a personalised-looking result page.', category: 'lead-generation', industry: 'general', goal: 'engagement',
    tags: ['quiz', 'survey', 'lead generation', 'interactive'], basePath: '/quiz', accent: '#be123c', products: [],
    steps: [{ name: 'Intro', path: '/quiz', kind: 'landing', doc: intro }, { name: 'Quiz', path: '/quiz-questions', kind: 'survey', doc: questions }, { name: 'Your result', path: '/quiz-result', kind: 'thankyou', doc: result }],
  };
}

// 6 ---------------------------------------------------------------------------------------------------------------------------------------------------
function appDownload(): TemplateDef {
  const pm = createPageBuilder('ap');
  const store = (label: string) => pm.button(label, { type: 'link', url: 'https://example.com/app', newTab: true }, { variant: 'secondary', size: 'lg' });
  const landing = finish(pm, [
    pm.section([
      pm.row([
        pm.col([
          pm.eyebrow('New · iOS and Android'),
          pm.heading('Plan your week in one tap with Rally', { level: 1 }),
          pm.text('Shared calendars, to-dos and reminders for the people you live with. Rated 4.8 by 31,000 households.', { muted: true, size: '1.15rem' }),
          pm.box([store('Download on the App Store'), store('Get it on Google Play')], { name: 'Store buttons', style: { display: 'flex', gap: '12px', 'flex-wrap': 'wrap' } }),
          pm.text('Or get the link by email', { muted: true, size: '.9rem' }),
          pm.form('ap-form', { name: 'Send me the link', fields: [field('email', 'email', 'Email', true)], submitLabel: 'Text me the link' }),
        ], { grow: 1 }),
        pm.col([phoneMock(pm, '#0f766e', { tint: '#1e3a8a' })], { grow: 1, style: { 'align-items': 'center' } }),
      ], { valign: 'center', gap: 'lg' }),
    ], { theme: 'dark', background: HERO.teal, padding: 'xl', width: 'wide' }),
    pm.section([
      pm.stack([pm.heading('Made for busy households', { align: 'center' })]),
      pm.cols([[feature(pm, '1', 'Shared lists', 'Groceries and chores update for everyone instantly.')], [feature(pm, '2', 'Gentle reminders', 'Nudges that arrive when they help, not when they annoy.')], [feature(pm, '3', 'Works offline', 'Check things off on the train. Sync when you are back.')]]),
    ], { padding: 'lg', width: 'wide' }),
    pm.section([statsRow(pm, [['4.8', 'average rating'], ['31k', 'households'], ['2 min', 'to set up']])], { theme: 'soft', padding: 'md', width: 'medium' }),
    faqSection(pm, 'Good to know', [{ q: 'Is Rally free?', a: 'Yes for up to four people. Larger households can upgrade later.' }, { q: 'Which phones are supported?', a: 'iOS 15 and later, Android 9 and later.' }], 'light'),
    footer(pm, 'Rally'),
  ], { accent: '#0f766e' });
  const pm2 = createPageBuilder('ac');
  const sent = finish(pm2, [
    thanksSection(pm2, { eyebrow: 'Check your inbox', title: 'The link is on its way', text: 'Open it on your phone to install Rally. It takes about a minute.', bullets: ['Open the email on your phone', 'Tap the store button and install', 'Invite your household from the welcome screen'] }),
    footer(pm2, 'Rally'),
  ], { accent: '#0f766e' });
  return {
    slug: 'app-download', version: 1, name: 'App download', description: 'A mobile app landing page with a phone mock-up, store buttons, a send-me-the-link form and a confirmation step.', category: 'saas', industry: 'saas', goal: 'engagement',
    tags: ['app', 'mobile', 'download', 'store'], basePath: '/app', accent: '#0f766e', products: [],
    steps: [{ name: 'Landing', path: '/app', kind: 'landing', doc: landing }, { name: 'Check your phone', path: '/app-link-sent', kind: 'thankyou', doc: sent }],
  };
}

// 7 ---------------------------------------------------------------------------------------------------------------------------------------------------
function eventTicketing(): TemplateDef {
  const pm = createPageBuilder('ev');
  const slot = (time: string, title: string, who: string) =>
    pm.box([pm.text(`**${time}** · ${title}`), pm.text(who, { muted: true, size: '.92rem' })], { name: 'Session', style: { display: 'flex', 'flex-direction': 'column', gap: '2px', padding: '10px 0', 'border-bottom': '1px solid #e2e8f0' } });
  const speaker = (init: string, name: string, role: string) =>
    pm.card([pm.box([avatar(pm, init, '#ddd6fe', '#3b0764')], { name: 'Avatar', style: { display: 'flex', 'justify-content': 'center' } }), pm.text(`**${name}**`, { align: 'center' }), pm.text(role, { align: 'center', muted: true, size: '.9rem' })], { name: 'Speaker' });
  const event = finish(pm, [
    pm.section([
      pm.stack([
        pm.eyebrow('Brooklyn · 24 October · 9:00 to 17:00', { align: 'center' }),
        pm.heading('Signal Conference 2031', { level: 1, align: 'center' }),
        pm.text('One day, six talks and a room full of product people. Practical sessions, no vendor pitches.', { align: 'center', muted: true, size: '1.15rem' }),
        pm.button('Get tickets', { type: 'next_step' }, { variant: 'secondary', size: 'lg', align: 'center' }),
      ]),
    ], { theme: 'dark', background: HERO.plum, padding: 'xl', width: 'medium', align: 'center' }),
    pm.section([
      pm.stack([pm.heading('The day', { align: 'center' })]),
      pm.card([
        slot('09:00', 'Doors and coffee', 'Main hall'), slot('10:00', 'Shipping less, learning more', 'Priya Nair, Atlas'), slot('11:30', 'Interviews that find the real problem', 'Tom Eriksen, Fieldnote'),
        slot('13:00', 'Lunch and networking', 'Garden'), slot('14:00', 'Metrics that change decisions', 'Dana Whitfield, Northbeam'), slot('16:00', 'Panel: the next five years', 'All speakers'),
      ], { name: 'Schedule' }),
    ], { padding: 'lg', width: 'medium' }),
    pm.section([
      pm.stack([pm.heading('Speakers', { align: 'center' })]),
      pm.cols([[speaker('PN', 'Priya Nair', 'VP Product, Atlas')], [speaker('TE', 'Tom Eriksen', 'CEO, Fieldnote')], [speaker('DW', 'Dana Whitfield', 'Head of Data, Northbeam')]]),
    ], { theme: 'soft', padding: 'lg', width: 'wide' }),
    ctaBand(pm, 'Seats are limited to 300', 'Early tickets sell out every year.', 'Get tickets'),
    footer(pm, 'Signal Conference'),
  ], { accent: '#6d28d9' });
  const pm2 = createPageBuilder('et');
  const tickets = finish(pm2, [
    pm2.section([
      pm2.row([
        pm2.col([pm2.eyebrow('Tickets'), pm2.heading('Reserve your seat', { level: 1 }), pm2.text('Your ticket includes the full day, lunch, the afterparty and the session recordings.', { muted: true }), pm2.list(['Six talks and a closing panel', 'Lunch and coffee all day', 'Recordings sent after the event'])]),
        pm2.col([
          pm2.checkout('et-main', { slot: 'main', productName: 'General admission', price: 79, currency: 'USD', description: 'Full-day access, lunch and recordings.', buttonLabel: 'Buy ticket' }),
          pm2.checkout('et-bump', { slot: 'bump', productName: 'Workshop day pass', price: 39, currency: 'USD', orderBump: true, description: 'Add the 25 October hands-on workshop (limited to 40 seats).' }),
        ]),
      ], { gap: 'lg' }),
    ], { padding: 'lg', width: 'wide' }),
    footer(pm2, 'Signal Conference'),
  ], { accent: '#6d28d9' });
  const pm3 = createPageBuilder('eg');
  const going = finish(pm3, [
    thanksSection(pm3, { eyebrow: 'Ticket confirmed', title: 'You are going to Signal 2031', text: 'Your receipt and ticket are in your inbox. Show the QR code at the door.', bullets: ['Add the date to your calendar', 'Book a hotel with our partner rate', 'Tell a colleague: groups of 4 save 15%'], button: { label: 'View the schedule', action: { type: 'link', url: 'https://example.com/schedule', newTab: true } } }),
    footer(pm3, 'Signal Conference'),
  ], { accent: '#6d28d9' });
  return {
    slug: 'event-ticketing', version: 1, name: 'Event ticketing', description: 'An event page with schedule, speakers and ticket checkout with an optional workshop add-on, then a ticket confirmation.', category: 'events', industry: 'events', goal: 'events',
    tags: ['event', 'tickets', 'conference', 'checkout'], basePath: '/event', accent: '#6d28d9',
    products: [
      { key: 'main', role: 'main', name: 'General admission', description: 'Full-day access, lunch and recordings.', type: 'one_time', amount: 79, currency: 'USD' },
      { key: 'bump', role: 'bump', name: 'Workshop day pass', description: 'Add the 25 October hands-on workshop (limited to 40 seats).', type: 'one_time', amount: 39, currency: 'USD' },
    ],
    steps: [{ name: 'Event', path: '/event', kind: 'landing', doc: event }, { name: 'Tickets', path: '/event-tickets', kind: 'checkout', doc: tickets }, { name: 'You are going', path: '/event-confirmed', kind: 'thankyou', doc: going }],
  };
}

export const templates: TemplateDef[] = [leadMagnetChecklist(), webinarReplay(), waitlist(), giveaway(), quiz(), appDownload(), eventTicketing()];
