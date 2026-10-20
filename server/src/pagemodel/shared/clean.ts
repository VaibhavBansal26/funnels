import { z } from 'zod';
import { safeImageSrc, safeUrl } from '../../blocks/safe.js';
import type { CheckoutBlock, FormBlock } from '../../blocks/schema.js';
import {
  ButtonActionSchema, CodePropsSchema, CountdownPropsSchema, FormPropsSchema, ProductPropsSchema, ProgressPropsSchema, VideoPropsSchema,
} from './props.js';
import { CLASS_NAME_RE, ID_RE, cleanDeclarations, isAllowedState, safeMediaText, safeSelectorAdd } from './cssvalues.js';

/**
 * Structural validation and cleaning of GrapesJS project data. Runs on the server (on save and again when rendering) and in the
 * editor (before saving and before loading), and it is the reason stored project JSON is never trusted: it is rebuilt field by field
 * from an allow-list. Unknown component types become plain containers, unknown tags become <div>, scripts, event handlers, srcdoc,
 * javascript: URLs, forms and iframes cannot be expressed at all (forms, videos, checkouts and custom code exist only as typed
 * `fn*` props that the renderer turns into markup).
 */
export const PROJECT_VERSION = 2;

export const PROJECT_LIMITS = { maxNodes: 3000, maxDepth: 24, maxBytes: 2_000_000, maxRules: 6000, maxText: 10_000, maxAttr: 2000 } as const;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type GjsNode = { [k: string]: unknown };
export interface GjsRule {
  selectors?: (string | { name: string; type?: number })[];
  selectorsAdd?: string;
  style: Record<string, string>;
  mediaText?: string;
  state?: string;
  atRuleType?: string;
}
export interface GjsProject {
  assets: { type?: string; src: string; name?: string; width?: number; height?: number }[];
  styles: GjsRule[];
  pages: { id?: string; type?: string; frames: { component: GjsNode }[] }[];
  symbols?: never[];
  dataSources?: never[];
}

export interface Issue {
  path: string;
  message: string;
}

const TAGS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'button',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'caption', 'details', 'summary', 'label', 'abbr', 'q', 'cite', 'time',
]);
const VOID = new Set(['br', 'hr', 'img']);
export const ALLOWED_TYPES = (): string[] => [...CORE_TYPES, ...FN_TYPES, 'wrapper'];
const CORE_TYPES = new Set(['default', 'text', 'textnode', 'image', 'link', 'label', 'table', 'row', 'cell', 'thead', 'tbody', 'tfoot', 'column']);
/** Component types the builder defines. Each maps to a fixed tag and, for the dynamic ones, a typed props key. */
export const FN_TYPES = [
  'fn-section', 'fn-row', 'fn-column', 'fn-heading', 'fn-text', 'fn-button', 'fn-list', 'fn-divider', 'fn-spacer', 'fn-image', 'fn-video', 'fn-faq', 'fn-tabs',
  'fn-countdown', 'fn-progress', 'fn-form', 'fn-checkout', 'fn-code', 'fn-popup', 'fn-box', 'fn-faq-item', 'fn-tab-nav', 'fn-tab-btn', 'fn-tab-panel', 'fn-popup-dialog',
] as const;
export type FnType = (typeof FN_TYPES)[number];
const FN_SET = new Set<string>(FN_TYPES);

/**
 * Component versions (the idea of the legacy builder's componentVersions.json): every builder component carries `fnV`, the shape version it was
 * saved with. When a component's shape changes in a release, bump the number here and register a migration; stored pages are upgraded when
 * they are cleaned (opened, saved, rendered), so old pages keep working without a data migration. No shape has changed yet: every type is at 1
 * and unversioned nodes (pages converted from legacy blocks, older saves) are stamped with the current version.
 */
export const COMPONENT_VERSION = 1;
export type ComponentMigration = (node: GjsNode) => GjsNode;
export const COMPONENT_MIGRATIONS: Record<string, ComponentMigration> = {}; // key: `${type}@${fromVersion}`, e.g. 'fn-section@1'

