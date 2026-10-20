import type { Block, PageDocument } from '../blocks/index.js';
import { createPageBuilder, isDarkColor, type PageBuilder, type Pad, type Width } from './shared/build.js';
import type { GjsNode, GjsProject } from './shared/clean.js';
import type { ButtonActionProps } from './shared/props.js';
import { FONT_STACKS } from './shared/css.js';

/**
 * Deterministic converter from the legacy block document (version 1: a tree of typed blocks) to GrapesJS project data.
 *
 * - Pure and deterministic: the same document always yields the same project (ids are derived from block ids, nothing random).
 * - Total: it never throws. Unknown block types and malformed fields are skipped (listed in `notes`), so any stored document opens.
 * - Idempotent at the document level: `toProjectDoc` returns version-2 documents unchanged.
 * - Form and checkout components keep the id of the block they replace, so forms already published keep posting to a valid endpoint.
 *
 * The result is still passed through `cleanProject` by the caller (save, render), which is what enforces limits and the allow-lists.
 */
type L = Record<string, any>;

export interface ConvertResult {
  project: GjsProject;
  notes: string[];
}

const SECTION_WIDTH: Record<string, Width> = { narrow: 'small', medium: 'medium', wide: 'wide', full: 'full' };
const PAD: Record<string, Pad> = { none: 'none', sm: 'sm', md: 'md', lg: 'lg', xl: 'xl' };
const ALIGN = new Set(['left', 'center', 'right']);
const FLOW = new Set(['heading', 'paragraph', 'image', 'button', 'video', 'divider', 'spacer', 'list', 'faq', 'countdown', 'form', 'checkout', 'html']);
const idOf = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.replace(/[^A-Za-z0-9_-]/g, '') : '';
  return /^[A-Za-z]/.test(s) ? s.slice(0, 60) : s ? `f${s}`.slice(0, 60) : fallback;
};
const align = (v: unknown) => (typeof v === 'string' && ALIGN.has(v) ? (v as 'left' | 'center' | 'right') : undefined);
const str = (v: unknown, max = 10_000): string => (typeof v === 'string' ? v.slice(0, max) : '');

function action(a: L | undefined): ButtonActionProps {
  switch (a?.type) {
    case 'next_step':
      return { type: 'next_step' };
    case 'step':
      return a.stepId ? { type: 'step', stepId: String(a.stepId) } : { type: 'next_step' };
    case 'link':
      return { type: 'link', url: str(a.url, 2048) || '#', ...(a.newTab ? { newTab: true } : {}) };
    case 'anchor':
      return { type: 'anchor', anchor: str(a.anchor, 40) || 'top' };
    default:
      return { type: 'none' };
  }
}

function leaf(b: L, pm: PageBuilder, notes: string[]): GjsNode | null {
  const bid = idOf(b.id, pm.nextId());
  const al = align(b.align);
  switch (b.type) {
    case 'heading':
      return pm.heading(str(b.text, 500), { level: Number(b.level) || 2, align: al, color: str(b.color) || undefined, anchor: b.anchor ? str(b.anchor, 40) : undefined });
    case 'paragraph':
      return pm.text(str(b.text), { align: al, color: str(b.color) || undefined, anchor: b.anchor ? str(b.anchor, 40) : undefined });
    case 'image': {
      const img = pm.image(str(b.src, 400_100), str(b.alt, 300), { width: b.width ? Number(b.width) : undefined, align: al });
      if (!b.href) return img;
      return { type: 'link', tagName: 'a', attributes: { href: str(b.href, 2048) }, components: [img], name: 'Image link' };
    }
    case 'button': {
      const variant = b.style === 'secondary' || b.style === 'outline' ? b.style : 'primary';
      const size = b.size === 'sm' || b.size === 'lg' ? b.size : 'md';
      return pm.button(str(b.text, 120), action(b.action), { variant, size, align: al, block: b.fullWidth === true });
    }
    case 'video':
      return pm.video(str(b.url, 2048), str(b.title, 200) || 'Video');
    case 'divider':
      return pm.divider();
    case 'spacer':
      return pm.spacer(Math.min(240, Math.max(4, Number(b.height) || 32)));
    case 'list':
      return pm.list((Array.isArray(b.items) ? b.items : []).slice(0, 50).map((i: unknown) => str(i, 500)), { ordered: b.ordered === true, icon: b.icon === 'dot' ? 'dot' : 'check' });
    case 'faq':
      return pm.faq((Array.isArray(b.items) ? b.items : []).slice(0, 50).map((i: L) => ({ q: str(i?.q, 300), a: str(i?.a, 2000) })));
    case 'countdown':
      return pm.countdown({
        mode: b.mode === 'evergreen' ? 'evergreen' : 'fixed',
        ...(b.endsAt ? { endsAt: str(b.endsAt, 40) } : {}),
        ...(b.minutes ? { minutes: Number(b.minutes) } : {}),
        ...(b.label ? { label: str(b.label, 200) } : {}),
        expiredText: str(b.expiredText, 200) || 'This offer has ended',
      }, { id: `cd-${bid}` });
    case 'form':
      return pm.form(bid, {
        name: str(b.name, 120) || 'Form',
        fields: Array.isArray(b.fields) ? b.fields : [],
        submitLabel: str(b.submitLabel, 80) || 'Submit',
        consent: { enabled: b.consent?.enabled === true, text: str(b.consent?.text, 400) || 'I agree to be contacted.' },
        success: b.success ?? { type: 'next_step' },
      });
    case 'checkout':
      return pm.checkout(bid, {
        productName: str(b.productName, 200),
        ...(b.description ? { description: str(b.description, 500) } : {}),
        price: Number(b.price) || 0,
        currency: str(b.currency, 3) || 'USD',
        buttonLabel: str(b.buttonLabel, 80) || 'Buy now',
        orderBump: b.orderBump === true,
        oneClickUpsell: b.oneClickUpsell === true,
        success: b.success ?? { type: 'next_step' },
      });
    case 'html':
      return pm.code(str(b.html, 50_000));
    default:
      notes.push(`Skipped unsupported block type "${String(b.type)}"`);
      return null;
  }
}

