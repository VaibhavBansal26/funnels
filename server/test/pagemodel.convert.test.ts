import { describe, expect, it } from 'vitest';
import { createBuilder, documentOf, field, type Block } from '../src/blocks/index.js';
import { convertDocument } from '../src/pagemodel/convert.js';
import { loadDoc, normalizeDoc, remapStepRefs } from '../src/pagemodel/doc.js';
import { renderProject } from '../src/pagemodel/render.js';
import { SEED_TEMPLATES } from '../src/templates/seed.js';
import { childrenOf, walk, wrapperOf, type GjsNode } from '../src/pagemodel/shared/clean.js';
import { buildSteps } from '../src/ai/buildFunnel.js';

const ctx = { funnelId: 'f1', stepId: 's1', stepName: 'S', steps: [{ id: 's1', href: '/one' }, { id: 's2', href: '/two' }] };
const convert = (blocks: Block[], settings = {}) => {
  const r = normalizeDoc(documentOf(blocks, settings));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.doc;
};
const nodes = (doc: ReturnType<typeof convert>, type: string): GjsNode[] => {
  const out: GjsNode[] = [];
  walk(wrapperOf(doc.project), (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
};
const html = (doc: ReturnType<typeof convert>) => renderProject(doc.project, ctx).html;

describe('legacy block document -> GrapesJS project', () => {
  const b = createBuilder('x');

  it('converts every block type', () => {
    const doc = convert([
      b.section([
        b.heading('Title **bold** and [link](https://example.com)', { level: 1, align: 'center', color: '#ff0000' }),
        b.paragraph('Para with *emphasis*', { align: 'right' }),
        b.image('https://img.example/a.png', 'An image', { width: 320, align: 'center' }),
        b.button('Go', { type: 'link', url: 'https://example.com', newTab: true }, { style: 'outline', size: 'lg', align: 'center', fullWidth: true }),
        b.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Tour'),
        b.divider(),
        b.spacer(64),
        b.list(['One', 'Two'], { ordered: true }),
        b.list(['Dot'], { icon: 'dot' }),
        b.faq([{ q: 'Q1?', a: 'A1' }]),
        b.countdown({ mode: 'fixed', endsAt: '2030-01-01T00:00:00Z', label: 'Soon' }),
        b.form({ name: 'F', fields: [field('email', 'email', 'Email', true), field('pick', 'select', 'Pick', false, { options: ['a', 'b'] })], submitLabel: 'Send', consent: true }),
        b.checkout({ productName: 'Thing', price: 49.5, currency: 'EUR', description: 'Desc' }),
        b.html('<p>custom</p>'),
      ], { background: '#0f172a', padding: 'xl', width: 'wide', align: 'center', anchor: 'top' }),
    ]);
    const types = new Set<string>();
    walk(wrapperOf(doc.project), (n) => types.add(String(n.type)));
    for (const t of ['fn-section', 'fn-row', 'fn-column', 'fn-heading', 'fn-text', 'image', 'fn-button', 'fn-video', 'fn-divider', 'fn-spacer', 'fn-list', 'fn-faq', 'fn-countdown', 'fn-form', 'fn-checkout', 'fn-code']) expect(types.has(t), t).toBe(true);
    const out = html(doc);
    expect(out).toContain('<h1');
    expect(out).toContain('<strong>'.replace('strong', 'b')); // inline formatting becomes real elements
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('fn-btn-outline');
    expect(out).toContain('fn-btn-lg');
    expect(out).toContain('fn-btn-block');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(out).toContain('<ol');
    expect(out).toContain('<summary>Q1?</summary>');
    expect(out).toContain('data-end="2030-01-01T00:00:00Z"');
    expect(out).toContain('data-fn-form');
    expect(out).toContain('€49.50');
    expect(out).toContain('<p>custom</p>');
    expect(out).toContain('id="top"'); // section anchor
    expect(out).toContain('fn-dark'); // dark background flips the section theme so copy stays readable
    expect(doc.forms).toHaveLength(1);
    expect(doc.products).toHaveLength(1);
    expect(doc.products[0]).toMatchObject({ productName: 'Thing', price: 49.5, currency: 'EUR' });
  });

  it('keeps form and checkout ids so already published pages keep posting to valid endpoints', () => {
    const fresh = createBuilder('x');
    const doc = convert([fresh.section([fresh.form({ fields: [field('email', 'email', 'E', true)] }), fresh.checkout({ productName: 'P', price: 1 })])]);
    // block ids are assigned in creation order by the builder: the form is "x1", the checkout "x2"
    expect(doc.forms[0]!.id).toBe('x1');
    expect(doc.products[0]!.id).toBe('x2');
    expect(html(doc)).toContain('/api/public/forms/f1/s1/x1');
    expect(html(doc)).toContain('/api/public/checkout/f1/s1/x2');
  });

  it('nests columns, maps ratios, widths and gaps, and flattens beyond the supported depth', () => {
    const doc = convert([
      b.section([
        b.columns([[b.heading('A')], [b.paragraph('B'), b.columns([[b.paragraph('C')], [b.paragraph('D')]])]], { gap: 'lg' }),
        b.paragraph('loose after columns'),
      ], { width: 'narrow' }),
    ]);
    const section = nodes(doc, 'fn-section')[0]!;
    expect(section.classes).toContain('fn-w-small');
    const rows = nodes(doc, 'fn-row');
    expect(rows.length).toBeGreaterThanOrEqual(3); // outer, nested, and the stack for the trailing paragraph
    expect(rows[0]!.classes).toContain('fn-gap-lg');
    expect(nodes(doc, 'fn-column').length).toBeGreaterThanOrEqual(5);
    expect(html(doc)).toMatch(/A[\s\S]*B[\s\S]*C[\s\S]*D[\s\S]*loose after columns/);
  });

  it('groups loose top-level blocks into a default section and keeps order', () => {
    const doc = convert([b.heading('First'), b.paragraph('Second'), b.section([b.paragraph('Third')])]);
    const kids = childrenOf(wrapperOf(doc.project));
    expect(kids).toHaveLength(2);
    expect(html(doc)).toMatch(/First[\s\S]*Second[\s\S]*Third/);
  });

  it('maps page settings to CSS variables on the page root', () => {
    const doc = convert([b.paragraph('x')], { accent: '#ff5500', background: '#fafafa', font: 'serif' });
    const out = renderProject(doc.project, ctx);
    expect(out.css).toMatch(/body\{[^}]*--fn-accent:#ff5500/);
    expect(out.css).toMatch(/--fn-bg:#fafafa/);
    expect(out.css).toMatch(/--fn-font:Georgia/);
  });

  it('button actions: next step, go to a step, link, anchor; step ids are remapped when a funnel is copied', () => {
    const doc = convert([b.section([b.button('Next', { type: 'next_step' }), b.button('Two', { type: 'step', stepId: 's2' }), b.button('Jump', { type: 'anchor', anchor: 'faq' }), b.button('Ext', { type: 'link', url: 'https://e.test' })])]);
    const out = html(doc);
    expect(out).toContain('href="/two"'); // next step of s1 (and the explicit go-to-s2)
    expect(out.match(/href="\/two"/g)).toHaveLength(2);
    expect(out).toContain('href="#faq"');
    const copy = remapStepRefs(doc, new Map([['s2', 'new2']]));
    expect(JSON.stringify(copy.project)).toContain('"stepId":"new2"');
    expect(JSON.stringify(remapStepRefs(doc, new Map()).project)).not.toContain('"stepId"'); // unknown target falls back to "next step"
  });

  it('tolerates unknown block types, unknown fields and malformed values (never throws)', () => {
    const messy: any = {
      version: 1,
      settings: { font: 'system', weird: 1 },
      blocks: [
        { id: 'u1', type: 'hologram', text: 'x' },
        { id: 'u2', type: 'heading', text: 'Kept', level: 99, bogusField: { deep: true }, align: 'sideways' },
        { id: 'u3', type: 'section', width: 'enormous', padding: 'huge', children: [{ id: 'u4', type: 'columns', columns: [{ id: 'c', children: null }] }, null, 5] },
      ],
    };
    const r = convertDocument(messy);
    expect(r.notes.some((n) => n.includes('hologram'))).toBe(true);
    const clean = normalizeDoc(r.project && { version: 2, project: r.project });
    expect(clean.ok).toBe(true);
    expect(JSON.stringify(r.project)).toContain('Kept');
    expect(JSON.stringify(r.project)).not.toContain('bogusField');
    expect(() => convertDocument(null)).not.toThrow();
    expect(() => convertDocument({ blocks: 'nope' })).not.toThrow();
    expect(() => convertDocument(undefined)).not.toThrow();
  });

  it('is deterministic and idempotent: same input, same output; version 2 documents are returned as they are', () => {
    const src = documentOf([b.section([b.heading('H'), b.form({ fields: [field('email', 'email', 'E', true)] })], { background: '#112233' })], { accent: '#123456' });
    const one = JSON.stringify(convertDocument(src).project);
    const two = JSON.stringify(convertDocument(JSON.parse(JSON.stringify(src))).project);
    expect(one).toBe(two);
    const doc = convert([b.heading('H')]);
    const again = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(again.ok && JSON.stringify(again.doc)).toBe(JSON.stringify(doc));
    expect(JSON.stringify(loadDoc(JSON.stringify(src)))).toBe(JSON.stringify(loadDoc(JSON.stringify(src))));
  });

  it('rejects invalid legacy documents exactly as before (the legacy schema still guards the old input path)', () => {
    expect(normalizeDoc({ version: 1, blocks: [{ id: 'a', type: 'button', text: 'x', action: { type: 'link', url: 'javascript:alert(1)' } }] }).ok).toBe(false);
    expect(normalizeDoc({ version: 7, blocks: [] }).ok).toBe(false);
    expect(normalizeDoc('nope').ok).toBe(false);
  });

  it('AI generated funnels (constrained block documents) convert into valid, renderable pages with their forms and products', () => {
    const copy = { name: 'N', steps: [{ headline: 'Head <b>x</b>', subheadline: 'sub', bullets: ['a', 'b'], cta: 'Go' }] };
    for (const kind of ['optin', 'registration', 'story', 'sales', 'upsell', 'booking', 'thankyou'] as const) {
      const [step] = buildSteps([kind], copy as never);
      const r = normalizeDoc(step!.doc);
      expect(r.ok, kind).toBe(true);
      if (!r.ok) continue;
      const out = html(r.doc);
      expect(out).toContain('<h1');
      expect(out).toContain('Head &lt;b&gt;x&lt;/b&gt;'); // model text is data, never markup
      if (kind === 'sales') expect(r.doc.products.map((p) => p.orderBump)).toEqual([false, true]);
      if (kind === 'upsell') expect(r.doc.products[0]!.oneClickUpsell).toBe(true);
      if (kind === 'optin' || kind === 'registration' || kind === 'booking') expect(r.doc.forms).toHaveLength(1);
    }
  });

  it('every seeded template is native, already clean and exposes its forms and products', () => {
    for (const t of SEED_TEMPLATES) {
      for (const s of t.steps) {
        expect(s.doc.version).toBe(2);
        const r = normalizeDoc(s.doc);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        expect(r.doc.forms).toEqual(s.doc.forms);
        expect(r.doc.products).toEqual(s.doc.products);
      }
    }
  });
});
