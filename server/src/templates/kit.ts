import { field } from '../blocks/defaults.js';
import { normalizeDoc, type ProjectDoc } from '../pagemodel/doc.js';
import { createPageBuilder, type PageBuilder } from '../pagemodel/shared/build.js';
import type { GjsNode } from '../pagemodel/shared/clean.js';
import type { ButtonActionProps } from '../pagemodel/shared/props.js';

/**
 * Building blocks shared by the template library. Everything here is composed from the page builder DSL (`pm.*`): no remote images, no inline SVG (the page
 * sanitiser does not accept SVG, see ADR 0023), so illustrations are CSS compositions (gradients, rounded boxes, conic rings) that render offline and
 * can be edited in the builder like any other box. Copy colours are inherited from the section theme (light, dark, accent, soft), so a light-on-dark mistake
 * cannot happen by accident; `templates/contrast.ts` audits the explicit colours and every library test runs it.
 */
export { field, createPageBuilder };
export type { PageBuilder, GjsNode };

/** Dark hero backgrounds. Each end colour keeps >= 7:1 against the dark-theme text (#f8fafc). */
export const HERO = {
  blue: 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)',
  violet: 'linear-gradient(135deg,#1e1b4b 0%,#4c1d95 100%)',
  green: 'linear-gradient(135deg,#052e2b 0%,#0f5132 100%)',
  teal: 'linear-gradient(135deg,#042f2e 0%,#115e59 100%)',
  rose: 'linear-gradient(135deg,#4c0519 0%,#9f1239 100%)',
  amber: 'linear-gradient(135deg,#431407 0%,#92400e 100%)',
  slate: 'linear-gradient(135deg,#0f172a 0%,#334155 100%)',
  indigo: 'linear-gradient(135deg,#172554 0%,#3730a3 100%)',
  plum: 'linear-gradient(135deg,#3b0764 0%,#86198f 100%)',
  forest: 'linear-gradient(135deg,#14532d 0%,#166534 100%)',
} as const;

/** Soft pastel panels for illustrations (all dark ink on top: #0f172a). */
export const PASTEL = { blue: '#dbeafe', violet: '#ede9fe', green: '#dcfce7', amber: '#fef3c7', rose: '#ffe4e6', teal: '#ccfbf1', slate: '#e2e8f0' } as const;

export const finish = (pm: PageBuilder, sections: GjsNode[], o: Parameters<PageBuilder['project']>[1] = {}): ProjectDoc => {
  const r = normalizeDoc({ version: 2, project: pm.project(sections, o) }, { scriptsOk: true });
  if (!r.ok) throw new Error(`Invalid template document: ${JSON.stringify(r.issues)}`);
  return r.doc;
};

export const avatar = (pm: PageBuilder, initials: string, bg = '#c7d2fe', fg = '#1e1b4b'): GjsNode =>
  pm.box([pm.text(initials, { align: 'center' })], { name: 'Avatar', style: { width: '44px', height: '44px', 'border-radius': '50%', background: bg, color: fg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '700', 'flex-shrink': '0' } });

export function testimonial(pm: PageBuilder, quote: string, name: string, role: string, initials: string): GjsNode {
  return pm.card([
    pm.text(`“${quote}”`, { name: 'Quote' }),
    pm.box([avatar(pm, initials), pm.box([pm.text(`**${name}**`, {}), pm.text(role, { muted: true, size: '.9rem' })], { name: 'Person' })], { name: 'Person', style: { display: 'flex', 'align-items': 'center', gap: '12px' } }),
  ], { name: 'Testimonial' });
}

