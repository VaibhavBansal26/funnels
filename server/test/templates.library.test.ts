import { describe, expect, it } from 'vitest';
import { normalizeDoc } from '../src/pagemodel/doc.js';
import { renderProject } from '../src/pagemodel/render.js';
import { walk, wrapperOf, type GjsNode } from '../src/pagemodel/shared/clean.js';
import { isValidPath, pathKey } from '../src/services/paths.js';
import { auditContrast } from '../src/templates/contrast.js';
import { CATEGORIES, SEED_TEMPLATES } from '../src/templates/seed.js';
import { STEP_KINDS, TEMPLATE_GOALS } from '../src/templates/types.js';
import { fromTemplate, makeHarness } from './helpers.js';

// The template library (docs/TEMPLATES.md): every built-in template is checked as data (no database), then a sample is used through the API.
describe('template library', () => {
  it('has at least 24 templates with unique slugs and complete metadata', () => {
    expect(SEED_TEMPLATES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(SEED_TEMPLATES.map((t) => t.slug)).size).toBe(SEED_TEMPLATES.length);
    expect(new Set(SEED_TEMPLATES.map((t) => t.name)).size).toBe(SEED_TEMPLATES.length);
    for (const t of SEED_TEMPLATES) {
      expect(t.slug, t.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/);
      expect(Number.isInteger(t.version) && t.version >= 1, `${t.slug} version`).toBe(true);
      expect(CATEGORIES.map((c) => c.slug), `${t.slug} category`).toContain(t.category);
      expect(t.industry, `${t.slug} industry`).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      expect(TEMPLATE_GOALS, `${t.slug} goal`).toContain(t.goal);
      expect(t.description.length, `${t.slug} description`).toBeGreaterThan(30);
      expect(t.description.length).toBeLessThanOrEqual(400);
      expect(t.tags.length, `${t.slug} tags`).toBeGreaterThanOrEqual(2);
      expect(t.tags.length).toBeLessThanOrEqual(12);
      expect(t.accent, `${t.slug} accent`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(isValidPath(t.basePath), `${t.slug} basePath`).toBe(true);
    }
    for (const c of CATEGORIES) expect(SEED_TEMPLATES.some((t) => t.category === c.slug), `category ${c.slug} is empty`).toBe(true);
  });

  it('covers the required use cases', () => {
    const have = new Set(SEED_TEMPLATES.map((t) => t.slug));
    const need = [
      'lead-magnet', 'lead-magnet-checklist', 'webinar-registration', 'webinar-replay', 'product-launch', 'sales-page-bump-upsell', 'ecommerce-single-product', 'saas-free-trial', 'saas-demo-booking',
      'book-a-call', 'application-funnel', 'local-dentist', 'local-gym', 'local-restaurant-bakery', 'local-real-estate', 'local-home-services', 'event-ticketing', 'online-course-membership',
      'coaching-program', 'newsletter-signup', 'waitlist-prelaunch', 'giveaway-contest', 'app-download', 'survey-quiz', 'donation-nonprofit', 'agency-lead-gen', 'upsell-downsell-pack', 'thank-you-page',
    ];
    expect(need.filter((s) => !have.has(s))).toEqual([]);
  });

  describe.each(SEED_TEMPLATES.map((t) => [t.slug, t] as const))('%s', (_slug, t) => {
    it('has valid, unique step paths, known step kinds and, for a checkout, a final thank-you step', () => {
      expect(t.steps.length).toBeGreaterThan(0);
      expect(new Set(t.steps.map((s) => pathKey(s.path))).size).toBe(t.steps.length);
      expect(new Set(t.steps.map((s) => s.name)).size).toBe(t.steps.length);
      for (const s of t.steps) {
        expect(isValidPath(s.path), `${s.name}: ${s.path}`).toBe(true);
        expect(STEP_KINDS).toContain(s.kind);
      }
      expect(t.steps[0]!.path).toBe(t.basePath);
      if (t.products.length) expect(t.steps.at(-1)!.kind).toBe('thankyou');
    });

    it('validates through the page pipeline and is already clean (cleaning changes nothing)', () => {
      for (const s of t.steps) {
        const r = normalizeDoc(s.doc);
        expect(r.ok, `${s.name}: ${JSON.stringify(r.ok ? '' : r.issues)}`).toBe(true);
        expect(JSON.stringify((r as { doc: typeof s.doc }).doc.project), s.name).toBe(JSON.stringify(s.doc.project));
        expect(JSON.stringify(s.doc).length, `${s.name} size`).toBeLessThan(450_000);
      }
    });

    it('renders: one h1, no scripts, no remote images or css urls, anchors resolve', () => {
      for (const [i, s] of t.steps.entries()) {
        const { html } = renderProject(s.doc.project, { funnelId: 'f', stepId: `s${i}`, stepName: s.name, steps: t.steps.map((x, j) => ({ id: `s${j}`, href: x.path })) });
        expect((html.match(/<h1[\s>]/g) ?? []).length, `${s.name}: exactly one h1`).toBe(1);
        expect(html).not.toMatch(/<script[^>]*>\s*alert/i);
        expect(html).not.toMatch(/<img[^>]+src="https?:/i);
        expect(JSON.stringify(s.doc.project.styles)).not.toMatch(/url\(/);
        const ids = new Set<string>();
        const anchors: string[] = [];
        walk(wrapperOf(s.doc.project), (n: GjsNode) => {
          const id = ((n.attributes as Record<string, string> | undefined) ?? {}).id;
          if (id) ids.add(id);
          const a = n.fnAction as { type?: string; anchor?: string } | undefined;
          if (a?.type === 'anchor' && a.anchor) anchors.push(a.anchor);
          if (n.type === 'image') expect(((n.attributes as Record<string, string>) ?? {}).alt, `${s.name}: image alt text`).toBeTruthy();
        });
        for (const a of anchors) expect(a === 'top' || ids.has(a), `${s.name}: anchor #${a} has no target`).toBe(true);
      }
    });

    it('meets WCAG AA contrast for every explicit colour pairing', () => {
      for (const s of t.steps) expect(auditContrast(s.doc.project), s.name).toEqual([]);
    });

    it('is responsive: no fixed width wider than a phone without a max-width', () => {
      for (const s of t.steps) {
        for (const r of s.doc.project.styles) {
          const w = /^(\d+)px$/.exec(r.style.width ?? '')?.[1];
          if (w && Number(w) > 560) expect(r.style['max-width'], `${s.name}: width ${w}px`).toBeTruthy();
        }
      }
    });

    it('declares product slots that match its checkout blocks and their roles', () => {
      const slots = new Map(t.products.map((p) => [p.key, p]));
      expect(slots.size).toBe(t.products.length);
      const used = new Set<string>();
      for (const s of t.steps) {
        for (const p of s.doc.products) {
          expect(p.slot, `${s.name}: checkout ${p.id} needs a slot`).toBeTruthy();
          const slot = slots.get(p.slot!);
          expect(slot, `${s.name}: slot ${p.slot} is not declared`).toBeTruthy();
          used.add(p.slot!);
          const role = p.orderBump ? 'bump' : p.oneClickUpsell ? (p.downsell ? 'downsell' : 'upsell') : 'main';
          expect(slot!.role, `${s.name}: slot ${p.slot}`).toBe(role);
          expect(p.currency).toBe(slot!.currency);
          expect(p.price).toBe(slot!.amount);
        }
      }
      expect([...slots.keys()].filter((k) => !used.has(k))).toEqual([]);
      if (t.products.length) expect(t.products.some((p) => p.role === 'main') || t.products.every((p) => p.role === 'upsell' || p.role === 'downsell'), 'a checkout template has a main product (or is an upsell pack)').toBe(true);
    });
  });
});

describe('template library through the API', () => {
  it('every template can be used, opens as a native page and renders for visitors', async () => {
    const h = await makeHarness({ env: { BILLING_ENFORCE_LIMITS: 'false' } });
    const u = await h.register();
    const list = (await h.call('GET', '/api/templates?limit=100', { token: u.token })).json;
    expect(list.pagination.total).toBe(SEED_TEMPLATES.length);
    for (const t of SEED_TEMPLATES) {
      const f = await fromTemplate(h, u.token, t.slug);
      expect(f.steps.map((s: { name: string }) => s.name)).toEqual(t.steps.map((s) => s.name));
      const page = (await h.call('GET', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, { token: u.token })).json;
      expect(page.format).toBe('grapesjs');
      expect(page.doc.version).toBe(2);
      const html = (await h.call('GET', `/api/funnels/${f.id}/steps/${f.steps[0].id}/html`, { token: u.token })).json.html as string;
      expect(html).toContain('<h1');
    }
  });
});
