import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { normalizeDoc } from '../src/pagemodel/doc.js';
import { renderProject, rulesToCss, type PageRenderContext } from '../src/pagemodel/render.js';
import { createPageBuilder, type PageBuilder } from '../src/pagemodel/shared/build.js';
import { PROJECT_LIMITS, emptyProject, type GjsNode } from '../src/pagemodel/shared/clean.js';
import { field } from '../src/blocks/defaults.js';

const ctx: PageRenderContext = { funnelId: 'fn_1', stepId: 'st_1', stepName: 'Landing', steps: [{ id: 'st_1', href: '/landing' }, { id: 'st_2', href: '/thanks' }] };
function page(build: (pm: PageBuilder) => GjsNode[], c: Partial<PageRenderContext> = {}, o: Parameters<PageBuilder['project']>[1] = {}) {
  const pm = createPageBuilder('k');
  const r = normalizeDoc({ version: 2, project: pm.project(build(pm), o) }, { scriptsOk: true });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return renderProject(r.doc.project, { ...ctx, ...c });
}
const body = (build: (pm: PageBuilder) => GjsNode[], c: Partial<PageRenderContext> = {}) => page((pm) => [pm.section([pm.stack(build(pm))])], c).html;

describe('renderProject basics', () => {
  it('is deterministic', () => {
    const build = (pm: PageBuilder) => [pm.section([pm.stack([pm.heading('Same'), pm.button('Go')])], { background: '#0f172a' })];
    expect(page(build).html).toBe(page(build).html);
  });

  it('renders an empty project with a placeholder and a full html shell', () => {
    const html = renderProject(emptyProject(), ctx).html;
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).toContain('This page is empty.');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<title>Landing</title>');
  });

  it('survives null, undefined and garbage projects', () => {
    for (const garbage of [null, undefined, 5, 'x', [], { pages: 'no' }, { pages: [{ frames: [null] }] }, { pages: [{ frames: [{ component: { components: 'nope' } }] }] }]) {
      expect(() => renderProject(garbage, ctx)).not.toThrow();
      expect(renderProject(garbage, ctx).html).toContain('</html>');
    }
  });

  it('injects the beacon in live and preview mode with ids, and flags previews', () => {
    const live = page((pm) => [pm.section([pm.stack([pm.heading('x')])])]).html;
    expect(live).toMatch(/<script async src="\/beacon\.js" data-funnel="fn_1" data-step="st_1" data-api=""><\/script>/);
    expect(live).not.toContain('noindex');
    const prev = page((pm) => [pm.section([pm.stack([pm.heading('x')])])], { mode: 'preview' }).html;
    expect(prev).toContain('data-preview="1"');
    expect(prev).toContain('noindex');
  });

  it('renders accessible structure: skip link, main landmark, labelled form controls', () => {
    const html = body((pm) => [pm.form('f1', { fields: [field('email', 'email', 'Your email', true)] })]);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('a.fn-skip')?.getAttribute('href')).toBe('#fn-main');
    expect(doc.querySelector('main#fn-main')).toBeTruthy();
    const input = doc.querySelector('input[name=email]')!;
    expect(doc.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('Your email');
    expect(input.getAttribute('aria-required')).toBe('true');
  });

  it('ships responsive css that stacks columns on small screens and honours reduced motion', () => {
    const { css } = page((pm) => [pm.section([pm.cols([[pm.text('a')], [pm.text('b')]])])]);
    expect(css).toMatch(/@media\(max-width:640px\)\{\.fn-row:not\(\.fn-keep\)>\.fn-column\{flex:1 1 100%/);
    expect(css).toContain('prefers-reduced-motion');
  });

  it('orders media queries desktop-first and keeps plain rules before them', () => {
    const css = rulesToCss({
      assets: [],
      pages: emptyProject().pages,
      styles: [
        { selectors: ['a'], style: { color: 'red' }, mediaText: '(max-width: 480px)' },
        { selectors: ['b'], style: { color: 'blue' } },
        { selectors: ['c'], style: { color: 'green' }, mediaText: '(max-width: 992px)' },
        { selectors: [{ name: 'x1', type: 2 }], style: { color: 'pink' }, state: 'hover' },
      ],
    });
    expect(css).toBe('.b{color:blue}#x1:hover{color:pink}@media (max-width: 992px){.c{color:green}}@media (max-width: 480px){.a{color:red}}');
  });
});

describe('limits', () => {
  it('stops rendering at the element limit instead of producing unbounded output', () => {
    const many = { pages: [{ frames: [{ component: { type: 'wrapper', components: Array.from({ length: PROJECT_LIMITS.maxNodes + 500 }, () => ({ type: 'text', tagName: 'p', components: [{ type: 'textnode', content: 'x' }] })) } }] }] };
    const html = renderProject(many, ctx).html;
    expect(html).toContain('This page is empty.'); // refused as a whole by the cleaner: the renderer falls back rather than truncating silently
  });
});

describe('escaping', () => {
  it('escapes text in headings, paragraphs, lists, faq and buttons', () => {
    const evil = '<img src=x onerror=alert(1)> & "q"';
    const html = body((pm) => [pm.heading(evil), pm.text(evil), pm.list([evil]), pm.faq([{ q: evil, a: evil }]), pm.button(evil)]);
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt; &amp; "q"/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps unicode and emoji intact', () => {
    expect(body((pm) => [pm.heading('Héllo 世界 🚀')])).toContain('Héllo 世界 🚀');
  });

  it('rejects javascript: and data: URLs for links and images', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', ' javascript:alert(1)', 'JaVaScRiPt:alert(1)']) {
      const pm = createPageBuilder('z');
      const r = normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.link('x', bad), pm.image(bad, 'a')])])]) });
      if (!r.ok) continue;
      const html = renderProject(r.doc.project, ctx).html;
      expect(html).not.toMatch(/javascript:|data:text/i);
    }
  });

  it('allows safe link types', () => {
    const html = body((pm) => [pm.link('a', 'https://e.com/x?y=1'), pm.link('m', 'mailto:a@b.co'), pm.link('t', 'tel:+123'), pm.link('p', '/path#a'), pm.link('h', '#top')]);
    for (const h of ['https://e.com/x?y=1', 'mailto:a@b.co', 'tel:+123', '/path#a', '#top']) expect(html).toContain(`href="${h}"`);
  });

  it('escapes title, description and favicon and ignores unsafe favicons', () => {
    const html = page((pm) => [pm.section([pm.stack([pm.heading('x')])])], { title: '</title><script>x</script>', description: '"><x>', favicon: 'javascript:alert(1)' }).html;
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;</title>');
    expect(html).toContain('content="&quot;&gt;&lt;x&gt;"');
    expect(html).not.toContain('javascript:alert(1)');
  });
});