function columnsToRow(b: L, pm: PageBuilder, notes: string[], depth: number): GjsNode {
  const gap = b.gap === 'sm' || b.gap === 'lg' ? b.gap : 'md';
  const cols = (Array.isArray(b.columns) ? b.columns : []).slice(0, 5);
  return pm.row(
    cols.map((c: L) => pm.col(blocksToFlow(c.children, pm, notes, depth + 1), { grow: Math.round(Number(c.width)) > 1 ? Math.round(Number(c.width)) : undefined })),
    { gap, keep: false },
  );
}

/** Blocks that live inside a column (or directly in a legacy flow): leaves become elements, nested sections/columns are flattened into rows. */
function blocksToFlow(blocks: unknown, pm: PageBuilder, notes: string[], depth: number): GjsNode[] {
  const out: GjsNode[] = [];
  for (const b of Array.isArray(blocks) ? (blocks as L[]) : []) {
    if (b?.type === 'columns') out.push(depth >= 4 ? pm.text('') : columnsToRow(b, pm, notes, depth));
    else if (b?.type === 'section') out.push(...blocksToFlow(b.children, pm, notes, depth + 1));
    else if (FLOW.has(b?.type)) {
      const n = leaf(b, pm, notes);
      if (n) out.push(n);
    } else if (b) notes.push(`Skipped unsupported block type "${String(b.type)}"`);
  }
  return out;
}

/** Section content: consecutive loose elements share one row/column, column blocks become their own rows. */
function sectionRows(children: unknown, pm: PageBuilder, notes: string[]): GjsNode[] {
  const rows: GjsNode[] = [];
  let pending: GjsNode[] = [];
  const flush = () => {
    if (pending.length) rows.push(pm.stack(pending));
    pending = [];
  };
  for (const b of Array.isArray(children) ? (children as L[]) : []) {
    if (b?.type === 'columns') {
      flush();
      rows.push(columnsToRow(b, pm, notes, 2));
    } else if (b?.type === 'section') {
      flush();
      rows.push(...sectionRows(b.children, pm, notes));
    } else if (FLOW.has(b?.type)) {
      const n = leaf(b, pm, notes);
      if (n) pending.push(n);
    } else if (b) notes.push(`Skipped unsupported block type "${String(b.type)}"`);
  }
  flush();
  return rows;
}

export function convertDocument(input: unknown): ConvertResult {
  const doc: L = typeof input === 'object' && input !== null ? (input as L) : {};
  const notes: string[] = [];
  const pm = createPageBuilder('c');
  const blocks: L[] = Array.isArray(doc.blocks) ? doc.blocks : [];
  const top: GjsNode[] = [];
  let loose: GjsNode[] = [];
  const flushLoose = () => {
    if (loose.length) top.push(pm.section([pm.stack(loose)], { width: 'medium', padding: 'sm' }));
    loose = [];
  };
  for (const b of blocks) {
    if (b?.type === 'section') {
      flushLoose();
      const bg = typeof b.background === 'string' ? b.background : undefined;
      top.push(
        pm.section(sectionRows(b.children, pm, notes), {
          width: SECTION_WIDTH[b.width] ?? 'medium',
          padding: PAD[b.padding] ?? 'md',
          background: bg,
          align: b.align === 'center' ? 'center' : 'left',
          anchor: b.anchor ? str(b.anchor, 40) : undefined,
          theme: bg ? (isDarkColor(bg) ? 'dark' : 'light') : 'light',
        }),
      );
    } else if (b?.type === 'columns') {
      flushLoose();
      top.push(pm.section([columnsToRow(b, pm, notes, 1)], { width: 'medium', padding: 'sm' }));
    } else if (FLOW.has(b?.type)) {
      const n = leaf(b, pm, notes);
      if (n) loose.push(n);
    } else if (b) notes.push(`Skipped unsupported block type "${String(b.type)}"`);
  }
  flushLoose();
  const s: L = typeof doc.settings === 'object' && doc.settings !== null ? doc.settings : {};
  const font = s.font === 'serif' ? 'Serif' : s.font === 'mono' ? 'Mono' : undefined;
  const project = pm.project(top, {
    accent: typeof s.accent === 'string' ? s.accent : undefined,
    background: typeof s.background === 'string' ? s.background : undefined,
    font: font as keyof typeof FONT_STACKS | undefined,
  });
  return { project, notes };
}

export function isLegacyDocument(doc: unknown): doc is PageDocument {
  return typeof doc === 'object' && doc !== null && !('project' in doc) && ((doc as L).version === 1 || (doc as L).version === undefined || (doc as L).version === 0) && 'blocks' in doc;
}

export type { Block };
