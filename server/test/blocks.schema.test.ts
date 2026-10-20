import { describe, expect, it } from 'vitest';
import { createBuilder, DOC_VERSION, documentOf, field, LIMITS, migrateDocument, parseDocument, safeUrl, parseVideoUrl } from '../src/blocks/index.js';

describe('url helpers', () => {
  it('safeUrl accept/reject table', () => {
    const ok = ['https://a.com', 'http://a.com/x?y=1', '/path', '/path#a', '#anchor', 'mailto:a@b.co', 'tel:+123'];
    const bad = ['', ' ', 'javascript:alert(1)', 'data:text/html,1', '//a.com', '/\\a.com', 'ftp://a.com', 'a.com', 'https://a.com/ b', `https://a.com/${'x'.repeat(2100)}`, 42, null];
    for (const u of ok) expect(safeUrl(u), String(u)).toBeTruthy();
    for (const u of bad) expect(safeUrl(u as string), String(u)).toBeNull();
  });
  it('parseVideoUrl', () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.kind).toBe('youtube');
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')?.kind).toBe('youtube');
    expect(parseVideoUrl('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseVideoUrl('https://player.vimeo.com/video/123456789')?.kind).toBe('vimeo');
    expect(parseVideoUrl('https://x.com/a.MP4')?.kind).toBe('mp4');
    expect(parseVideoUrl('https://x.com/a.mov')).toBeNull();
  });
});

describe('document schema', () => {
  const b = createBuilder('s');

  it('accepts a valid document and applies defaults', () => {
    const r = parseDocument({ version: 1, blocks: [b.heading('Hi'), b.button('Go')] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.settings.font).toBe('system');
  });

  it('migrates unversioned documents and rejects future versions', () => {
    expect(migrateDocument({ blocks: [] })).toMatchObject({ version: DOC_VERSION });
    expect(parseDocument({ version: 99, blocks: [] }).ok).toBe(false);
    expect(parseDocument(null).ok).toBe(false);
    expect(parseDocument([]).ok).toBe(false);
  });

  it('rejects unsafe or invalid block content', () => {
    const cases: unknown[] = [
      { id: 'a', type: 'button', text: 'x', action: { type: 'link', url: 'javascript:alert(1)' } },
      { id: 'a', type: 'image', src: 'javascript:alert(1)', alt: '' },
      { id: 'a', type: 'video', url: 'https://evil.com/x' },
      { id: 'a', type: 'heading', text: 'x', color: 'red;x:y' },
      { id: 'a', type: 'columns', columns: [] },
      { id: 'a', type: 'columns', columns: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, children: [] })) },
      { id: 'a', type: 'form', fields: [{ id: 'x', type: 'text', label: 'X' }] },
      { id: 'a', type: 'form', fields: [{ id: 'email', type: 'email', label: 'E' }, { id: 'email', type: 'text', label: 'E2' }] },
      { id: 'a', type: 'form', fields: [{ id: 'email', type: 'email', label: 'E' }, { id: 's', type: 'select', label: 'S' }] },
      { id: 'a', type: 'checkout', productName: 'x', price: -1 },
      { id: 'a', type: 'checkout', productName: 'x', price: 1, currency: 'usd' },
      { id: 'a', type: 'countdown', mode: 'fixed' },
      { id: 'bad id!', type: 'divider' },
      { id: 'a', type: 'nope' },
    ];
    for (const block of cases) expect(parseDocument({ version: 1, blocks: [block] }).ok, JSON.stringify(block)).toBe(false);
  });

  it('rejects duplicate block ids', () => {
    expect(parseDocument({ version: 1, blocks: [{ id: 'a', type: 'divider' }, { id: 'a', type: 'divider' }] }).ok).toBe(false);
  });

  it('enforces nesting depth and block count limits', () => {
    let inner: unknown = { id: 'leaf', type: 'divider' };
    for (let i = 0; i < LIMITS.maxDepth; i++) inner = { id: `n${i}`, type: 'section', children: [inner] };
    expect(parseDocument({ version: 1, blocks: [inner] }).ok).toBe(false);
    let ok: unknown = { id: 'leaf', type: 'divider' };
    for (let i = 0; i < LIMITS.maxDepth - 1; i++) ok = { id: `n${i}`, type: 'section', children: [ok] };
    expect(parseDocument({ version: 1, blocks: [ok] }).ok).toBe(true);

    const many = Array.from({ length: LIMITS.maxBlocks + 1 }, (_, i) => ({ id: `d${i}`, type: 'divider' }));
    expect(parseDocument({ version: 1, blocks: many }).ok).toBe(false);
  });

  it('rejects hostile deep nesting before recursing', () => {
    let inner: unknown = { id: 'leaf', type: 'divider' };
    for (let i = 0; i < 50_000; i++) inner = { id: `n${i}`, type: 'section', children: [inner] };
    const r = parseDocument({ version: 1, blocks: [inner] });
    expect(r.ok).toBe(false);
  });

  it('allows legit nested columns inside sections', () => {
    const doc = documentOf([b.section([b.columns([[b.heading('a')], [b.columns([[b.heading('b')], [b.paragraph('c')]])]])])]);
    expect(parseDocument(doc).ok).toBe(true);
  });

  it('strips unknown properties', () => {
    const r = parseDocument({ version: 1, blocks: [{ id: 'a', type: 'divider', onclick: 'x' }] });
    expect(r.ok && JSON.stringify(r.doc)).not.toContain('onclick');
  });

  it('forms need an email field and valid ids', () => {
    const f = b.form({ fields: [field('email', 'email', 'Email', true), field('Bad', 'text', 'x')] });
    expect(parseDocument({ version: 1, blocks: [f] }).ok).toBe(false);
  });
});
