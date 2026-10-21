import { z } from 'zod';
import { safeUrl } from '../../blocks/safe.js';
import { createPageBuilder, type PageBuilder } from './build.js';
import type { GjsNode, GjsRule } from './clean.js';
import { cleanDeclarations } from './cssvalues.js';

/**
 * Edit operations of the builder's AI assistant. The model never writes HTML or component JSON: it returns a list of these operations, validated here
 * (the same module runs on the server before an answer is returned and in the browser before anything is applied). Node specs are a small allow-list of
 * component types; `nodeFromSpec` turns one into component data with the page builder DSL, so the result goes through the same clean-up as any other
 * component. Styles are limited to a short list of properties and pass the page model's value filter.
 */
export const EDIT_LIMITS = { maxOps: 30, maxNodes: 60, maxDepth: 4, maxText: 1500 } as const;

export const RESTYLE_PROPS = [
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-align', 'line-height', 'letter-spacing', 'text-transform',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom', 'border-radius', 'max-width', 'opacity',
] as const;
const RESTYLE = new Set<string>(RESTYLE_PROPS);

const text = (max: number) => z.string().trim().min(1).max(max);
const align = z.enum(['left', 'center', 'right']);
const href = z.string().max(500).refine((u) => /^(\/|#|mailto:|tel:|https:\/\/)/i.test(u) && safeUrl(u) !== null, 'Links must be https, mailto, tel, a path or an anchor');

export type NodeSpec =
  | { type: 'heading'; text: string; level?: number; align?: 'left' | 'center' | 'right' }
  | { type: 'text'; text: string; align?: 'left' | 'center' | 'right'; muted?: boolean }
  | { type: 'button'; text: string; variant?: 'primary' | 'secondary' | 'outline'; action: { type: 'next_step' } | { type: 'anchor'; anchor: string } | { type: 'link'; url: string } }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'faq'; items: { q: string; a: string }[] }
  | { type: 'illustration'; kind: 'browser' | 'chart' | 'ring' | 'discs'; alt: string }
  | { type: 'divider' }
  | { type: 'spacer'; height?: number }
  | { type: 'testimonialPlaceholder'; prompt: string }
  | { type: 'card'; children: NodeSpec[] }
  | { type: 'columns'; columns: NodeSpec[][] }
  | { type: 'section'; theme?: 'light' | 'dark' | 'accent' | 'soft'; padding?: 'sm' | 'md' | 'lg' | 'xl'; width?: 'small' | 'medium' | 'wide'; align?: 'left' | 'center'; children: NodeSpec[] };

export const NodeSpecSchema: z.ZodType<NodeSpec> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('heading'), text: text(300), level: z.number().int().min(1).max(4).optional(), align: align.optional() }),
    z.object({ type: z.literal('text'), text: text(EDIT_LIMITS.maxText), align: align.optional(), muted: z.boolean().optional() }),
    z.object({
      type: z.literal('button'), text: text(60), variant: z.enum(['primary', 'secondary', 'outline']).optional(),
      action: z.discriminatedUnion('type', [z.object({ type: z.literal('next_step') }), z.object({ type: z.literal('anchor'), anchor: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/) }), z.object({ type: z.literal('link'), url: href })]),
    }),
    z.object({ type: z.literal('list'), items: z.array(text(200)).min(1).max(12), ordered: z.boolean().optional() }),
    z.object({ type: z.literal('faq'), items: z.array(z.object({ q: text(160), a: text(600) })).min(1).max(8) }),
    z.object({ type: z.literal('illustration'), kind: z.enum(['browser', 'chart', 'ring', 'discs']), alt: text(140) }),
    z.object({ type: z.literal('divider') }),
    z.object({ type: z.literal('spacer'), height: z.number().int().min(8).max(160).optional() }),
    z.object({ type: z.literal('testimonialPlaceholder'), prompt: text(160) }),
    z.object({ type: z.literal('card'), children: z.array(NodeSpecSchema).min(1).max(8) }),
    z.object({ type: z.literal('columns'), columns: z.array(z.array(NodeSpecSchema).min(1).max(6)).min(2).max(4) }),
    z.object({
      type: z.literal('section'), theme: z.enum(['light', 'dark', 'accent', 'soft']).optional(), padding: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
      width: z.enum(['small', 'medium', 'wide']).optional(), align: z.enum(['left', 'center']).optional(), children: z.array(NodeSpecSchema).min(1).max(12),
    }),
  ]),
) as z.ZodType<NodeSpec>;

