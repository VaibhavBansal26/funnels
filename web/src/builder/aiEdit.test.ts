import type { Editor } from 'grapesjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createPageBuilder } from '@pagemodel';
import { applyOps, buildOutline } from './aiEdit';
import { createEditor } from './editor/createEditor';
import { loadDoc } from './editor/load';

let editor: Editor;
function setup() {
  editor = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, { headless: true });
  const pm = createPageBuilder('t');
  const project = pm.project([
    pm.section([pm.stack([pm.heading('We bake the best cakes in town', { level: 1 }), pm.text('Order online and we deliver fresh.'), pm.button('Order now', { type: 'next_step' })])], { name: 'Hero' }),
    pm.section([pm.stack([pm.heading('Second block'), pm.text('Other copy')])], { name: 'Details' }),
    pm.footer('© Bakery'),
  ]);
  expect(loadDoc(editor, { version: 2, project }).ok).toBe(true);
  return buildOutline(editor);
}
afterEach(() => editor?.destroy());
/** GrapesJS gives a restyled element an id attribute and keeps it after undo (the style rule itself is gone); that is not content. */
const norm = (j: string) => j.replace(/"attributes":\{"id":"[^"]+"\},/g, '');
const find = (o: ReturnType<typeof buildOutline>, text: string) => [...o.map.values()].find((c) => (c.getEl()?.textContent ?? c.components().models.map((k) => String(k.get('content') ?? '')).join('')).trim() === text && c.components().models.every((k) => k.get('type') === 'textnode'))!;

describe('builder assistant: outline', () => {
  it('lists ids, types and texts; no styles or html', () => {
    const o = setup();
    const json = JSON.stringify(o.root);
    expect(o.root.type).toBe('wrapper');
    expect(json).toContain('We bake the best cakes in town');
    expect(json).not.toMatch(/style|<h1|class/);
    expect(o.map.get(o.root.id)).toBe(editor.getWrapper());
  });
});

describe('builder assistant: applying operations', () => {
  it('applies text, style, insert, move and delete operations as ONE undo step', () => {
    const o = setup();
    const h1 = find(o, 'We bake the best cakes in town');
    const second = find(o, 'Second block');
    const foot = editor.getWrapper()!.components().models.at(-1)!;
    const before = JSON.stringify(editor.getProjectData());
    const um = editor.UndoManager;
    const r = applyOps(editor, [
      { op: 'setText', target: h1.getId(), text: 'Fresh cakes daily' },
      { op: 'restyle', target: h1.getId(), style: { 'text-align': 'center' } },
      { op: 'insert', target: foot.getId(), position: 'before', node: { type: 'section', children: [{ type: 'heading', text: 'Questions' }, { type: 'faq', items: [{ q: 'Do you ship?', a: '[Add your answer.]' }] }] } },
      { op: 'move', target: second.parent()!.parent()!.parent()!.getId(), to: foot.getId(), position: 'before' },
      { op: 'delete', target: find(o, 'Other copy').getId() },
    ], o.map);
    expect(r).toEqual({ applied: 5, skipped: [] });
    const after = JSON.stringify(editor.getProjectData());
    expect(after).not.toBe(before);
    expect(after).toContain('Fresh cakes daily');
    expect(after).toContain('Do you ship?');
    expect(after).not.toContain('Other copy');
    um.undo();
    expect(norm(JSON.stringify(editor.getProjectData()))).toBe(norm(before));
    expect(um.hasUndo()).toBe(false);
    um.redo();
    expect(norm(JSON.stringify(editor.getProjectData()))).toBe(norm(after));
  });

  it('skips operations that are invalid or point at removed elements, and never breaks the page structure', () => {
    const o = setup();
    const h1 = find(o, 'We bake the best cakes in town');
    const gone = find(o, 'Other copy');
    gone.remove();
    const r = applyOps(editor, [
      { op: 'setText', target: gone.getId(), text: 'x' },
      { op: 'delete', target: o.root.id },
      { op: 'restyle', target: h1.getId(), style: { position: 'fixed' } },
      { op: 'insert', target: h1.getId(), position: 'after', node: { type: 'html', html: '<script>1</script>' } },
      { op: 'insert', target: h1.getId(), position: 'before', node: { type: 'section', children: [{ type: 'text', text: 'Sneaky section' }] } },
    ], o.map);
    expect(r.applied).toBe(1);
    expect(r.skipped).toHaveLength(4);
    // a section never lands inside a column: it goes next to the section that holds the anchor
    expect(editor.getWrapper()!.components().length).toBe(4);
    expect(JSON.stringify(editor.getProjectData())).not.toContain('<script');
  });

  it('inserting at the end of the page and replacing an element work', () => {
    const o = setup();
    const btn = [...o.map.values()].find((c) => c.get('type') === 'fn-button')!;
    const r = applyOps(editor, [
      { op: 'insert', target: o.root.id, position: 'end', node: { type: 'section', children: [{ type: 'testimonialPlaceholder', prompt: 'Ask a customer.' }] } },
      { op: 'replace', target: btn.getId(), node: { type: 'button', text: 'Get a quote', action: { type: 'next_step' } } },
    ], o.map);
    expect(r.applied).toBe(2);
    const json = JSON.stringify(editor.getProjectData());
    expect(json).toContain('Placeholder testimonial');
    expect(json).toContain('Get a quote');
    expect(json).not.toContain('Order now');
  });
});
