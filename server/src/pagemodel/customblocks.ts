import { convertDocument } from './convert.js';
import { ALLOWED_TYPES, cleanProject, childrenOf, wrapperOf, type GjsNode, type Issue } from './shared/clean.js';

/**
 * "My blocks": a saved component subtree. Stored as one cleaned GrapesJS component node. Blocks saved before the GrapesJS builder were legacy
 * block objects ({type: 'heading', text...}); they are converted when listed.
 */
const LEGACY = new Set(['section', 'columns', 'heading', 'paragraph', 'image', 'button', 'video', 'divider', 'spacer', 'list', 'faq', 'countdown', 'form', 'checkout', 'html']);

const wrap = (node: unknown) => ({ pages: [{ frames: [{ component: { type: 'wrapper', components: [node] } }] }], styles: [] });

export function customBlockFromInput(input: unknown): { ok: true; node: GjsNode } | { ok: false; issues: Issue[] } {
  if (typeof input !== 'object' || input === null || typeof (input as { type?: unknown }).type !== 'string') return { ok: false, issues: [{ path: 'block', message: 'A block needs a type' }] };
  const type = (input as { type: string }).type;
  if (!LEGACY.has(type) && !ALLOWED_TYPES().includes(type)) return { ok: false, issues: [{ path: 'block.type', message: `Unknown block type "${type}"` }] };
  const raw = isLegacyBlock(input) ? firstNodeOfLegacy(input) : input;
  const r = cleanProject(wrap(raw));
  if (!r.ok) return r;
  if (r.forms.length || r.products.length) return { ok: false, issues: [{ path: 'block', message: 'Blocks with forms or checkouts cannot be saved as reusable blocks (their ids must be unique per page)' }] };
  const node = childrenOf(wrapperOf(r.project))[0];
  if (!node) return { ok: false, issues: [{ path: 'block', message: 'Empty block' }] };
  return { ok: true, node };
}

function isLegacyBlock(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && LEGACY.has((v as { type: string }).type) && !('tagName' in v);
}

function firstNodeOfLegacy(block: Record<string, unknown>): unknown {
  const wrapperChildren = childrenOf(wrapperOf(convertDocument({ version: 1, blocks: [block] }).project));
  // A section converts to a section component; a loose block to a section holding it: unwrap to the block itself where possible.
  const only = wrapperChildren[0];
  if (block.type !== 'section' && only && childrenOf(only).length === 1) {
    const row = childrenOf(only)[0]!;
    const col = childrenOf(row)[0];
    if (col && childrenOf(col).length === 1) return childrenOf(col)[0];
  }
  return only;
}

/** Reads a stored block (either generation) as a component node; unreadable data becomes an empty box. */
export function customBlockToNode(json: string): GjsNode {
  try {
    const r = customBlockFromInput(JSON.parse(json));
    if (r.ok) return r.node;
  } catch {
    /* fall through */
  }
  return { type: 'fn-box', tagName: 'div', components: [] };
}