const target = z.string().min(1).max(80);
const position = z.enum(['before', 'after', 'start', 'end']);
export const EditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), target, position, node: NodeSpecSchema }),
  z.object({ op: z.literal('replace'), target, node: NodeSpecSchema }),
  z.object({ op: z.literal('delete'), target }),
  z.object({ op: z.literal('move'), target, to: target, position }),
  z.object({ op: z.literal('setText'), target, text: z.string().trim().min(1).max(EDIT_LIMITS.maxText) }),
  z.object({
    op: z.literal('restyle'), target,
    style: z.record(z.string(), z.string().max(80)).refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 8, 'Between 1 and 8 style properties')
      .refine((s) => Object.keys(s).every((k) => RESTYLE.has(k)), `Allowed style properties: ${RESTYLE_PROPS.join(', ')}`),
  }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;

export const EditPlanSchema = z.object({ summary: z.string().trim().min(1).max(240), ops: z.array(EditOpSchema).max(100) });
export type EditPlan = z.infer<typeof EditPlanSchema>;

export interface OutlineNode { id: string; type: string; tag?: string; text?: string; children?: OutlineNode[] }
export const OutlineSchema: z.ZodType<OutlineNode> = z.lazy(() =>
  z.object({ id: z.string().min(1).max(80), type: z.string().max(40), tag: z.string().max(20).optional(), text: z.string().max(200).optional(), children: z.array(OutlineSchema).max(120).optional() }),
) as z.ZodType<OutlineNode>;

export function outlineIds(root: OutlineNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: OutlineNode) => { ids.add(n.id); n.children?.forEach(walk); };
  walk(root);
  return ids;
}

export function countOutline(root: OutlineNode): number {
  return 1 + (root.children ?? []).reduce((a, c) => a + countOutline(c), 0);
}

export function countSpecNodes(n: NodeSpec): number {
  switch (n.type) {
    case 'card': case 'section': return 1 + n.children.reduce((a, c) => a + countSpecNodes(c), 0);
    case 'columns': return 1 + n.columns.flat().reduce((a, c) => a + countSpecNodes(c), 0);
    default: return 1;
  }
}
export function specDepth(n: NodeSpec): number {
  switch (n.type) {
    case 'card': case 'section': return 1 + Math.max(0, ...n.children.map(specDepth));
    case 'columns': return 1 + Math.max(0, ...n.columns.flat().map(specDepth));
    default: return 1;
  }
}
/** Text content of a spec, for claim checks. */
export function specText(n: NodeSpec): string {
  switch (n.type) {
    case 'heading': case 'text': return n.text;
    case 'button': return n.text;
    case 'list': return n.items.join('\n');
    case 'faq': return n.items.map((i) => `${i.q}\n${i.a}`).join('\n');
    case 'illustration': return n.alt;
    case 'testimonialPlaceholder': return n.prompt;
    case 'card': case 'section': return n.children.map(specText).join('\n');
    case 'columns': return n.columns.flat().map(specText).join('\n');
    default: return '';
  }
}

