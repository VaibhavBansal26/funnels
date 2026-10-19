import { createBuilder, documentOf, LIMITS, parseDocument, renderPage, type PageDocument } from '@blocks';
import { describe, expect, it } from 'vitest';
import { builderReducer, canRedo, canUndo, COALESCE_MS, HISTORY_LIMIT, initialState, isDirty, type BuilderAction, type BuilderState } from './reducer';
import { describeIssues, prepareSave, roundTrip } from './serialize';
import { addColumn, defaultLoc, dropLoc, findBlock, insertAt, moveBy, moveIntoPrevious, moveOut, moveTo, removeBlock, removeColumn, visibleIds } from './tree';
import { blockErrors } from './validate';

const start = (): BuilderState => {
  const b = createBuilder('t');
  return initialState(documentOf([b.heading('One'), b.paragraph('Two'), b.section([b.heading('Inner')])]), 1);
};
const run = (s: BuilderState, ...a: BuilderAction[]) => a.reduce(builderReducer, s);
const ids = (s: BuilderState) => visibleIds(s.doc);

describe('reducer: undo / redo', () => {
  it('undoes and redoes add, remove, move and update', () => {
    let s = start();
    const original = JSON.stringify(s.doc);
    s = run(s, { type: 'add', blockType: 'divider', id: 'new1' });
    expect(ids(s)).toContain('new1');
    expect(s.selectedId).toBe('new1');
    s = run(s, { type: 'update', id: 'new1', patch: {} }, { type: 'remove', id: 't1' });
    expect(ids(s)).not.toContain('t1');
    s = run(s, { type: 'moveBy', id: 't2', delta: -1 });
    expect(canUndo(s)).toBe(true);
    for (let i = 0; i < 4; i++) s = run(s, { type: 'undo' });
    expect(JSON.stringify(s.doc)).toBe(original);
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(true);
    for (let i = 0; i < 4; i++) s = run(s, { type: 'redo' });
    expect(ids(s)).toContain('new1');
    expect(ids(s)).not.toContain('t1');
    expect(canRedo(s)).toBe(false);
  });

  it('a new edit clears the redo stack; undo/redo on empty history is a no-op', () => {
    let s = start();
    expect(run(s, { type: 'undo' })).toBe(s);
    expect(run(s, { type: 'redo' })).toBe(s);
    s = run(s, { type: 'add', blockType: 'divider', id: 'a' }, { type: 'undo' });
    expect(canRedo(s)).toBe(true);
    s = run(s, { type: 'add', blockType: 'spacer', id: 'b2' });
    expect(canRedo(s)).toBe(false);
  });

  it('coalesces rapid edits of the same field into one history entry', () => {
    let s = start();
    const type = (text: string, now: number) => ({ type: 'update', id: 't1', patch: { text }, coalesce: 't1:text', now }) as BuilderAction;
    s = run(s, type('O', 1000), type('On', 1100), type('One!', 1200));
    expect(s.past).toHaveLength(1);
    s = run(s, type('One!!', 1200 + COALESCE_MS + 1));
    expect(s.past).toHaveLength(2);
    s = run(s, { type: 'update', id: 't1', patch: { level: 3 }, coalesce: 't1:level', now: 5000 });
    expect(s.past).toHaveLength(3);
    s = run(s, { type: 'undo' });
    expect((findBlock(s.doc, 't1')!.block as { text: string }).text).toBe('One!!');
  });

  it('caps history at the limit', () => {
    let s = start();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) s = run(s, { type: 'update', id: 't1', patch: { text: `v${i}` } });
    expect(s.past).toHaveLength(HISTORY_LIMIT);
  });

  it('undo drops a selection that no longer exists', () => {
    let s = run(start(), { type: 'add', blockType: 'divider', id: 'x1' });
    expect(s.selectedId).toBe('x1');
    s = run(s, { type: 'undo' });
    expect(s.selectedId).toBeNull();
  });
});

