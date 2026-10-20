import { describe, expect, it } from 'vitest';
import { normalizeDoc } from '../src/pagemodel/doc.js';
import { COMPONENT_MIGRATIONS, COMPONENT_VERSION, PROJECT_LIMITS, cleanProject, exceedsLimits } from '../src/pagemodel/shared/clean.js';
import { contrastRatio, createPageBuilder } from '../src/pagemodel/shared/build.js';
import { BASE_CSS } from '../src/pagemodel/shared/css.js';
import { convertDocument } from '../src/pagemodel/convert.js';
import { SEED_TEMPLATES } from '../src/templates/seed.js';
import { walk, wrapperOf } from '../src/pagemodel/shared/clean.js';

const wrap = (components: unknown[], styles: unknown[] = []) => ({ styles, pages: [{ frames: [{ component: { type: 'wrapper', components } }] }] });
const text = (t: string) => ({ type: 'text', tagName: 'p', components: [{ type: 'textnode', content: t }] });

describe('project JSON limits (size, depth, counts)', () => {
  it('rejects more elements than the limit, naming the limit', () => {
    const r = cleanProject(wrap(Array.from({ length: PROJECT_LIMITS.maxNodes + 5 }, () => text('x'))));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.message).toContain(String(PROJECT_LIMITS.maxNodes));
  });

  it('rejects nesting deeper than the limit and survives pathological depth without a stack overflow', () => {
    let node: any = text('leaf');
    for (let i = 0; i < PROJECT_LIMITS.maxDepth + 3; i++) node = { type: 'default', tagName: 'div', components: [node] };
    const r = cleanProject(wrap([node]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.message).toMatch(/nested at most/);
    let deep: any = { type: 'default' };
    for (let i = 0; i < 200_000; i++) deep = { components: [deep] };
    expect(exceedsLimits(wrap([deep]))).toMatch(/nested too deeply/);
    expect(cleanProject(wrap([deep])).ok).toBe(false);
  });

  it('rejects documents above the byte limit and too many style rules', () => {
    const big = wrap([text('x'.repeat(PROJECT_LIMITS.maxText))].concat(Array.from({ length: 220 }, () => text('y'.repeat(PROJECT_LIMITS.maxText)))));
    const r = cleanProject(big);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]!.message).toMatch(/too large/);
    const many = cleanProject(wrap([], Array.from({ length: PROJECT_LIMITS.maxRules + 1 }, (_, i) => ({ selectors: [`c${i}`], style: { color: 'red' } }))));
    expect(many.ok).toBe(false);
  });

  it('truncates oversized text and attribute values instead of storing them', () => {
    const r = cleanProject(wrap([{ type: 'default', tagName: 'div', attributes: { title: 'a'.repeat(5000) }, components: [{ type: 'textnode', content: 'b'.repeat(50_000) }] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = (r.project.pages[0]!.frames[0]!.component.components as any[])[0];
    expect(n.attributes.title).toHaveLength(PROJECT_LIMITS.maxAttr);
    expect(n.components[0].content).toHaveLength(PROJECT_LIMITS.maxText);
  });

  it('refuses non-objects, unknown versions and invalid typed props with a path to the problem', () => {
    for (const bad of [null, 5, 'x', [], undefined]) expect(normalizeDoc(bad as never).ok).toBe(false);
    expect(normalizeDoc({ version: 99, project: wrap([]) }).ok).toBe(false);
    const noEmail = normalizeDoc({ version: 2, project: wrap([{ type: 'fn-form', tagName: 'div', fnForm: { fields: [{ id: 'name', type: 'name', label: 'Name' }] } }]) });
    expect(noEmail.ok).toBe(false);
    expect(!noEmail.ok && noEmail.issues[0]!.message).toMatch(/email/i);
    const badVideo = normalizeDoc({ version: 2, project: wrap([{ type: 'fn-video', tagName: 'div', fnVideo: { url: 'https://evil.example/x.mp4.exe' } }]) });
    expect(badVideo.ok).toBe(false);
    const badPrice = normalizeDoc({ version: 2, project: wrap([{ type: 'fn-checkout', tagName: 'div', fnProduct: { productName: 'x', price: -5 } }]) });
    expect(badPrice.ok).toBe(false);
    const badAction = normalizeDoc({ version: 2, project: wrap([{ type: 'fn-button', tagName: 'a', fnAction: { type: 'link', url: 'javascript:alert(1)' } }]) });
    expect(badAction.ok).toBe(false);
  });

  it('forms and products need unique ids: duplicates and missing ids are repaired, never shared', () => {
    const form = (id?: string) => ({ type: 'fn-form', tagName: 'div', ...(id ? { attributes: { id } } : {}), fnForm: { fields: [{ id: 'email', type: 'email', label: 'E' }] } });
    const r = normalizeDoc({ version: 2, project: wrap([form('same'), form('same'), form()]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.doc.forms.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('same');
  });

  it('video sources: only YouTube, Vimeo and https mp4 are accepted', () => {
    const ok = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://vimeo.com/76979871', 'https://cdn.example/a.mp4'];
    const no = ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://vimeo.com/abc'];
    for (const url of ok) expect(normalizeDoc({ version: 2, project: wrap([{ type: 'fn-video', tagName: 'div', fnVideo: { url } }]) }).ok, url).toBe(true);
    for (const url of no) expect(normalizeDoc({ version: 2, project: wrap([{ type: 'fn-video', tagName: 'div', fnVideo: { url } }]) }).ok, url).toBe(false);
  });
});

describe('colour contrast (WCAG AA)', () => {
  const vars = (block: string) => Object.fromEntries([...block.matchAll(/(--fn-[a-z-]+):(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1]!, m[2]!]));
  const root = vars(/:root\{([^}]*)\}/.exec(BASE_CSS)![1]!);
  const dark = vars(/:where\(\.fn-dark\)\{([^}]*)\}/.exec(BASE_CSS)![1]!);
  const accent = vars(/:where\(\.fn-accent-bg\)\{([^}]*)\}/.exec(BASE_CSS)![1]!);

  const pairs: [string, string, string, number][] = [
    ['light text', root['--fn-text']!, root['--fn-bg']!, 4.5],
    ['light muted text', root['--fn-muted']!, root['--fn-bg']!, 4.5],
    ['light muted text on soft surface', root['--fn-muted']!, root['--fn-surface']!, 4.5],
    ['link on light', root['--fn-link']!, root['--fn-bg']!, 4.5],
    ['button label on accent', root['--fn-accent-ink']!, root['--fn-accent']!, 4.5],
    ['card text on card', root['--fn-card-ink']!, root['--fn-card']!, 4.5],
    ['dark text', dark['--fn-text']!, '#0f172a', 4.5],
    ['dark muted text', dark['--fn-muted']!, '#0f172a', 4.5],
    ['dark link', dark['--fn-link']!, '#0f172a', 4.5],
    ['dark card text', dark['--fn-card-ink']!, dark['--fn-card']!, 4.5],
    ['dark muted on surface', dark['--fn-muted']!, dark['--fn-surface']!, 4.5],
    ['accent section text', accent['--fn-text']!, '#1d4ed8', 4.5],
    ['accent section muted text', accent['--fn-muted']!, '#1d4ed8', 4.5],
    ['countdown digits', '#ffffff', '#0f172a', 4.5],
    ['countdown labels', '#cbd5e1', '#0f172a', 4.5],
  ];
  for (const [name, fg, bg, min] of pairs) {
    it(`${name}: ${fg} on ${bg}`, () => {
      expect(contrastRatio(fg, bg)!).toBeGreaterThanOrEqual(min);
    });
  }

  it('seeded templates never set a text colour of their own, so copy always follows the section theme', () => {
    for (const t of SEED_TEMPLATES) {
      for (const s of t.steps) {
        const explicit = s.doc.project.styles.filter((r) => 'color' in r.style).map((r) => JSON.stringify(r));
        // only the avatar badges (dark text on a light pastel circle, both set together) are allowed to colour text
        for (const r of explicit) expect(r, `${t.slug}`).toMatch(/background/);
      }
    }
  });

  it('the legacy converter drops explicit text colours that would be unreadable on the section they sit in (dark-on-dark)', () => {
    const doc = {
      version: 1,
      settings: { font: 'system' },
      blocks: [
        { id: 's', type: 'section', padding: 'lg', width: 'wide', align: 'left', background: '#0f172a', children: [
          { id: 'h', type: 'heading', level: 1, text: 'Dark hero', color: '#1f2937' }, // dark on dark: dropped
          { id: 'p', type: 'paragraph', text: 'Light copy', color: '#e2e8f0' }, // light on dark: kept
        ] },
        { id: 's2', type: 'section', padding: 'lg', width: 'wide', align: 'left', children: [{ id: 'p2', type: 'paragraph', text: 'Pale on white', color: '#f1f5f9' }] },
      ],
    };
    const r = convertDocument(doc);
    const json = JSON.stringify(r.project);
    expect(json).not.toContain('#1f2937');
    expect(json).toContain('#e2e8f0');
    expect(json).not.toContain('#f1f5f9');
    expect(r.notes.filter((n) => n.startsWith('Dropped text colour'))).toHaveLength(2);
  });

  it('every dark or accent section of every template contains only theme-following text', () => {
    for (const t of SEED_TEMPLATES) {
      for (const s of t.steps) {
        const ruled = new Set(s.doc.project.styles.filter((r) => 'color' in r.style && !('background' in r.style)).flatMap((r) => (r.selectors ?? []).map((x) => String(typeof x === 'string' ? x : x.name).replace(/^#/, ''))));
        walk(wrapperOf(s.doc.project), (n) => {
          const id = (n.attributes as Record<string, string> | undefined)?.id;
          expect(id && ruled.has(id), `${t.slug} ${id}`).toBeFalsy();
        });
      }
    }
    void createPageBuilder;
  });
});

describe('component version reconciliation', () => {
  it('stamps unversioned components with the current version and runs registered migrations once, from the saved version up', () => {
    const heading = (fnV?: string) => ({ type: 'fn-heading', tagName: 'h2', ...(fnV ? { fnV } : {}), name: 'Old', components: [{ type: 'textnode', content: 'x' }] });
    const names = (r: ReturnType<typeof cleanProject>) => (r.ok ? (r.project.pages[0]!.frames[0]!.component.components as { name?: string; fnV?: string }[]).map((n) => `${n.name}:${n.fnV}`) : []);
    const plain = cleanProject(wrap([heading(), heading(String(COMPONENT_VERSION))]));
    expect(names(plain)).toEqual([`Old:${COMPONENT_VERSION}`, `Old:${COMPONENT_VERSION}`]);
    COMPONENT_MIGRATIONS['fn-heading@0'] = (n) => ({ ...n, name: 'Migrated' });
    try {
      expect(names(cleanProject(wrap([heading(), heading(String(COMPONENT_VERSION))])))).toEqual([`Migrated:${COMPONENT_VERSION}`, `Old:${COMPONENT_VERSION}`]);
    } finally {
      delete COMPONENT_MIGRATIONS['fn-heading@0'];
    }
  });
});
