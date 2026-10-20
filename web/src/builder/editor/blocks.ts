// Adapted from the legacy builder (see docs/PROVENANCE.md): the legacy block categories and elements (Sections: full / wide / medium / small; Rows: 1-6 columns;
// Text: heading, sub-heading, paragraph, bullet list, link; Media: image, video; Form, Checkout with bump and one-click upsell, Countdown, FAQ, Divider,
// Progress bar, Popup, Custom code). The default markup is rebuilt from the page-builder DSL, so a dropped block is exactly what a template contains.
import type { Editor } from 'grapesjs';
import { createPageBuilder, type GjsNode, type GjsRule, type PageBuilder } from '@pagemodel';
import { randomId } from './types';

export interface BlockDef {
  id: string;
  label: string;
  category: string;
  /** lucide icon name, resolved by the panel */
  icon: string;
  keywords: string;
  content: () => GjsNode;
  /** Only offered to users who may author scripts. */
  scriptsOnly?: boolean;
}

/** A 1x1 grey PNG stretched by CSS: works offline and passes the image allow-list. Replaced via the Settings tab (upload or address). */
export const PLACEHOLDER_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const BLOCK_CATEGORIES = ['Sections', 'Layout', 'Text', 'Media', 'Interactive', 'Conversion', 'Cards', 'Navigation', 'Advanced'] as const;