/** Structural problems with a plan, as sentences for a repair prompt. `ids` are the element ids of the outline the model was shown. */
export function planProblems(plan: EditPlan, ids: Set<string>, rootId: string, maxOps: number = EDIT_LIMITS.maxOps): string[] {
  const out: string[] = [];
  if (plan.ops.length > maxOps) out.push(`at most ${maxOps} operations are allowed`);
  let nodes = 0;
  plan.ops.forEach((op, i) => {
    const at = `operation ${i + 1}`;
    if (!ids.has(op.target)) out.push(`${at}: unknown target "${op.target}"; use only ids from the outline`);
    if ((op.op === 'delete' || op.op === 'move' || op.op === 'replace') && op.target === rootId) out.push(`${at}: the page itself cannot be changed that way`);
    if (op.op === 'move') {
      if (!ids.has(op.to)) out.push(`${at}: unknown destination "${op.to}"`);
      if (op.to === op.target) out.push(`${at}: cannot move an element into itself`);
    }
    if (op.op === 'insert' || op.op === 'replace') {
      nodes += countSpecNodes(op.node);
      if (specDepth(op.node) > EDIT_LIMITS.maxDepth) out.push(`${at}: nested deeper than ${EDIT_LIMITS.maxDepth} levels`);
    }
    if ((op.op === 'insert' || op.op === 'move') && (op.position === 'before' || op.position === 'after') && (op.op === 'insert' ? op.target : op.to) === rootId) out.push(`${at}: nothing can be placed before or after the page itself`);
  });
  if (nodes > EDIT_LIMITS.maxNodes) out.push(`too many new elements (${nodes}); at most ${EDIT_LIMITS.maxNodes}`);
  return out;
}

export function cleanRestyle(style: Record<string, string>): Record<string, string> {
  return cleanDeclarations(Object.fromEntries(Object.entries(style).filter(([k]) => RESTYLE.has(k))));
}

// ---- spec -> component data --------------------------------------------------------------------------------------------------------------------------

function art(pm: PageBuilder, kind: 'browser' | 'chart' | 'ring' | 'discs', alt: string): GjsNode {
  const bar = (w: string, h = '10px', bg = '#e2e8f0'): GjsNode => pm.box([], { name: 'Line', style: { width: w, height: h, background: bg, 'border-radius': '999px' } });
  let inner: GjsNode;
  if (kind === 'chart') inner = pm.box([30, 45, 40, 62, 78, 95].map((v, i) => pm.box([], { name: 'Bar', style: { flex: '1 1 0', height: `${v}%`, background: i === 5 ? '#2563eb' : '#93b4f5', 'border-radius': '8px 8px 2px 2px' } })), { name: 'Chart', style: { display: 'flex', 'align-items': 'flex-end', gap: '10px', height: '160px', padding: '18px', background: '#ffffff', border: '1px solid #e2e8f0', 'border-radius': '14px', width: '100%', 'max-width': '420px' } });
  else if (kind === 'ring') inner = pm.box([pm.box([pm.text('72%', { align: 'center' })], { name: 'Ring value', style: { width: '96px', height: '96px', 'border-radius': '50%', background: '#ffffff', color: '#0f172a', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'font-weight': '800' } })], { name: 'Progress ring', style: { width: '128px', height: '128px', 'border-radius': '50%', background: 'conic-gradient(#2563eb 259deg,#e2e8f0 0deg)', display: 'flex', 'align-items': 'center', 'justify-content': 'center' } });
  else if (kind === 'discs') inner = pm.box([pm.box([], { name: 'Disc', style: { width: '120px', height: '120px', 'border-radius': '50%', background: '#93c5fd' } }), pm.box([], { name: 'Disc', style: { width: '90px', height: '90px', 'border-radius': '50%', background: '#c4b5fd', 'margin-left': '-30px' } }), pm.box([], { name: 'Disc', style: { width: '60px', height: '60px', 'border-radius': '50%', background: '#fda4af', 'margin-left': '-20px' } })], { name: 'Discs', style: { display: 'flex', 'align-items': 'center' } });
  else inner = pm.box([pm.box([], { name: 'Hero art', style: { height: '72px', 'border-radius': '10px', background: 'linear-gradient(135deg,#2563eb,#1e3a8a)' } }), bar('70%', '14px', '#cbd5e1'), bar('90%'), bar('82%'), pm.box([], { name: 'Call to action', style: { width: '120px', height: '34px', 'border-radius': '999px', background: '#2563eb' } })], { name: 'Browser mock-up', style: { display: 'flex', 'flex-direction': 'column', gap: '10px', padding: '18px', background: '#ffffff', border: '1px solid #cbd5e1', 'border-radius': '14px', width: '100%', 'max-width': '420px' } });
  const wrap = pm.box([inner], { name: 'Illustration', style: { display: 'flex', 'justify-content': 'center', width: '100%' } });
  wrap.attributes = { ...(wrap.attributes as Record<string, string>), role: 'img', 'aria-label': alt };
  return wrap;
}