export function feature(pm: PageBuilder, num: string, title: string, body: string): GjsNode {
  return pm.card([
    pm.box([pm.text(num, { align: 'center' })], { name: 'Badge', style: { width: '40px', height: '40px', 'border-radius': '12px', background: '#dbeafe', color: '#1e3a8a', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(title, { level: 3 }),
    pm.text(body, { muted: true }),
  ], { name: 'Feature' });
}

export const footer = (pm: PageBuilder, brand = 'Your Company', extra: { label: string; href: string }[] = []): GjsNode =>
  pm.footer(`© ${brand}. All rights reserved.`, [...extra, { label: 'Privacy', href: '#' }, { label: 'Terms', href: '#' }, { label: 'Contact', href: '#' }]);

// ---- illustrations (CSS compositions) -------------------------------------------------------------------------------------------------------------------

const bar = (pm: PageBuilder, w: string, h = '10px', bg = '#e2e8f0', extra: Record<string, string> = {}): GjsNode => pm.box([], { name: 'Line', style: { width: w, height: h, background: bg, 'border-radius': '999px', ...extra } });

/** A browser window with a toolbar, a hero block, content lines and a call-to-action pill. Pure shapes, no text. */
export function browserMock(pm: PageBuilder, accent = '#2563eb', o: { tint?: string; height?: string } = {}): GjsNode {
  const dot = (c: string) => pm.box([], { name: 'Dot', style: { width: '10px', height: '10px', 'border-radius': '50%', background: c } });
  return pm.box([
    pm.box([dot('#f87171'), dot('#fbbf24'), dot('#4ade80'), bar(pm, '38%', '10px', '#e2e8f0', { 'margin-left': '12px' })], { name: 'Toolbar', style: { display: 'flex', 'align-items': 'center', gap: '6px', padding: '12px 14px', background: '#f1f5f9', 'border-bottom': '1px solid #e2e8f0' } }),
    pm.box([
      pm.box([], { name: 'Hero art', style: { height: '72px', 'border-radius': '10px', background: `linear-gradient(135deg,${accent},${o.tint ?? '#1e3a8a'})` } }),
      bar(pm, '70%', '14px', '#cbd5e1'), bar(pm, '90%'), bar(pm, '82%'),
      pm.box([], { name: 'Call to action', style: { width: '120px', height: '34px', 'border-radius': '999px', background: accent, 'margin-top': '6px' } }),
    ], { name: 'Page', style: { display: 'flex', 'flex-direction': 'column', gap: '10px', padding: '18px', background: '#ffffff', 'min-height': o.height ?? '210px' } }),
  ], { name: 'Browser mock-up', style: { 'border-radius': '14px', border: '1px solid #cbd5e1', overflow: 'hidden', 'box-shadow': '0 24px 48px -20px rgba(15,23,42,.45)', background: '#ffffff', width: '100%', 'max-width': '480px' } });
}

/** A phone with a notch, a card list and a tab bar. */
export function phoneMock(pm: PageBuilder, accent = '#2563eb', o: { tint?: string } = {}): GjsNode {
  const card = () => pm.box([pm.box([], { name: 'Thumb', style: { width: '36px', height: '36px', 'border-radius': '10px', background: PASTEL.blue } }), pm.box([bar(pm, '70%', '9px', '#cbd5e1'), bar(pm, '45%', '8px')], { name: 'Lines', style: { display: 'flex', 'flex-direction': 'column', gap: '6px', flex: '1 1 0' } })], { name: 'Row', style: { display: 'flex', gap: '10px', 'align-items': 'center', padding: '10px', background: '#f8fafc', 'border-radius': '12px' } });
  return pm.box([
    pm.box([], { name: 'Notch', style: { width: '70px', height: '8px', 'border-radius': '999px', background: '#0f172a', margin: '0 auto 14px' } }),
    pm.box([], { name: 'Header art', style: { height: '86px', 'border-radius': '14px', background: `linear-gradient(135deg,${accent},${o.tint ?? '#4c1d95'})`, 'margin-bottom': '12px' } }),
    pm.box([card(), card(), card()], { name: 'List', style: { display: 'flex', 'flex-direction': 'column', gap: '8px' } }),
    pm.box([bar(pm, '24px', '24px', accent, { 'border-radius': '8px' }), bar(pm, '24px', '24px', '#cbd5e1', { 'border-radius': '8px' }), bar(pm, '24px', '24px', '#cbd5e1', { 'border-radius': '8px' })], { name: 'Tab bar', style: { display: 'flex', 'justify-content': 'space-around', 'margin-top': '14px', 'padding-top': '12px', 'border-top': '1px solid #e2e8f0' } }),
  ], { name: 'Phone mock-up', style: { width: '240px', 'max-width': '100%', padding: '14px', 'border-radius': '34px', border: '8px solid #0f172a', background: '#ffffff', 'box-shadow': '0 28px 50px -20px rgba(15,23,42,.55)' } });
}

/** A bar chart that rises left to right. `values` are 10-100. */
export function chartMock(pm: PageBuilder, values: number[], accent = '#2563eb'): GjsNode {
  return pm.box(
    values.map((v, i) => pm.box([], { name: 'Bar', style: { flex: '1 1 0', height: `${v}%`, background: i === values.length - 1 ? accent : `${accent}66`, 'border-radius': '8px 8px 2px 2px' } })),
    { name: 'Chart', style: { display: 'flex', 'align-items': 'flex-end', gap: '10px', height: '160px', padding: '18px', background: '#ffffff', border: '1px solid #e2e8f0', 'border-radius': '14px', 'box-shadow': '0 12px 28px -16px rgba(15,23,42,.35)' } },
  );
}

/** A progress ring (conic gradient) with a number in the middle. `ink` must contrast with white. */
export function ringMock(pm: PageBuilder, percent: number, label: string, accent = '#2563eb'): GjsNode {
  return pm.box([
    pm.box([pm.text(label, { align: 'center' })], { name: 'Ring value', style: { width: '96px', height: '96px', 'border-radius': '50%', background: '#ffffff', color: '#0f172a', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800', 'font-size': '1.4rem' } }),
  ], { name: 'Progress ring', style: { width: '128px', height: '128px', 'border-radius': '50%', background: `conic-gradient(${accent} ${Math.round(percent * 3.6)}deg,#e2e8f0 0deg)`, display: 'flex', 'align-items': 'center', 'justify-content': 'center' } });
}

/** A decorative stack of overlapping soft discs for hero sides and thank-you pages. */
export function discs(pm: PageBuilder, colors: [string, string, string] = ['#93c5fd', '#c4b5fd', '#fda4af'], height = '220px'): GjsNode {
  const d = (c: string, size: string, left: string, top: string) => pm.box([], { name: 'Disc', style: { position: 'absolute', width: size, height: size, left, top, 'border-radius': '50%', background: c, opacity: '.9' } });
  return pm.box([d(colors[0], '150px', '8%', '6%'), d(colors[1], '120px', '42%', '38%'), d(colors[2], '90px', '66%', '4%')], { name: 'Illustration', style: { position: 'relative', height, width: '100%', 'min-height': height } });
}

/** A square badge with a short glyph or emoji. `bg`/`fg` must contrast (the library test checks explicit colours). */
export const iconBadge = (pm: PageBuilder, glyph: string, bg = PASTEL.blue, fg = '#1e3a8a', size = '48px'): GjsNode =>
  pm.box([pm.text(glyph, { align: 'center' })], { name: 'Icon', style: { width: size, height: size, 'border-radius': '14px', background: bg, color: fg, display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800', 'font-size': '1.25rem', 'flex-shrink': '0' } });

// ---- sections and rows ----------------------------------------------------------------------------------------------------------------------------------

export function stat(pm: PageBuilder, value: string, label: string): GjsNode {
  return pm.box([pm.heading(value, { level: 2, align: 'center' }), pm.text(label, { align: 'center', muted: true, size: '.95rem' })], { name: 'Stat', style: { display: 'flex', 'flex-direction': 'column', gap: '4px' } });
}

export const statsRow = (pm: PageBuilder, items: [string, string][]): GjsNode => pm.cols(items.map(([v, l]) => [stat(pm, v, l)]), { keep: true, gap: 'sm' });

/** Fictional wordmarks as a quiet "as seen in / trusted by" strip. */
export function logoStrip(pm: PageBuilder, title: string, names: string[]): GjsNode {
  return pm.stack([
    pm.text(title, { align: 'center', muted: true, size: '.85rem' }),
    pm.box(names.map((n) => pm.text(n, { align: 'center', muted: true, style: { 'font-weight': '800', 'letter-spacing': '.08em', 'font-size': '1.05rem' } })), { name: 'Logos', style: { display: 'flex', 'flex-wrap': 'wrap', 'justify-content': 'center', gap: '12px 36px' } }),
  ]);
}

/** Star rating line on a light background (#b45309 on white is 5.0:1). */
export const ratingLine = (pm: PageBuilder, score: string, caption: string, dark = false): GjsNode =>
  pm.box([pm.text('★★★★★', { color: dark ? '#fbbf24' : '#b45309', style: { 'letter-spacing': '.12em', 'font-size': '1.1rem' } }), pm.text(`**${score}** ${caption}`, { size: '.95rem' })], { name: 'Rating', style: { display: 'flex', 'align-items': 'center', gap: '10px', 'flex-wrap': 'wrap' } });

/** Numbered how-it-works row. */
export function stepsRow(pm: PageBuilder, items: { title: string; body: string }[]): GjsNode {
  return pm.cols(items.map((it, i) => [pm.box([
    pm.box([pm.text(String(i + 1), { align: 'center' })], { name: 'Step number', style: { width: '44px', height: '44px', 'border-radius': '50%', background: '#1d4ed8', color: '#ffffff', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } }),
    pm.heading(it.title, { level: 3 }), pm.text(it.body, { muted: true }),
  ], { name: 'Step', style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } })]));
}

/** A pricing / offer card. `cta` is a button action (e.g. an anchor to a checkout section). */
export function priceCard(pm: PageBuilder, p: { name: string; price: string; period?: string; blurb: string; features: string[]; cta: string; action?: ButtonActionProps; featured?: boolean; badge?: string }): GjsNode {
  return pm.card([
    ...(p.badge ? [pm.badgeText(p.badge)] : []),
    pm.heading(p.name, { level: 3 }),
    pm.text(`**${p.price}**${p.period ? ` ${p.period}` : ''}`, { name: 'Price', style: { 'font-size': '2.2rem' } }),
    pm.text(p.blurb, { muted: true }),
    pm.list(p.features),
    pm.button(p.cta, p.action ?? { type: 'next_step' }, { variant: p.featured ? 'primary' : 'outline', block: true }),
  ], { name: p.name, featured: p.featured });
}

export function ctaBand(pm: PageBuilder, headline: string, text: string, label: string, action: ButtonActionProps = { type: 'next_step' }): GjsNode {
  return pm.section([pm.stack([pm.heading(headline, { align: 'center', level: 2 }), pm.text(text, { align: 'center' }), pm.button(label, action, { variant: 'secondary', size: 'lg', align: 'center' })])], { theme: 'accent', padding: 'lg', width: 'medium', align: 'center', name: 'Call to action' });
}

export function faqSection(pm: PageBuilder, title: string, items: { q: string; a: string }[], theme: 'light' | 'soft' = 'soft'): GjsNode {
  return pm.section([pm.stack([pm.heading(title, { align: 'center', level: 2 }), pm.faq(items)])], { theme, padding: 'lg', width: 'small', name: 'Questions' });
}

export function thanksSection(pm: PageBuilder, o: { eyebrow?: string; title: string; text: string; bullets?: string[]; button?: { label: string; action: ButtonActionProps } }): GjsNode {
  return pm.section([
    pm.stack([
      pm.box([pm.text('✓', { align: 'center' })], { name: 'Check', style: { width: '64px', height: '64px', 'border-radius': '50%', background: '#dcfce7', color: '#14532d', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-size': '2rem', 'font-weight': '800', margin: '0 auto' } }),
      ...(o.eyebrow ? [pm.eyebrow(o.eyebrow, { align: 'center' })] : []),
      pm.heading(o.title, { level: 1, align: 'center' }),
      pm.text(o.text, { align: 'center', muted: true }),
      ...(o.bullets ? [pm.list(o.bullets, { ordered: true })] : []),
      ...(o.button ? [pm.button(o.button.label, o.button.action, { variant: 'outline', size: 'lg', align: 'center' })] : []),
    ]),
  ], { padding: 'xl', width: 'small', align: 'center', name: 'Confirmation' });
}

/** Top navigation bar: brand on the left, links and one call-to-action on the right. */
export const nav = (pm: PageBuilder, brand: string, links: [string, string][], cta?: [string, ButtonActionProps]): GjsNode =>
  pm.navbar(brand, links.map(([label, href]) => ({ label, href })), cta ? { label: cta[0], action: cta[1] } : undefined);
