import type { Component, Editor } from 'grapesjs';
import { EditOpSchema, nodeFromSpec, type EditOp, type OutlineNode } from '@pagemodel';

/**
 * Client side of the builder assistant: the page outline sent to the server, and the application of the validated operations it returns.
 * Operations are applied synchronously in one go, which GrapesJS' undo manager records as ONE history step (checked in aiEdit.test.ts), so a single
 * undo reverts an entire AI edit. Every operation is validated again here with the shared zod schema before anything touches the page.
 */
const SKIP_TEXT = new Set(['fn-form', 'fn-checkout', 'fn-code', 'fn-video']);
const MAX_NODES = 600;

const textOf = (c: Component): string => (c.getEl()?.textContent ?? '').replace(/\s+/g, ' ').trim();
const leafText = (c: Component): string => {
  const kids = c.components();
  return kids.length && kids.models.every((k) => k.get('type') === 'textnode') ? kids.models.map((k) => String(k.get('content') ?? '')).join('').replace(/\s+/g, ' ').trim() : '';
};

export interface Outline { root: OutlineNode; map: Map<string, Component> }

/** The page as ids, types and short texts. The model sees nothing else (no styles, no HTML). Ids are GrapesJS component ids. */
export function buildOutline(editor: Editor): Outline {
  const map = new Map<string, Component>();
  let n = 0;
  const walk = (c: Component, depth: number): OutlineNode => {
    const id = c.getId();
    map.set(id, c);
    const type = String(c.get('type') ?? 'default');
    const node: OutlineNode = { id, type, tag: String(c.get('tagName') ?? '') || undefined };
    const direct = SKIP_TEXT.has(type) ? '' : leafText(c) || (c.components().length === 0 ? textOf(c) : '');
    if (direct) node.text = direct.slice(0, 200);
    if (depth < 7 && !SKIP_TEXT.has(type)) {
      const kids: OutlineNode[] = [];
      for (const k of c.components().models) {
        if (k.get('type') === 'textnode' || ++n > MAX_NODES) continue;
        kids.push(walk(k, depth + 1));
      }
      if (kids.length) node.children = kids;
    }
    return node;
  };
  const wrapper = editor.getWrapper()!;
  return { root: walk(wrapper, 0), map };
}

export const labelFor = (map: Map<string, Component>) => (id: string): string => {
  const c = map.get(id);
  if (!c) return 'an element';
  if (c.get('type') === 'wrapper') return 'the page';
  const name = String(c.get('name') ?? c.get('type') ?? 'element');
  const t = leafText(c) || textOf(c);
  return t ? `${name.toLowerCase()} “${t.length > 40 ? `${t.slice(0, 40)}…` : t}”` : name.toLowerCase();
};

/** Before/after text for the diff list. */
export function diffRows(ops: EditOp[], map: Map<string, Component>): { op: EditOp; before?: string; after?: string }[] {
  return ops.map((op) => (op.op === 'setText' ? { op, before: leafText(map.get(op.target)!) || textOf(map.get(op.target)!), after: op.text } : { op }));
}

const sectionOf = (c: Component): Component | null => {
  let cur: Component | undefined = c;
  while (cur && cur.get('type') !== 'wrapper') {
    if (cur.get('type') === 'fn-section' || cur.parent()?.get('type') === 'wrapper') return cur;
    cur = cur.parent();
  }
  return null;
};

export interface ApplyResult { applied: number; skipped: string[] }

/**
 * Applies operations to the live editor. Anything that no longer matches (an element removed since the outline was built, a node the schema refuses) is
 * skipped and reported, never half-applied. The caller keeps the undo pointer from before to offer "reject".
 */
export function applyOps(editor: Editor, rawOps: unknown[], map: Map<string, Component>): ApplyResult {
  const skipped: string[] = [];
  let applied = 0;
  const alive = (id: string): Component | null => {
    const c = map.get(id);
    return c && (c.get('type') === 'wrapper' || c.parent()) ? c : null;
  };
  for (const raw of rawOps) {
    const parsed = EditOpSchema.safeParse(raw);
    if (!parsed.success) { skipped.push('an operation that is not allowed'); continue; }
    const op = parsed.data;
    const target = alive(op.target);
    if (!target) { skipped.push('an element that is no longer on the page'); continue; }
    const wrapper = editor.getWrapper()!;
    const isWrapper = target === wrapper;
    try {
      switch (op.op) {
        case 'setText':
          target.components([{ type: 'textnode', content: op.text }] as never);
          break;
        case 'restyle':
          target.addStyle(op.style);
          break;
        case 'delete':
          if (isWrapper) throw new Error('page');
          target.remove();
          break;
        case 'insert': case 'replace': {
          const def = nodeFromSpec(op.node);
          const isSection = op.node.type === 'section';
          let parent: Component;
          let at: number | undefined;
          if (op.op === 'replace') {
            if (isWrapper) throw new Error('page');
            parent = target.parent()!;
            at = target.index();
          } else if (op.position === 'start' || op.position === 'end') {
            parent = target;
            at = op.position === 'start' ? 0 : undefined;
          } else {
            const anchor = isSection ? sectionOf(target) ?? target : target;
            if (anchor === wrapper) throw new Error('page');
            parent = anchor.parent()!;
            at = anchor.index() + (op.position === 'after' ? 1 : 0);
          }
          if (isSection && parent !== wrapper) { parent = wrapper; at = undefined; }
          parent.append(def as never, at === undefined ? undefined : { at });
          if (op.op === 'replace') target.remove();
          break;
        }
        case 'move': {
          const dest = alive(op.to);
          if (!dest || isWrapper || dest === target) throw new Error('move');
          for (let p: Component | undefined = dest; p; p = p.parent()) if (p === target) throw new Error('inside');
          if (op.position === 'start' || op.position === 'end') target.move(dest, op.position === 'start' ? { at: 0 } : {});
          else {
            const p = dest.parent();
            if (!p) throw new Error('move');
            target.move(p, { at: dest.index() + (op.position === 'after' ? 1 : 0) });
          }
          break;
        }
      }
      applied++;
    } catch {
      skipped.push(`${op.op} of ${labelFor(map)(op.target)}`);
    }
  }
  return { applied, skipped };
}