function build(pm: PageBuilder, s: NodeSpec): GjsNode {
  switch (s.type) {
    case 'heading': return pm.heading(s.text, { level: s.level ?? 2, align: s.align });
    case 'text': return pm.text(s.text, { align: s.align, muted: s.muted });
    case 'button': return pm.button(s.text, s.action, { variant: s.variant ?? 'primary' });
    case 'list': return pm.list(s.items, { ordered: s.ordered });
    case 'faq': return pm.faq(s.items);
    case 'illustration': return art(pm, s.kind, s.alt);
    case 'divider': return pm.divider();
    case 'spacer': return pm.spacer(s.height ?? 32);
    case 'testimonialPlaceholder': return pm.card([pm.badgeText('Placeholder testimonial'), pm.text(`[Quote to collect: ${s.prompt}]`), pm.text('Customer name and role go here', { muted: true, size: '.9rem' })], { name: 'Testimonial placeholder' });
    case 'card': return pm.card(s.children.map((c) => build(pm, c)));
    case 'columns': return pm.cols(s.columns.map((col) => col.map((c) => build(pm, c))));
    case 'section': return pm.section([pm.stack(s.children.map((c) => build(pm, c)))], { theme: s.theme ?? 'light', padding: s.padding ?? 'lg', width: s.width ?? 'wide', align: s.align });
  }
}

/** Component data for a spec: builder DSL output with the generated style rules folded into each node's `style` (what GrapesJS accepts when adding components). */
export function nodeFromSpec(spec: NodeSpec, idPrefix = 'ai'): GjsNode {
  const pm = createPageBuilder(`${idPrefix}${Math.random().toString(36).slice(2, 6)}`);
  const node = build(pm, spec);
  const byId = new Map<string, GjsRule['style']>();
  for (const r of pm.rules) {
    const sel = r.selectors?.[0];
    if (typeof sel === 'string' && sel.startsWith('#')) byId.set(sel.slice(1), { ...(byId.get(sel.slice(1)) ?? {}), ...r.style });
  }
  const inline = (n: GjsNode): void => {
    const id = (n.attributes as Record<string, string> | undefined)?.id;
    if (id && byId.has(id)) n.style = byId.get(id);
    if (Array.isArray(n.components)) (n.components as GjsNode[]).forEach(inline);
  };
  inline(node);
  return node;
}

export function describeOp(op: EditOp, label: (id: string) => string): string {
  const names: Record<NodeSpec['type'], string> = { heading: 'a heading', text: 'a paragraph', button: 'a button', list: 'a list', faq: 'an FAQ', illustration: 'an illustration', divider: 'a divider', spacer: 'a spacer', testimonialPlaceholder: 'a testimonial placeholder', card: 'a card', columns: 'columns', section: 'a section' };
  switch (op.op) {
    case 'insert': return `Add ${names[op.node.type]} ${op.position === 'start' ? 'at the start of' : op.position === 'end' ? 'at the end of' : op.position} ${label(op.target)}`;
    case 'replace': return `Replace ${label(op.target)} with ${names[op.node.type]}`;
    case 'delete': return `Delete ${label(op.target)}`;
    case 'move': return `Move ${label(op.target)} ${op.position === 'start' ? 'to the start of' : op.position === 'end' ? 'to the end of' : op.position} ${label(op.to)}`;
    case 'setText': return `Change the text of ${label(op.target)} to "${op.text.length > 80 ? `${op.text.slice(0, 80)}…` : op.text}"`;
    case 'restyle': return `Restyle ${label(op.target)}: ${Object.entries(op.style).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  }
}