describe('reducer: dirty tracking and notices', () => {
  it('is dirty only when the document differs from the saved snapshot', () => {
    let s = start();
    expect(isDirty(s)).toBe(false);
    s = run(s, { type: 'update', id: 't1', patch: { text: 'Changed' } });
    expect(isDirty(s)).toBe(true);
    s = run(s, { type: 'undo' });
    expect(isDirty(s)).toBe(false); // back to the saved content
  });

  it('edits made while a save is in flight stay unsaved', () => {
    let s = run(start(), { type: 'update', id: 't1', patch: { text: 'A' } });
    const sent = s.doc;
    s = run(s, { type: 'update', id: 't1', patch: { text: 'B' } });
    s = run(s, { type: 'saved', version: 2, doc: sent });
    expect(s.version).toBe(2);
    expect(isDirty(s)).toBe(true);
    s = run(s, { type: 'saved', version: 3, doc: s.doc });
    expect(isDirty(s)).toBe(false);
  });

  it('refuses additions beyond the block limit and reports a notice', () => {
    const many = documentOf(Array.from({ length: LIMITS.maxBlocks }, (_, i) => ({ id: `d${i}`, type: 'divider' as const })));
    const s = run(initialState(many), { type: 'add', blockType: 'divider', id: 'extra' });
    expect(s.doc.blocks).toHaveLength(LIMITS.maxBlocks);
    expect(s.notice).toContain('400 blocks');
    expect(run(s, { type: 'dismissNotice' }).notice).toBeNull();
  });

  it('load resets history; settings and replace are undoable', () => {
    let s = run(start(), { type: 'settings', patch: { accent: '#ff0000' } });
    expect(s.doc.settings.accent).toBe('#ff0000');
    s = run(s, { type: 'undo' });
    expect(s.doc.settings.accent).toBeUndefined();
    s = run(s, { type: 'replace', doc: documentOf([]) });
    expect(s.doc.blocks).toHaveLength(0);
    s = run(s, { type: 'load', doc: documentOf([]), version: 9 });
    expect(canUndo(s)).toBe(false);
    expect(s.version).toBe(9);
  });
});

describe('tree operations', () => {
  const doc = (): PageDocument => {
    const k = createBuilder('k');
    return documentOf([k.heading('A'), k.columns([[k.paragraph('c1')], [k.paragraph('c2'), k.divider()]]), k.section([k.heading('S1'), k.heading('S2')]), k.button('B')]);
  };

  it('finds blocks in sections and columns with their locations', () => {
    const d = doc();
    expect(findBlock(d, 'k1')!.loc).toEqual({ parentId: null, slot: 0, index: 0 });
    const cols = d.blocks[1]!;
    const inner = findBlock(d, 'k3')!;
    expect(inner.loc).toMatchObject({ parentId: cols.id, slot: 1 });
    expect(findBlock(d, 'missing')).toBeNull();
  });

  it('moves within a list, across containers, out of and into containers', () => {
    const d = doc();
    const top = (x: PageDocument) => x.blocks.map((b) => b.id);
    const up = moveBy(d, d.blocks[2]!.id, -1)!;
    expect(top(up)[1]).toBe(d.blocks[2]!.id);
    expect(moveBy(d, d.blocks[0]!.id, -1)).toBeNull();
    expect(moveBy(d, d.blocks[3]!.id, 1)).toBeNull();
    const out = moveOut(d, 'k3')!;
    expect(top(out)).toContain('k3');
    expect(moveOut(d, 'k1')).toBeNull();
    expect(moveIntoPrevious(d, d.blocks[2]!.id)).not.toBeNull(); // the previous block is a columns container
    expect(moveIntoPrevious(d, d.blocks[3]!.id)).not.toBeNull(); // previous block is a section
    expect(moveIntoPrevious(d, d.blocks[1]!.id)).toBeNull(); // previous block is a heading: not a container
    expect(moveIntoPrevious(d, d.blocks[0]!.id)).toBeNull();
  });

  it('moveIntoPrevious puts a block at the end of the previous container', () => {
    const k = createBuilder('m');
    const d = documentOf([k.section([k.heading('in')]), k.paragraph('after')]);
    const r = moveIntoPrevious(d, 'm3')!;
    expect(r.blocks).toHaveLength(1);
    expect(findBlock(r, 'm3')!.loc.parentId).toBe('m2');
  });

  it('moveTo adjusts the index when moving later in the same list and refuses to move a container into itself', () => {
    const k = createBuilder('n');
    const d = documentOf([k.heading('a'), k.heading('b'), k.heading('c')]);
    const r = moveTo(d, 'n1', { parentId: null, slot: 0, index: 3 })!;
    expect(r.blocks.map((x) => x.id)).toEqual(['n2', 'n3', 'n1']);
    const s = createBuilder('s');
    const nested = documentOf([s.section([s.section([s.heading('x')])])]);
    expect(moveTo(nested, 's3', { parentId: 's3', slot: 0, index: 0 })).toBeNull();
    expect(moveTo(nested, 's3', { parentId: 's2', slot: 0, index: 0 })).toBeNull(); // into its own child
  });

  it('enforces the nesting limit on insert and move', () => {
    const k = createBuilder('d');
    let d: PageDocument = documentOf([k.heading('leaf')]);
    for (let i = 0; i < LIMITS.maxDepth - 1; i++) d = documentOf([k.section(d.blocks)]);
    const deepest = visibleIds(d).at(-1)!;
    expect(insertAt(d, { parentId: findBlock(d, deepest)!.loc.parentId, slot: 0, index: 0 }, k.section([k.heading('x')]))).toBeNull();
  });

  it('removes, defaults placement and resolves drop zones', () => {
    const d = doc();
    expect(visibleIds(removeBlock(d, d.blocks[1]!.id))).not.toContain('k2');
    expect(defaultLoc(d, null)).toEqual({ parentId: null, slot: 0, index: 4 });
    expect(defaultLoc(d, 'k1')).toEqual({ parentId: null, slot: 0, index: 1 });
    const section = d.blocks[2]!;
    expect(defaultLoc(d, section.id)).toEqual({ parentId: section.id, slot: 0, index: 2 });
    const cols = d.blocks[1]!;
    expect(defaultLoc(d, cols.id)).toMatchObject({ parentId: cols.id, slot: 1, index: 2 });
    expect(dropLoc(d, 'k1', 'before')).toEqual({ parentId: null, slot: 0, index: 0 });
    expect(dropLoc(d, 'k1', 'after')).toEqual({ parentId: null, slot: 0, index: 1 });
    expect(dropLoc(d, 'k1', 'into')).toEqual({ parentId: null, slot: 0, index: 1 }); // not a container: falls back to after
    expect(dropLoc(d, section.id, 'into')).toEqual({ parentId: section.id, slot: 0, index: 2 });
    expect(dropLoc(d, 'zzz', 'before')).toBeNull();
  });

  it('adds columns up to five and removing merges content into the previous column', () => {
    let d = doc();
    const cols = d.blocks[1]!.id;
    for (let i = 0; i < 3; i++) d = addColumn(d, cols, `nc${i}`)!;
    expect(addColumn(d, cols, 'nc9')).toBeNull();
    d = removeColumn(d, cols, 1)!;
    const c = findBlock(d, cols)!.block as { columns: { children: { id: string }[] }[] };
    expect(c.columns).toHaveLength(4);
    expect(c.columns[0]!.children.map((x) => x.id)).toEqual(['k2', 'k3', 'k4']);
    const single = documentOf([createBuilder('z').columns([[]])]);
    expect(removeColumn(single, single.blocks[0]!.id, 0)).toBeNull();
  });
});