export function reconcileNode(type: string, node: GjsNode): GjsNode {
  let v = Number(node.fnV ?? 0);
  if (!Number.isFinite(v) || v < 0) v = 0;
  let out = node;
  for (; v < COMPONENT_VERSION; v++) out = COMPONENT_MIGRATIONS[`${type}@${v}`]?.(out) ?? out;
  return out;
}
const DYNAMIC = new Set(['fn-video', 'fn-countdown', 'fn-progress', 'fn-form', 'fn-checkout', 'fn-code']);
export const isFnType = (t: unknown): t is FnType => typeof t === 'string' && FN_SET.has(t);
export const isDynamicType = (t: unknown): boolean => typeof t === 'string' && DYNAMIC.has(t);

const FLAG_KEYS = ['removable', 'draggable', 'droppable', 'badgable', 'stylable', 'highlightable', 'copyable', 'resizable', 'editable', 'layerable', 'selectable', 'hoverable', 'locked', 'void'] as const;
const SELECTOR_FLAG = /^[A-Za-z0-9_\-\s.#,>[\]="':()*]{1,200}$/;
const ROLES = new Set(['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'region', 'list', 'listitem', 'button', 'img', 'presentation', 'note', 'group', 'tablist', 'tab', 'tabpanel', 'dialog', 'timer', 'status', 'article', 'separator']);
const REL = new Set(['noopener', 'noreferrer', 'nofollow', 'sponsored', 'ugc', 'external']);

export interface CleanResult {
  ok: true;
  project: GjsProject;
  forms: FormBlock[];
  products: CheckoutBlock[];
  /** Non-fatal clean-up notes (dropped attributes, renamed ids). */
  notes: string[];
}
export interface CleanFailure {
  ok: false;
  issues: Issue[];
}

interface Ctx {
  nodes: number;
  issues: Issue[];
  notes: string[];
  ids: Set<string>;
  allIds: Set<string>;
  forms: FormBlock[];
  products: CheckoutBlock[];
  serial: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Cheap, iterative pre-check so hostile input is rejected before any recursive walk or zod parse. */
export function exceedsLimits(input: unknown): string | null {
  const stack: [unknown, number][] = [[input, 0]];
  let visited = 0;
  while (stack.length) {
    const [node, d] = stack.pop()!;
    if (d > PROJECT_LIMITS.maxDepth * 3 + 10) return 'Project is nested too deeply';
    if (++visited > PROJECT_LIMITS.maxNodes * 40) return 'Project is too large';
    if (typeof node !== 'object' || node === null) continue;
    for (const v of Array.isArray(node) ? node : Object.values(node)) stack.push([v, d + 1]);
  }
  return null;
}

function cleanAttributes(tag: string, raw: unknown, ctx: Ctx, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [k0, v0] of Object.entries(raw)) {
    const k = k0.toLowerCase();
    if (v0 !== null && typeof v0 !== 'string' && typeof v0 !== 'number' && typeof v0 !== 'boolean') continue;
    const v = String(v0).slice(0, PROJECT_LIMITS.maxAttr);
    if (k === 'id') {
      if (!ID_RE.test(v)) continue;
      if (ctx.ids.has(v)) {
        ctx.notes.push(`${path}: duplicate id "${v}" removed`);
        continue;
      }
      ctx.ids.add(v);
      out.id = v;
    } else if (k === 'class' || k === 'style' || k.startsWith('on') || k.startsWith('data-gjs') || k.startsWith('data-fn') || k === 'srcdoc' || k === 'formaction' || k === 'action') {
      continue; // classes live in `classes`, styles in the style rules; fn data attributes are produced by the renderer only
    } else if (k === 'title' || k === 'lang' || k === 'dir' || k === 'aria-label' || k === 'aria-labelledby' || k === 'aria-describedby' || k === 'aria-hidden' || k === 'aria-expanded' || k === 'aria-controls' || k === 'aria-live') {
      if (k === 'dir' && v !== 'ltr' && v !== 'rtl') continue;
      out[k] = v;
    } else if (k === 'role') {
      if (ROLES.has(v)) out.role = v;
    } else if (/^data-[a-z][a-z0-9-]{0,40}$/.test(k)) {
      out[k] = v;
    } else if (tag === 'a' && k === 'href') {
      const u = safeUrl(v);
      if (u) out.href = u;
    } else if (tag === 'a' && k === 'target') {
      if (v === '_blank' || v === '_self') out.target = v;
    } else if (tag === 'a' && k === 'rel') {
      const rel = v.split(/\s+/).filter((t) => REL.has(t)).join(' ');
      if (rel) out.rel = rel;
    } else if (tag === 'img' && k === 'src') {
      const u = safeImageSrc(v);
      if (u) out.src = u;
    } else if (tag === 'img' && (k === 'alt' || k === 'loading' && (v === 'lazy' || v === 'eager'))) {
      out[k] = v;
    } else if (tag === 'img' && (k === 'width' || k === 'height') && /^\d{1,4}$/.test(v)) {
      out[k] = v;
    } else if ((tag === 'td' || tag === 'th') && (k === 'colspan' || k === 'rowspan') && /^\d{1,2}$/.test(v)) {
      out[k] = v;
    } else if (tag === 'th' && k === 'scope' && /^(row|col|rowgroup|colgroup)$/.test(v)) {
      out.scope = v;
    } else if (tag === 'time' && k === 'datetime' && /^[0-9T:+\-.Z ]{1,40}$/.test(v)) {
      out.datetime = v;
    } else if (tag === 'button' && k === 'type' && v === 'button') {
      out.type = 'button';
    } else if (tag === 'details' && k === 'open') {
      out.open = '';
    } else if (k === 'hidden') {
      out.hidden = '';
    }
  }
  return out;
}

function cleanClasses(raw: unknown, attrs: unknown): string[] {
  const names: string[] = [];
  const push = (v: unknown) => {
    const name = typeof v === 'string' ? v : isObj(v) && typeof v.name === 'string' ? v.name : '';
    if (name && CLASS_NAME_RE.test(name) && !names.includes(name)) names.push(name);
  };
  if (Array.isArray(raw)) raw.slice(0, 40).forEach(push);
  // Tolerate class lists written as an attribute (templates, older data): merged here, never kept as an attribute.
  if (isObj(attrs) && typeof attrs.class === 'string') attrs.class.split(/\s+/).slice(0, 40).forEach(push);
  return names;
}

const FN_TAG: Record<string, string> = {
  'fn-section': 'section', 'fn-row': 'div', 'fn-column': 'div', 'fn-list': 'ul', 'fn-divider': 'hr', 'fn-spacer': 'div', 'fn-faq': 'div', 'fn-tabs': 'div', 'fn-popup': 'div', 'fn-box': 'div', 'fn-faq-item': 'details', 'fn-tab-nav': 'div', 'fn-tab-btn': 'button', 'fn-tab-panel': 'div', 'fn-popup-dialog': 'div',
  'fn-video': 'div', 'fn-countdown': 'div', 'fn-progress': 'div', 'fn-form': 'div', 'fn-checkout': 'div', 'fn-code': 'div', 'fn-button': 'a', 'fn-text': 'p', 'fn-heading': 'h2', 'fn-image': 'img',
};

function propIssue(path: string, label: string, err: z.ZodError, ctx: Ctx): void {
  for (const i of err.issues.slice(0, 5)) ctx.issues.push({ path: `${path}${i.path.length ? `.${i.path.join('.')}` : ''}`, message: `${label}: ${i.message}` });
}

function cleanNode(input: unknown, depth: number, path: string, ctx: Ctx): GjsNode | null {
  if (!isObj(input)) return null;
  const raw: Record<string, unknown> = typeof input.type === 'string' && isFnType(input.type) ? reconcileNode(input.type, input) : input;
  if (++ctx.nodes > PROJECT_LIMITS.maxNodes) {
    if (ctx.nodes === PROJECT_LIMITS.maxNodes + 1) ctx.issues.push({ path, message: `A page may contain at most ${PROJECT_LIMITS.maxNodes} elements` });
    return null;
  }
  if (depth > PROJECT_LIMITS.maxDepth) {
    ctx.issues.push({ path, message: `Elements may be nested at most ${PROJECT_LIMITS.maxDepth} levels deep` });
    return null;
  }
  const rawType = typeof raw.type === 'string' ? raw.type : 'default';
  if (rawType === 'textnode') return { type: 'textnode', content: str(raw.content, PROJECT_LIMITS.maxText) };
  const type = isFnType(rawType) || CORE_TYPES.has(rawType) ? rawType : 'default';
  let tag = typeof raw.tagName === 'string' ? raw.tagName.toLowerCase() : '';
  if (!TAGS.has(tag)) tag = FN_TAG[type] ?? (type === 'image' ? 'img' : type === 'link' ? 'a' : type === 'text' ? 'div' : 'div');
  // Fixed tags of the structural types keep their meaning (a divider is always <hr>, a section always <section>).
  if (type === 'fn-divider') tag = 'hr';
  if (type === 'fn-image' || type === 'image') tag = 'img';
  if (isDynamicType(type) || ['fn-section', 'fn-row', 'fn-column', 'fn-faq', 'fn-faq-item', 'fn-tabs', 'fn-tab-nav', 'fn-tab-btn', 'fn-tab-panel', 'fn-popup', 'fn-popup-dialog', 'fn-spacer'].includes(type)) tag = FN_TAG[type]!;
  if (type === 'fn-heading' && !/^h[1-6]$/.test(tag)) tag = 'h2';
  if (type === 'fn-button' && tag !== 'a' && tag !== 'button') tag = 'a';
  if (type === 'fn-list' && tag !== 'ul' && tag !== 'ol') tag = 'ul';

  // Key order is part of the canonical form (cleaning an already clean project must return it byte for byte): slots are reserved up front.
  const out: GjsNode = { type, tagName: tag, attributes: undefined, classes: undefined, name: undefined };
  const attributes = cleanAttributes(tag, raw.attributes, ctx, path);
  if (Object.keys(attributes).length) out.attributes = attributes;
  const classes = cleanClasses(raw.classes, raw.attributes);
  if (classes.length) out.classes = classes;
  const name = str(raw.name, 80) || str(raw.customName, 80);
  if (name) out.name = name;
  for (const k of FLAG_KEYS) {
    const v = raw[k];
    if (typeof v === 'boolean') out[k] = v;
    else if ((k === 'draggable' || k === 'droppable') && typeof v === 'string' && SELECTOR_FLAG.test(v)) out[k] = v;
  }
  if (isFnType(type)) out.fnV = String(COMPONENT_VERSION);

  if (raw.style && isObj(raw.style)) {
    const style = cleanDeclarations(raw.style);
    if (Object.keys(style).length) out.style = style;
  }

  // Typed props of the dynamic and behavioural components.
  const label = name || type;
  const need = (key: string, schema: z.ZodType, fallback?: unknown): unknown => {
    const value = raw[key] ?? fallback;
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    propIssue(`${path}.${key}`, label, r.error, ctx);
    return undefined;
  };
  switch (type) {
    case 'fn-button': {
      out.fnAction = need('fnAction', ButtonActionSchema, { type: 'none' });
      break;
    }
    case 'fn-form': {
      const p = need('fnForm', FormPropsSchema) as ReturnType<typeof FormPropsSchema.parse> | undefined;
      if (p) {
        out.fnForm = p;
        const id = ensureId(out, ctx, 'form');
        ctx.forms.push({ id, type: 'form', ...p } as FormBlock);
      }
      break;
    }
    case 'fn-checkout': {
      const p = need('fnProduct', ProductPropsSchema) as ReturnType<typeof ProductPropsSchema.parse> | undefined;
      if (p) {
        out.fnProduct = p;
        const id = ensureId(out, ctx, 'checkout');
        ctx.products.push({ id, type: 'checkout', ...p } as CheckoutBlock);
      }
      break;
    }
    case 'fn-video':
      out.fnVideo = need('fnVideo', VideoPropsSchema);
      break;
    case 'fn-countdown':
      out.fnCountdown = need('fnCountdown', CountdownPropsSchema);
      if (out.fnCountdown) ensureId(out, ctx, 'cd');
      break;
    case 'fn-progress':
      out.fnProgress = need('fnProgress', ProgressPropsSchema);
      break;
    case 'fn-code':
      out.fnCode = need('fnCode', CodePropsSchema);
      if (out.fnCode) ensureId(out, ctx, 'code');
      break;
    default:
      break;
  }

  if (isDynamicType(type) || VOID.has(tag)) return out;
  if (type === 'text' || type === 'fn-text' || type === 'fn-heading' || type === 'fn-tab-btn' || type === 'link' || type === 'label') {
    // Text content that was never split into components (pasted or older data) is kept as escaped text.
    const c = str(raw.content, PROJECT_LIMITS.maxText);
    if (c && !Array.isArray(raw.components)) out.components = [{ type: 'textnode', content: c }];
  }
  if (Array.isArray(raw.components)) {
    const kids: GjsNode[] = [];
    for (const [i, child] of raw.components.entries()) {
      const c = cleanNode(child, depth + 1, `${path}.components.${i}`, ctx);
      if (c) kids.push(c);
    }
    if (kids.length) out.components = kids;
  }
  return out;
}

/** Form, checkout and countdown components need a stable unique id (public endpoints and storage keys refer to it). */
function ensureId(node: GjsNode, ctx: Ctx, prefix: string): string {
  const attrs = (node.attributes ?? {}) as Record<string, string>;
  let id = attrs.id;
  if (!id) {
    do id = `${prefix}${++ctx.serial}`;
    while (ctx.ids.has(id) || ctx.allIds.has(id));
    ctx.ids.add(id);
    node.attributes = { ...attrs, id };
  }
  return id;
}

export function cleanRule(raw: unknown): GjsRule | null {
  if (!isObj(raw)) return null;
  const style = cleanDeclarations(raw.style);
  if (Object.keys(style).length === 0) return null;
  const rule: GjsRule = { style };
  if (Array.isArray(raw.selectors)) {
    const sels: GjsRule['selectors'] = [];
    for (const s of raw.selectors.slice(0, 8)) {
      if (typeof s === 'string') {
        const name = s.replace(/^[.#]/, '');
        if (!(s.startsWith('#') ? ID_RE.test(name) : CLASS_NAME_RE.test(name))) return null;
        sels.push(s.startsWith('#') ? `#${name}` : name);
      } else if (isObj(s) && typeof s.name === 'string') {
        const isId = s.type === 2;
        if (!(isId ? ID_RE.test(s.name) : CLASS_NAME_RE.test(s.name))) return null;
        sels.push(isId ? { name: s.name, type: 2 } : s.name);
      } else return null;
    }
    if (sels.length) rule.selectors = sels;
  }
  if (raw.selectorsAdd !== undefined && raw.selectorsAdd !== '') {
    const add = safeSelectorAdd(raw.selectorsAdd);
    if (!add) return null;
    rule.selectorsAdd = add;
  }
  if (!rule.selectors && !rule.selectorsAdd) return null;
  if (raw.mediaText !== undefined && raw.mediaText !== '') {
    const m = safeMediaText(raw.mediaText);
    if (!m) return null;
    rule.mediaText = m;
    rule.atRuleType = 'media';
  } else if (raw.atRuleType !== undefined && raw.atRuleType !== '') return null; // keyframes and other at-rules are not supported
  if (raw.state !== undefined && raw.state !== '') {
    if (!isAllowedState(raw.state)) return null;
    rule.state = raw.state;
  }
  return rule;
}

export function emptyProject(): GjsProject {
  return { assets: [], styles: [], pages: [{ frames: [{ component: { type: 'wrapper', components: [] } }] }] };
}

/** Validates and rebuilds project data. Fatal problems are returned as issues (and nothing is stored); everything dangerous is silently dropped. */
export function cleanProject(input: unknown): CleanResult | CleanFailure {
  if (!isObj(input)) return { ok: false, issues: [{ path: 'project', message: 'Project must be an object' }] };
  const tooBig = exceedsLimits(input);
  if (tooBig) return { ok: false, issues: [{ path: 'project', message: tooBig }] };
  let bytes = 0;
  try {
    bytes = JSON.stringify(input).length;
  } catch {
    return { ok: false, issues: [{ path: 'project', message: 'Project is not valid JSON data' }] };
  }
  if (bytes > PROJECT_LIMITS.maxBytes) return { ok: false, issues: [{ path: 'project', message: 'Project is too large' }] };

  const pages = Array.isArray(input.pages) ? input.pages : [];
  const frame = isObj(pages[0]) && Array.isArray(pages[0].frames) ? pages[0].frames[0] : undefined;
  const wrapper = isObj(frame) && isObj(frame.component) ? frame.component : { type: 'wrapper', components: [] };
  const ctx: Ctx = { nodes: 0, issues: [], notes: [], ids: new Set(), allIds: new Set(), forms: [], products: [], serial: 0 };
  // Existing ids first, so generated ones never collide with ids that style rules already reference.
  collectIds(wrapper, ctx.allIds);
  const kids: GjsNode[] = [];
  const raw = Array.isArray(wrapper.components) ? wrapper.components : [];
  for (const [i, c] of raw.entries()) {
    const n = cleanNode(c, 1, `components.${i}`, ctx);
    if (n) kids.push(n);
  }
  const wrapperOut: GjsNode = { type: 'wrapper', components: kids };
  const wClasses = cleanClasses(wrapper.classes, wrapper.attributes);
  if (wClasses.length) wrapperOut.classes = wClasses;
  const wAttrs = cleanAttributes('div', wrapper.attributes, ctx, 'wrapper');
  if (wAttrs.id) wrapperOut.attributes = { id: wAttrs.id };
  if (isObj(wrapper.style)) {
    const s = cleanDeclarations(wrapper.style);
    if (Object.keys(s).length) wrapperOut.style = s;
  }
  const rawStyles = Array.isArray(input.styles) ? input.styles : [];
  if (rawStyles.length > PROJECT_LIMITS.maxRules) ctx.issues.push({ path: 'styles', message: `A page may contain at most ${PROJECT_LIMITS.maxRules} style rules` });
  const styles: GjsRule[] = [];
  for (const r of rawStyles.slice(0, PROJECT_LIMITS.maxRules)) {
    const c = cleanRule(r);
    if (c) styles.push(c);
  }
  const assets: GjsProject['assets'] = [];
  if (Array.isArray(input.assets)) {
    for (const a of input.assets.slice(0, 500)) {
      if (!isObj(a)) continue;
      const src = safeImageSrc(a.src);
      if (!src || src.startsWith('data:')) continue;
      assets.push({ type: 'image', src, ...(typeof a.name === 'string' ? { name: a.name.slice(0, 120) } : {}) });
    }
  }
  if (ctx.issues.length) return { ok: false, issues: ctx.issues.slice(0, 20) };
  const seenProductIds = new Set<string>();
  for (const f of [...ctx.forms, ...ctx.products]) {
    if (seenProductIds.has(f.id)) return { ok: false, issues: [{ path: f.id, message: `Duplicate id "${f.id}"` }] };
    seenProductIds.add(f.id);
  }
  return {
    ok: true,
    project: { assets, styles, pages: [{ frames: [{ component: wrapperOut }] }] },
    forms: ctx.forms,
    products: ctx.products,
    notes: ctx.notes,
  };
}

function collectIds(node: unknown, ids: Set<string>, depth = 0): void {
  if (!isObj(node) || depth > PROJECT_LIMITS.maxDepth + 2) return;
  const id = isObj(node.attributes) ? node.attributes.id : undefined;
  if (typeof id === 'string') ids.add(id);
  if (Array.isArray(node.components)) for (const c of node.components) collectIds(c, ids, depth + 1);
}

export function wrapperOf(p: GjsProject): GjsNode {
  return p.pages[0]!.frames[0]!.component;
}

export function childrenOf(n: GjsNode): GjsNode[] {
  return Array.isArray(n.components) ? (n.components as GjsNode[]) : [];
}

/** Depth-first walk over every component (not the wrapper itself). */
export function walk(root: GjsNode, fn: (n: GjsNode, parent: GjsNode) => void): void {
  for (const c of childrenOf(root)) {
    fn(c, root);
    walk(c, fn);
  }
}

export function textOf(n: GjsNode): string {
  if (n.type === 'textnode') return typeof n.content === 'string' ? n.content : '';
  return childrenOf(n).map(textOf).join('');
}

export function firstHeadingOfProject(p: GjsProject): string | null {
  let found: string | null = null;
  walk(wrapperOf(p), (n) => {
    if (!found && typeof n.tagName === 'string' && /^h[1-6]$/.test(n.tagName)) {
      const t = textOf(n).trim();
      if (t) found = t;
    }
  });
  return found;
}