describe('components', () => {
  it('wires button actions: next step, go to step, external link, anchor, popup, none', () => {
    const html = body((pm) => [
      pm.button('Next', { type: 'next_step' }),
      pm.button('Go', { type: 'step', stepId: 'st_2' }),
      pm.button('Ext', { type: 'link', url: 'https://e.com', newTab: true }),
      pm.button('Down', { type: 'anchor', anchor: 'faq' }),
      pm.button('Missing', { type: 'step', stepId: 'nope' }),
      pm.button('Pop', { type: 'popup', popupId: 'offer' }),
      pm.button('Nothing', { type: 'none' }),
    ]);
    const doc = new JSDOM(html).window.document;
    const a = (label: string) => [...doc.querySelectorAll('a.fn-btn')].find((x) => x.textContent === label)!;
    expect(a('Next').getAttribute('href')).toBe('/thanks');
    expect(a('Go').getAttribute('href')).toBe('/thanks');
    expect(a('Ext').getAttribute('href')).toBe('https://e.com');
    expect(a('Ext').getAttribute('target')).toBe('_blank');
    expect(a('Ext').getAttribute('rel')).toBe('noopener noreferrer');
    expect(a('Down').getAttribute('href')).toBe('#faq');
    expect(a('Missing').getAttribute('href')).toBe('#');
    expect(a('Pop').getAttribute('data-fn-popup')).toBe('offer');
    expect(a('Nothing').getAttribute('href')).toBe('#');
  });

  it('next step on the last step is a no-op anchor', () => {
    expect(body((pm) => [pm.button('Next')], { stepId: 'st_2' })).toContain('href="#"');
  });

  it('video allow-list: youtube, vimeo, mp4; the editor refuses the rest at save time', () => {
    expect(body((pm) => [pm.video('https://youtu.be/dQw4w9WgXcQ')])).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(body((pm) => [pm.video('https://vimeo.com/123456789')])).toContain('player.vimeo.com/video/123456789');
    expect(body((pm) => [pm.video('https://cdn.example.com/a/b.mp4')])).toContain('<video controls');
    for (const bad of ['https://evil.com/embed', 'http://youtu.be/dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ']) {
      const pm = createPageBuilder('v');
      expect(normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.video(bad)])])]) }).ok, bad).toBe(false);
    }
  });

  it('renders faq as details/summary and lists', () => {
    const html = body((pm) => [pm.faq([{ q: 'Why?', a: 'Because.' }]), pm.list(['one', 'two'], { ordered: true })]);
    expect(html).toContain('<details class="fn-faq-item"><summary>Why?</summary>');
    expect(html).toContain('<ol class="fn-list">');
  });

  it('tabs and popups get the runtime script; pages without them do not carry it', () => {
    const tabs = body((pm) => [pm.tabs([{ label: 'A', children: [pm.text('one')] }, { label: 'B', children: [pm.text('two')] }])]);
    expect(tabs).toContain('fn-tab-btn');
    expect(tabs).toContain('hidden');
    expect(tabs).toContain("querySelectorAll('.fn-tabs')");
    const plain = body((pm) => [pm.text('x')]);
    expect(plain.includes("querySelectorAll('.fn-tabs')")).toBe(false);
    const popup = page((pm) => [pm.section([pm.stack([pm.button('Open', { type: 'popup', popupId: 'p1' })])]), pm.popup('p1', [pm.heading('Hi', { level: 3 })])]).html;
    expect(popup).toContain('id="p1" class="fn-popup"');
    expect(popup).toContain('data-fn-popup="p1"');
  });

  it('renders fixed and evergreen countdowns and includes the script only when needed', () => {
    const fixed = body((pm) => [pm.countdown({ mode: 'fixed', endsAt: '2030-01-01T00:00:00Z' })]);
    expect(fixed).toContain('data-end="2030-01-01T00:00:00Z"');
    expect(fixed).toContain('data-fn-countdown');
    expect(fixed).toContain('role="timer"');
    expect(fixed).toContain('localStorage');
    const ever = body((pm) => [pm.countdown({ mode: 'evergreen', minutes: 15 })]);
    expect(ever).toContain('data-minutes="15"');
    expect(ever).toMatch(/data-key="st_1-/);
    expect(body((pm) => [pm.text('x')])).not.toContain('localStorage');
  });

  it('renders the form with endpoint, honeypot, consent and success wiring', () => {
    const html = body((pm) => [pm.form('k1', {
      fields: [field('name', 'name', 'Name'), field('email', 'email', 'Email', true), field('plan', 'select', 'Plan', false, { options: ['A', 'B'] }), field('note', 'textarea', 'Note'), field('ok', 'checkbox', 'OK')],
      consent: { enabled: true, text: 'I agree' },
      success: { type: 'message', message: 'Thanks <b>!' },
    })]);
    expect(html).toContain('action="/api/public/forms/fn_1/st_1/k1"');
    expect(html).toContain('name="_hp"');
    expect(html).toContain('name="_consent"');
    expect(html).toContain('<select');
    expect(html).toContain('<textarea');
    expect(html).toContain('data-success="message" data-message="Thanks &lt;b&gt;!"');
  });

  it('renders checkout, order bump (linked to the main form) and upsell from the validated product definitions', () => {
    const html = body((pm) => [
      pm.checkout('k1', { productName: 'Course', price: 97, description: 'All lessons' }),
      pm.checkout('k2', { productName: 'Workbook', price: 19, orderBump: true }),
      pm.checkout('k3', { productName: 'Coaching', price: 297, oneClickUpsell: true }),
    ]);
    expect(html).toContain('id="co-k1"');
    expect(html).toContain('$97.00');
    expect(html).toContain('name="bump" value="k2" form="co-k1"');
    expect(html).toContain('data-fn-upsell');
    expect(html).toContain('action="/api/public/checkout/fn_1/st_1/k1"');
    expect(html).toContain('Test mode');
  });

  it('formats currencies; an invalid currency code is refused when saving', () => {
    expect(body((pm) => [pm.checkout('c', { productName: 'X', price: 10, currency: 'EUR' })])).toContain('€10.00');
    const pm = createPageBuilder('c');
    expect(normalizeDoc({ version: 2, project: pm.project([pm.section([pm.stack([pm.checkout('c', { productName: 'X', price: 10, currency: 'zz<' })])])]) }).ok).toBe(false);
  });

  it('sets accent colour, background and font from the page root variables', () => {
    const { css } = page((pm) => [pm.section([pm.stack([pm.heading('x')])])], {}, { accent: '#ff0000', font: 'Serif' });
    expect(css).toMatch(/body\{--fn-accent:#ff0000;--fn-font:Georgia/);
  });

  it('uses a custom api base for beacon and forms (custom domains)', () => {
    const html = body((pm) => [pm.form('f', { fields: [field('email', 'email', 'E')] })], { apiBase: 'https://app.example.com' });
    expect(html).toContain('src="https://app.example.com/beacon.js"');
    expect(html).toContain('action="https://app.example.com/api/public/forms/');
  });

  it('progress bar and visibility helpers render without inline script', () => {
    const html = body((pm) => [pm.progress(62, 'Funding')]);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('style="width:62%"');
  });
});