describe('builder serialisation round trip', () => {
  it('every palette block survives JSON save/load and renders identically', () => {
    let s = initialState(documentOf([]));
    for (const t of ['section', 'columns', 'heading', 'paragraph', 'image', 'button', 'video', 'divider', 'spacer', 'list', 'faq', 'countdown', 'form', 'checkout', 'html'] as const) {
      s = run(s, { type: 'add', blockType: t, id: `p-${t}`, loc: { parentId: null, slot: 0, index: s.doc.blocks.length } });
    }
    const check = prepareSave(s.doc, 4, true);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.body).toMatchObject({ version: 4, backup: true });
    const rt = roundTrip(check.doc);
    expect(rt.identical).toBe(true);
    expect(JSON.stringify(rt.doc)).toBe(JSON.stringify(check.doc));
    expect(renderPage(rt.doc, { funnelId: 'f', stepId: 's', stepName: 'x' })).toContain('<!doctype html>');
  });

  it('an edited document round-trips through the exact JSON the server stores', () => {
    let s = start();
    s = run(s, { type: 'update', id: 't1', patch: { text: 'Grüße <b>& 你好</b>', level: 1 } }, { type: 'duplicate', id: 't2' }, { type: 'settings', patch: { font: 'serif' } });
    const sent = JSON.parse(JSON.stringify(prepareSave(s.doc, 1, false).ok ? s.doc : null));
    const back = parseDocument(sent);
    expect(back.ok && back.doc).toEqual(s.doc);
  });

  it('invalid documents are caught before any request, with readable issues', () => {
    const bad = documentOf([{ id: 'x', type: 'button', text: 'Go', style: 'primary', size: 'md', action: { type: 'link', url: 'javascript:alert(1)' } }]);
    const check = prepareSave(bad, 1, true);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(describeIssues(check.issues)[0]).toContain('action');
    expect(prepareSave({ version: 2, blocks: [] }, 1, true).ok).toBe(false);
  });
});

describe('block validation messages', () => {
  it('reports the offending field of the right block type', () => {
    const form = createBuilder('f').form({ fields: [{ id: 'email', type: 'email', label: 'E', required: true }, { id: 'Bad Id', type: 'text', label: 'X', required: false }] });
    const errs = blockErrors(form);
    expect(Object.keys(errs)).toContain('fields.1.id');
    expect(errs['fields.1.id']).toMatch(/lowercase/i);
    expect(blockErrors(createBuilder('h').heading('ok'))).toEqual({});
    const noEmail = createBuilder('g').form({ fields: [{ id: 'name', type: 'name', label: 'N', required: false }] });
    expect(JSON.stringify(blockErrors(noEmail))).toContain('email field');
  });
});