/** The DSL puts styles in project-level rules by id. A dropped block carries them as component styles (GrapesJS turns those into rules of the new component). */
function inlineStyles(node: GjsNode, rules: GjsRule[]): GjsNode {
  const byId = new Map(rules.flatMap((r) => (r.selectors ?? []).map((s) => [String(typeof s === 'string' ? s : s.name).replace(/^#/, ''), r.style] as const)));
  const keepIds = new Set(['fn-form', 'fn-checkout', 'fn-countdown', 'fn-code', 'fn-popup']);
  const walk = (n: GjsNode): GjsNode => {
    const out: GjsNode = { ...n };
    const attrs = { ...((n.attributes as Record<string, string> | undefined) ?? {}) };
    const id = attrs.id;
    if (id && byId.has(id)) {
      out.style = byId.get(id);
      if (!keepIds.has(String(n.type))) delete attrs.id;
    }
    if (id && keepIds.has(String(n.type))) attrs.id = randomId(String(n.type).replace('fn-', '').slice(0, 1));
    if (Object.keys(attrs).length) out.attributes = attrs;
    else delete out.attributes;
    if (Array.isArray(n.components)) out.components = (n.components as GjsNode[]).map(walk);
    return out;
  };
  return walk(node);
}

const make = (build: (pm: PageBuilder) => GjsNode) => (): GjsNode => {
  const pm = createPageBuilder('b');
  return inlineStyles(build(pm), pm.rules);
};

const avatar = (pm: PageBuilder, initials: string) =>
  pm.box([pm.text(initials, { align: 'center' })], { name: 'Avatar', style: { width: '44px', height: '44px', 'border-radius': '50%', background: '#c7d2fe', color: '#1e1b4b', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '700', 'flex-shrink': '0' } });

const feature = (pm: PageBuilder, n: string, title: string, body: string) =>
  pm.card([
    pm.box([pm.text(n, { align: 'center' })], { name: 'Badge', style: { width: '40px', height: '40px', 'border-radius': '12px', background: '#dbeafe', color: '#1e3a8a', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(title, { level: 3 }),
    pm.text(body, { muted: true }),
  ], { name: 'Feature' });

const testimonial = (pm: PageBuilder, quote: string, name: string, role: string, initials: string) =>
  pm.card([pm.text(`“${quote}”`), pm.box([avatar(pm, initials), pm.box([pm.text(`**${name}**`), pm.text(role, { muted: true, size: '.9rem' })], { name: 'Person' })], { name: 'Person', style: { display: 'flex', 'align-items': 'center', gap: '12px' } })], { name: 'Testimonial' });

const HERO_BLUE = 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)';

export const BLOCKS: BlockDef[] = [
  // ---- Sections ----
  { id: 'section-hero', label: 'Hero', category: 'Sections', icon: 'PanelTop', keywords: 'hero header banner headline cta', content: make((pm) => pm.section([pm.stack([pm.eyebrow('Introducing', { align: 'center' }), pm.heading('A headline that earns the next click', { level: 1, align: 'center' }), pm.text('One or two sentences on who this is for and what they get.', { align: 'center', muted: true, size: '1.15rem' }), pm.button('Get started', { type: 'next_step' }, { size: 'lg', align: 'center' })])], { theme: 'dark', background: HERO_BLUE, padding: 'xl', width: 'small', align: 'center' })) },
  { id: 'section-hero-split', label: 'Hero with form', category: 'Sections', icon: 'PanelTopOpen', keywords: 'hero split form optin lead', content: make((pm) => pm.section([pm.row([pm.col([pm.eyebrow('Free guide'), pm.heading('Turn visitors into subscribers', { level: 1 }), pm.text('Explain the offer in one sentence.', { muted: true, size: '1.1rem' }), pm.list(['First benefit', 'Second benefit', 'Third benefit'])]), pm.col([pm.form('form', { name: 'Opt-in form', fields: [{ id: 'name', type: 'name', label: 'First name', required: true }, { id: 'email', type: 'email', label: 'Email address', required: true }], submitLabel: 'Send it to me', consent: { enabled: true, text: 'I agree to receive emails and can unsubscribe at any time.' } })])], { valign: 'center', gap: 'lg' })], { theme: 'dark', background: HERO_BLUE, padding: 'xl', width: 'wide' })) },
  { id: 'section-features', label: 'Features', category: 'Sections', icon: 'LayoutGrid', keywords: 'features benefits grid three columns', content: make((pm) => pm.section([pm.stack([pm.heading('Why people love it', { align: 'center' })]), pm.cols([[feature(pm, '1', 'First benefit', 'Short, concrete description.')], [feature(pm, '2', 'Second benefit', 'Short, concrete description.')], [feature(pm, '3', 'Third benefit', 'Short, concrete description.')]])], { theme: 'soft', padding: 'lg', width: 'wide' })) },
  { id: 'section-testimonials', label: 'Testimonials', category: 'Sections', icon: 'Quote', keywords: 'testimonials reviews social proof', content: make((pm) => pm.section([pm.stack([pm.heading('What customers say', { align: 'center' })]), pm.cols([[testimonial(pm, 'This changed how we work.', 'Alex Morgan', 'Founder', 'AM')], [testimonial(pm, 'Set up in an afternoon.', 'Sam Rivera', 'Marketing lead', 'SR')], [testimonial(pm, 'Worth every minute.', 'Jo Park', 'Consultant', 'JP')]])], { padding: 'lg', width: 'wide' })) },
  { id: 'section-pricing', label: 'Pricing', category: 'Sections', icon: 'BadgeDollarSign', keywords: 'pricing plans offer cards', content: make((pm) => pm.section([pm.stack([pm.heading('Simple pricing', { align: 'center' })]), pm.cols([[pricing(pm, 'Starter', '$19', ['One funnel', 'Email support'], false)], [pricing(pm, 'Pro', '$49', ['Unlimited funnels', 'Priority support', 'Custom domain'], true)], [pricing(pm, 'Team', '$99', ['Everything in Pro', 'Five seats'], false)]])], { theme: 'soft', padding: 'lg', width: 'wide' })) },
  { id: 'section-faq', label: 'FAQ section', category: 'Sections', icon: 'CircleHelp', keywords: 'faq questions answers accordion', content: make((pm) => pm.section([pm.stack([pm.heading('Frequently asked questions', { align: 'center' }), pm.faq([{ q: 'Is there a guarantee?', a: 'Yes. Describe your refund policy here.' }, { q: 'How does delivery work?', a: 'Describe what happens after sign-up.' }])])], { padding: 'lg', width: 'small' })) },
  { id: 'section-cta', label: 'Call to action', category: 'Sections', icon: 'Megaphone', keywords: 'cta band call action', content: make((pm) => pm.section([pm.stack([pm.heading('Ready to get started?', { align: 'center' }), pm.text('A short reason to act now.', { align: 'center' }), pm.button('Start now', { type: 'next_step' }, { variant: 'secondary', size: 'lg', align: 'center' })])], { theme: 'accent', padding: 'lg', width: 'medium', align: 'center' })) },
  { id: 'section-full', label: 'Full width', category: 'Sections', icon: 'RectangleHorizontal', keywords: 'section blank full width', content: make((pm) => pm.section([pm.stack([])], { width: 'full', padding: 'md' })) },
  { id: 'section-wide', label: 'Wide', category: 'Sections', icon: 'RectangleHorizontal', keywords: 'section blank wide', content: make((pm) => pm.section([pm.stack([])], { width: 'wide', padding: 'md' })) },
  { id: 'section-medium', label: 'Medium', category: 'Sections', icon: 'RectangleHorizontal', keywords: 'section blank medium', content: make((pm) => pm.section([pm.stack([])], { width: 'medium', padding: 'md' })) },
  { id: 'section-small', label: 'Small', category: 'Sections', icon: 'RectangleHorizontal', keywords: 'section blank small narrow', content: make((pm) => pm.section([pm.stack([])], { width: 'small', padding: 'md' })) },

  // ---- Layout (rows of 1 to 5 columns; 6 was the legacy maximum) ----
  ...[1, 2, 3, 4, 5].map((n): BlockDef => ({ id: `row-${n}`, label: `${n} column${n > 1 ? 's' : ''}`, category: 'Layout', icon: n === 1 ? 'Square' : n === 2 ? 'Columns2' : n === 3 ? 'Columns3' : n === 4 ? 'Columns4' : 'Rows3', keywords: `columns row grid ${n}`, content: make((pm) => pm.cols(Array.from({ length: n }, () => []))) })),
  { id: 'row-1-2', label: '1 : 2 columns', category: 'Layout', icon: 'PanelLeft', keywords: 'columns ratio one two', content: make((pm) => pm.cols([[], []], { ratio: '1-2' })) },
  { id: 'row-2-1', label: '2 : 1 columns', category: 'Layout', icon: 'PanelRight', keywords: 'columns ratio two one', content: make((pm) => pm.cols([[], []], { ratio: '2-1' })) },
  { id: 'row-1-2-1', label: '1 : 2 : 1', category: 'Layout', icon: 'Columns3', keywords: 'columns ratio centre wide', content: make((pm) => pm.cols([[], [], []], { ratio: '1-2-1' })) },

  // ---- Text ----
  { id: 'heading', label: 'Heading', category: 'Text', icon: 'Heading1', keywords: 'heading title h1 h2', content: make((pm) => pm.heading('This is a heading', { level: 2 })) },
  { id: 'subheading', label: 'Sub-heading', category: 'Text', icon: 'Heading3', keywords: 'subheading h3', content: make((pm) => pm.heading('This is a sub-heading', { level: 3 })) },
  { id: 'paragraph', label: 'Paragraph', category: 'Text', icon: 'Pilcrow', keywords: 'text paragraph body copy', content: make((pm) => pm.text('Write something compelling here. Select text to make it bold, italic or a link.')) },
  { id: 'list', label: 'Bullet list', category: 'Text', icon: 'List', keywords: 'list bullets checks', content: make((pm) => pm.list(['First benefit', 'Second benefit', 'Third benefit'])) },
  { id: 'list-numbered', label: 'Numbered list', category: 'Text', icon: 'ListOrdered', keywords: 'list numbered steps', content: make((pm) => pm.list(['First step', 'Second step', 'Third step'], { ordered: true })) },
  { id: 'link', label: 'Link', category: 'Text', icon: 'Link', keywords: 'link anchor url', content: make((pm) => pm.link('A link to somewhere', 'https://example.com')) },

  // ---- Media ----
  { id: 'image', label: 'Image', category: 'Media', icon: 'Image', keywords: 'image picture photo', content: make((pm) => pm.image(PLACEHOLDER_IMAGE, 'Describe the image', { align: 'center', style: { width: '100%', 'aspect-ratio': '16 / 9', 'object-fit': 'cover', background: '#e2e8f0' } })) },
  { id: 'video', label: 'Video', category: 'Media', icon: 'Video', keywords: 'video youtube vimeo mp4', content: make((pm) => pm.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Product tour')) },
  { id: 'divider', label: 'Divider', category: 'Media', icon: 'Minus', keywords: 'divider line rule hr', content: make((pm) => pm.divider()) },
  { id: 'spacer', label: 'Spacer', category: 'Media', icon: 'MoveVertical', keywords: 'spacer space gap', content: make((pm) => pm.spacer(40)) },

  // ---- Interactive ----
  { id: 'button', label: 'Button', category: 'Interactive', icon: 'MousePointerClick', keywords: 'button cta link action', content: make((pm) => pm.button('Click here', { type: 'next_step' })) },
  { id: 'button-outline', label: 'Outline button', category: 'Interactive', icon: 'SquareMousePointer', keywords: 'button outline secondary', content: make((pm) => pm.button('Learn more', { type: 'anchor', anchor: 'details' }, { variant: 'outline' })) },
  { id: 'faq', label: 'FAQ accordion', category: 'Interactive', icon: 'CircleHelp', keywords: 'faq accordion questions details', content: make((pm) => pm.faq([{ q: 'A common question?', a: 'A clear answer.' }, { q: 'Another question?', a: 'Another answer.' }])) },
  { id: 'tabs', label: 'Tabs', category: 'Interactive', icon: 'PanelsTopLeft', keywords: 'tabs panels switch', content: make((pm) => pm.tabs([{ label: 'First tab', children: [pm.text('Content of the first tab.')] }, { label: 'Second tab', children: [pm.text('Content of the second tab.')] }])) },
  { id: 'countdown-evergreen', label: 'Evergreen countdown', category: 'Interactive', icon: 'Timer', keywords: 'countdown timer evergreen minutes urgency', content: make((pm) => pm.countdown({ mode: 'evergreen', minutes: 30, label: 'Offer ends in' }, { id: 'cd' })) },
  { id: 'countdown-fixed', label: 'Countdown to a date', category: 'Interactive', icon: 'CalendarClock', keywords: 'countdown date launch deadline', content: make((pm) => pm.countdown({ mode: 'fixed', endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) + ':00Z', label: 'Launching in' }, { id: 'cd' })) },
  { id: 'progress', label: 'Progress bar', category: 'Interactive', icon: 'GaugeCircle', keywords: 'progress bar meter percent', content: make((pm) => pm.progress(60, 'Spots taken')) },
  { id: 'popup', label: 'Popup', category: 'Interactive', icon: 'AppWindow', keywords: 'popup modal dialog overlay', content: make((pm) => pm.popup('popup', [pm.heading('Wait, before you go', { level: 3 }), pm.text('Offer something useful here.'), pm.button('Yes, tell me more', { type: 'next_step' })])) },

  // ---- Conversion ----
  { id: 'form-optin', label: 'Opt-in form', category: 'Conversion', icon: 'Mail', keywords: 'form optin email lead subscribe', content: make((pm) => pm.form('form', { name: 'Opt-in form', fields: [{ id: 'name', type: 'name', label: 'First name', required: true }, { id: 'email', type: 'email', label: 'Email address', required: true }], submitLabel: 'Get instant access', consent: { enabled: true, text: 'I agree to receive emails and can unsubscribe at any time.' } })) },
  { id: 'form-contact', label: 'Contact form', category: 'Conversion', icon: 'MessageSquare', keywords: 'form contact message phone booking', content: make((pm) => pm.form('form', { name: 'Contact form', fields: [{ id: 'name', type: 'name', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }, { id: 'phone', type: 'phone', label: 'Phone (optional)', required: false }, { id: 'message', type: 'textarea', label: 'How can we help?', required: false }], submitLabel: 'Send message', consent: { enabled: true, text: 'I agree to be contacted about my request.' }, success: { type: 'message', message: 'Thank you! We will be in touch.' } })) },
  { id: 'checkout', label: 'Checkout', category: 'Conversion', icon: 'ShoppingCart', keywords: 'checkout buy product price order payment', content: make((pm) => pm.checkout('checkout', { productName: 'My product', description: 'What the buyer gets.', price: 49, buttonLabel: 'Buy now' })) },
  { id: 'order-bump', label: 'Order bump', category: 'Conversion', icon: 'PackagePlus', keywords: 'order bump add-on checkbox', content: make((pm) => pm.checkout('bump', { productName: 'Bonus add-on', description: 'Add this bonus to your order.', price: 17, orderBump: true })) },
  { id: 'upsell', label: 'One-click upsell', category: 'Conversion', icon: 'Zap', keywords: 'upsell one click offer', content: make((pm) => pm.checkout('upsell', { productName: 'Special one-time offer', description: 'Added to the order they just placed.', price: 47, oneClickUpsell: true, buttonLabel: 'Yes, add it to my order' })) },

  // ---- Cards ----
  { id: 'card-testimonial', label: 'Testimonial', category: 'Cards', icon: 'MessageSquareQuote', keywords: 'testimonial quote review card', content: make((pm) => testimonial(pm, 'A short, specific quote about the result.', 'Alex Morgan', 'Founder, Example Co', 'AM')) },
  { id: 'card-pricing', label: 'Pricing card', category: 'Cards', icon: 'Tag', keywords: 'pricing offer plan card', content: make((pm) => pricing(pm, 'Pro', '$49', ['Unlimited funnels', 'Priority support', 'Custom domain'], true)) },
  { id: 'card-feature', label: 'Feature card', category: 'Cards', icon: 'Sparkles', keywords: 'feature benefit card', content: make((pm) => feature(pm, '1', 'A benefit', 'Short, concrete description.')) },

  // ---- Navigation ----
  { id: 'navbar', label: 'Navbar', category: 'Navigation', icon: 'Navigation', keywords: 'navbar navigation header menu', content: make((pm) => pm.navbar('Your Brand', [{ label: 'Features', href: '#features' }, { label: 'Pricing', href: '#pricing' }], { label: 'Get started', action: { type: 'next_step' } })) },
  { id: 'footer', label: 'Footer', category: 'Navigation', icon: 'PanelBottom', keywords: 'footer links copyright', content: make((pm) => pm.footer('© Your Company. All rights reserved.', [{ label: 'Privacy', href: '#' }, { label: 'Terms', href: '#' }])) },

  // ---- Advanced ----
  { id: 'custom-code', label: 'Custom code', category: 'Advanced', icon: 'Code', keywords: 'code html css javascript embed', scriptsOnly: true, content: make((pm) => pm.code('<p>Custom HTML</p>', '', '', { id: 'code' })) },
];

function pricing(pm: PageBuilder, name: string, price: string, items: string[], featured: boolean): GjsNode {
  return pm.card([
    pm.eyebrow(name),
    pm.box([pm.text(price)], { name: 'Price', classes: ['fn-price-tag'] }),
    pm.list(items),
    pm.button(featured ? 'Choose Pro' : `Choose ${name}`, { type: 'next_step' }, { variant: featured ? 'primary' : 'outline', block: true }),
  ], { featured, name: 'Pricing card' });
}

/** Registers the library with the editor's block manager (the panel reads it back from there, plus the saved "My blocks"). */
export function registerBlocks(editor: Editor, opts: { canScripts: boolean }): void {
  for (const b of BLOCKS) {
    if (b.scriptsOnly && !opts.canScripts) continue;
    editor.Blocks.add(b.id, { label: b.label, category: b.category, content: b.content() as never, attributes: { 'data-icon': b.icon, 'data-keywords': b.keywords } });
  }
}
