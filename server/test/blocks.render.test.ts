import { beforeEach, describe, expect, it } from 'vitest';
import { createBuilder, defaultStepDocument, documentOf, field, inline, LIMITS, renderPage, type Block, type RenderContext } from '../src/blocks/index.js';

const ctx: RenderContext = {
  funnelId: 'fn_1',
  stepId: 'st_1',
  stepName: 'Landing',
  steps: [
    { id: 'st_1', href: '/landing' },
    { id: 'st_2', href: '/thanks' },
  ],
};
const render = (blocks: unknown[], c: Partial<RenderContext> = {}) => renderPage({ version: 1, settings: { font: 'system' }, blocks }, { ...ctx, ...c });

describe('renderPage basics', () => {
  it('is deterministic', () => {
    const doc = defaultStepDocument('Hello');
    expect(renderPage(doc, ctx)).toBe(renderPage(structuredClone(doc), ctx));
  });

  it('renders an empty document with a placeholder and a full html shell', () => {
    const html = render([]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('This page is empty.');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('lang="en"');
  });

  it('survives null, undefined and garbage documents', () => {
    for (const bad of [null, undefined, 42, 'x', [], { blocks: 'nope' }, { blocks: [null, 3, 'a'] }]) {
      expect(() => renderPage(bad, ctx)).not.toThrow();
    }
  });

  it('injects the beacon in live mode with ids, and omits it in builder mode', () => {
    const live = render([]);
    expect(live).toContain('src="/beacon.js"');
    expect(live).toContain('data-funnel="fn_1"');
    expect(live).toContain('data-step="st_1"');
    expect(live).not.toContain('data-preview');
    expect(render([], { mode: 'preview' })).toContain('data-preview="1"');
    expect(render([], { mode: 'preview' })).toContain('noindex');
    expect(render([], { mode: 'builder' })).not.toContain('beacon.js');
  });

  it('skips unknown block types without leaking their content', () => {
    const html = render([{ id: 'x', type: 'carousel', secret: '<b>boom</b>' }, { id: 'h', type: 'heading', text: 'Visible', level: 2 }]);
    expect(html).toContain('Visible');
    expect(html).toContain('<!-- unsupported block -->');
    expect(html).not.toContain('boom');
  });

  it('renders accessible structure: skip link, main landmark, labelled form controls', () => {
    const b = createBuilder('t');
    const html = render([b.form({ fields: [field('email', 'email', 'Email', true)] })]);
    expect(html).toContain('class="fn-skip" href="#fn-main"');
    expect(html).toContain('<main id="fn-main">');
    expect(html).toMatch(/<label for="f-t1-email">Email/);
    expect(html).toContain('id="f-t1-email"');
    expect(html).toContain('aria-live="polite"');
  });

  it('includes responsive css', () => {
    expect(render([])).toContain('@media(max-width:640px)');
  });
});

describe('limits', () => {
  it('truncates huge documents at the block limit', () => {
    const blocks = Array.from({ length: LIMITS.maxBlocks + 100 }, (_, i) => ({ id: `p${i}`, type: 'paragraph', text: `para-${i}` }));
    const html = render(blocks);
    expect(html).toContain(`para-${LIMITS.maxBlocks - 1}`);
    expect(html).not.toContain(`para-${LIMITS.maxBlocks}<`);
    expect(html).toContain('limit reached');
  });

  it('drops nesting deeper than the limit', () => {
    let inner: unknown = { id: 'deep', type: 'paragraph', text: 'too-deep-text' };
    for (let i = 0; i < 8; i++) inner = { id: `s${i}`, type: 'section', children: [inner] };
    const html = render([inner]);
    expect(html).not.toContain('too-deep-text');
    expect(html).toContain('limit reached');
  });

  it('renders nested columns up to the limit', () => {
    const b = createBuilder('n');
    const html = render([b.section([b.columns([[b.heading('Left')], [b.columns([[b.heading('InnerA')], [b.heading('InnerB')]])]])])]);
    expect(html).toContain('Left');
    expect(html).toContain('InnerA');
    expect((html.match(/class="fn-cols/g) ?? []).length).toBe(2);
  });

  it('caps columns at five', () => {
    const b = createBuilder('c');
    const html = render([b.columns(Array.from({ length: 8 }, (_, i) => [b.heading(`col${i}`)]))]);
    expect((html.match(/class="fn-col"/g) ?? []).length).toBe(5);
  });
});

describe('XSS escaping', () => {
  const payloads = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'; alert(1); //", '</style><script>x</script>', '‮<b>rtl</b>', '`${alert(1)}`'];

  it('escapes text in headings, paragraphs, lists, faq, buttons', () => {
    for (const p of payloads) {
      const b = createBuilder('x');
      const html = render([b.heading(p), b.paragraph(p), b.list([p]), b.faq([{ q: p, a: p }]), b.button(p)]);
      expect(html).not.toContain('<script>alert');
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('</style><script>x');
      expect(html).not.toMatch(/<[^>]*onerror=/);
    }
  });

  it('keeps unicode and emoji intact', () => {
    const html = render([{ id: 'h', type: 'heading', text: 'Grüße 你好 🚀 ñ', level: 1 }]);
    expect(html).toContain('Grüße 你好 🚀 ñ');
  });

  it('cannot break out of attributes via alt, title, placeholders or ids', () => {
    const b = createBuilder('x');
    const evil = '" onmouseover="alert(1)" x="';
    const html = render([
      { id: 'i', type: 'image', src: 'https://e.com/a.png', alt: evil },
      b.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ', evil),
      b.form({ fields: [field('email', 'email', evil, true, { placeholder: evil })] }),
    ]);
    expect(html).not.toMatch(/onmouseover="alert/);
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)&quot;');
  });

  it('rejects javascript: and data: URLs for links, buttons and images', () => {
    const urls = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', '//evil.com', '\u0000javascript:alert(1)', 'ｊavascript:alert(1)'];
    for (const u of urls) {
      const html = render([
        { id: 'b', type: 'button', text: 'Go', action: { type: 'link', url: u } },
        { id: 'i', type: 'image', src: 'https://e.com/a.png', alt: '', href: u },
        { id: 'p', type: 'paragraph', text: `[click](${u})` },
        { id: 'im', type: 'image', src: u, alt: 'x' },
      ]);
      expect(html.toLowerCase()).not.toMatch(/href="javascript|href="data:text|href="vbscript|href="\/\/evil|src="javascript|src="data:text/);
    }
  });

  it('allows safe link types', () => {
    const html = render([{ id: 'p', type: 'paragraph', text: '[a](https://ok.com/x?a=1&b=2) [m](mailto:a@b.co)' }]);
    expect(html).toContain('href="https://ok.com/x?a=1&amp;b=2"');
    expect(html).toContain('href="mailto:a@b.co"');
  });

  it('neutralises css injection through colors and custom css', () => {
    const html = render(
      [{ id: 'h', type: 'heading', text: 'x', color: 'red;background:url(javascript:alert(1))' }, { id: 's', type: 'section', background: '"><script>', children: [] }],
      { customCss: 'body{color:red}</style><script>alert(1)</script>' },
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('url(javascript');
  });

  it('escapes title, description and favicon', () => {
    const html = render([], { title: '</title><script>1</script>', description: '"><script>2</script>', favicon: 'javascript:alert(1)' });
    expect(html).not.toContain('<script>1');
    expect(html).not.toContain('<script>2');
    expect(html).not.toContain('href="javascript');
  });

  it('inline() only formats with escaped output', () => {
    expect(inline('**<b>**')).toBe('<strong>&lt;b&gt;</strong>');
    expect(inline('a\nb')).toBe('a<br>b');
    expect(inline('[x](javascript:alert(1))')).not.toContain('<a');
  });
});

describe('custom html block and tracking code', () => {
  const doc = [{ id: 'h', type: 'html', html: '<p onclick="x()">hi</p><script>alert(1)</script>' }];
  it('strips scripts and handlers by default', () => {
    const html = render(doc);
    expect(html).toContain('<p>hi</p>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert(1)');
  });
  it('keeps them when allowScripts is on (owner opt-in)', () => {
    const html = render(doc, { allowScripts: true });
    expect(html).toContain('onclick="x()"');
    expect(html).toContain('<script>alert(1)</script>');
  });
  it('injects tracking code only when allowed', () => {
    const c = { headerCode: '<script>HEAD</script>', footerCode: '<script>FOOT</script>' };
    expect(render([], c)).not.toContain('HEAD');
    const html = render([], { ...c, allowTrackingCode: true });
    expect(html.indexOf('HEAD')).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('FOOT');
  });
});

describe('blocks', () => {
  let b = createBuilder('k');
  beforeEach(() => {
    b = createBuilder('k');
  });

  it('wires button actions', () => {
    const html = render([
      b.button('Next', { type: 'next_step' }),
      b.button('Go', { type: 'step', stepId: 'st_2' }),
      b.button('Ext', { type: 'link', url: 'https://e.com', newTab: true }),
      b.button('Down', { type: 'anchor', anchor: 'faq' }),
      b.button('Missing', { type: 'step', stepId: 'nope' }),
    ]);
    expect(html).toContain('href="/thanks">Next');
    expect(html).toContain('href="/thanks">Go');
    expect(html).toContain('href="https://e.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="#faq">Down');
    expect(html).toContain('href="#">Missing');
  });

  it('next step on the last step is a no-op anchor', () => {
    expect(render([b.button('Next')], { stepId: 'st_2' })).toContain('href="#">Next');
  });

  it('video allow-list: youtube, vimeo, mp4; rejects others', () => {
    expect(render([b.video('https://youtu.be/dQw4w9WgXcQ')])).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(render([b.video('https://vimeo.com/123456789')])).toContain('player.vimeo.com/video/123456789');
    expect(render([b.video('https://cdn.example.com/a/b.mp4')])).toContain('<video controls');
    for (const bad of ['https://evil.com/embed', 'http://youtu.be/dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ']) {
      const html = render([b.video(bad)]);
      expect(html).not.toContain('<iframe');
      expect(html).toContain('video: source not allowed');
    }
  });

  it('renders faq as details/summary and lists', () => {
    const html = render([b.faq([{ q: 'Why?', a: 'Because.' }]), b.list(['one', 'two'], { ordered: true })]);
    expect(html).toContain('<details><summary>Why?</summary>');
    expect(html).toContain('<ol class="fn-list">');
  });

  it('renders fixed and evergreen countdowns and includes the script only when needed', () => {
    const fixed = render([b.countdown({ mode: 'fixed', endsAt: '2030-01-01T00:00:00Z' })]);
    expect(fixed).toContain('data-end="2030-01-01T00:00:00Z"');
    expect(fixed).toContain('data-fn-countdown');
    expect(fixed).toContain('role="timer"');
    const ever = render([b.countdown({ mode: 'evergreen', minutes: 15 })]);
    expect(ever).toContain('data-minutes="15"');
    expect(ever).toContain('data-key="st_1-');
    expect(render([b.paragraph('x')])).not.toContain('localStorage');
    expect(render([b.countdown({ mode: 'evergreen', minutes: 15 })], { mode: 'builder' })).not.toContain('localStorage');
  });

  it('renders the form with endpoint, honeypot, consent and success wiring', () => {
    const html = render([
      b.form({
        fields: [field('name', 'name', 'Name'), field('email', 'email', 'Email', true), field('plan', 'select', 'Plan', false, { options: ['A', 'B'] }), field('note', 'textarea', 'Note'), field('ok', 'checkbox', 'OK')],
        consent: true,
        success: { type: 'message', message: 'Thanks <b>!' },
      }),
    ]);
    expect(html).toContain('action="/api/public/forms/fn_1/st_1/k1"');
    expect(html).toContain('name="_hp"');
    expect(html).toContain('name="_consent"');
    expect(html).toContain('<select');
    expect(html).toContain('<textarea');
    expect(html).toContain('data-success="message" data-message="Thanks &lt;b&gt;!"');
  });

  it('renders checkout, order bump (linked to the main form) and upsell', () => {
    const html = render([
      b.checkout({ productName: 'Course', price: 97, description: 'All lessons' }),
      b.checkout({ productName: 'Workbook', price: 19, orderBump: true }),
      b.checkout({ productName: 'Coaching', price: 297, oneClickUpsell: true }),
    ]);
    expect(html).toContain('id="co-k1"');
    expect(html).toContain('$97.00');
    expect(html).toContain('name="bump" value="k2" form="co-k1"');
    expect(html).toContain('data-fn-upsell');
    expect(html).toContain('action="/api/public/checkout/fn_1/st_1/k1"');
    expect(html).toContain('Test mode');
  });

  it('formats currencies and survives an invalid currency code', () => {
    expect(render([b.checkout({ productName: 'X', price: 10, currency: 'EUR' })])).toContain('€10.00');
    expect(render([{ id: 'c', type: 'checkout', productName: 'X', price: 10, currency: 'zz<' }])).toContain('$10.00');
  });

  it('sets accent color and font from document settings', () => {
    const html = renderPage(documentOf([], { accent: '#ff0000', font: 'serif' }), ctx);
    expect(html).toContain('--fn-accent:#ff0000');
    expect(html).toContain('fn-font-serif');
  });

  it('uses a custom api base for beacon and forms (custom domains)', () => {
    const html = render([b.form({ fields: [field('email', 'email', 'E')] })], { apiBase: 'https://app.example.com' });
    expect(html).toContain('src="https://app.example.com/beacon.js"');
    expect(html).toContain('action="https://app.example.com/api/public/forms/');
  });
});
