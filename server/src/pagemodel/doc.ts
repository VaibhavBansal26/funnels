import { parseDocument } from '../blocks/schema.js';
import type { CheckoutBlock, FormBlock } from '../blocks/schema.js';
import { convertDocument, isLegacyDocument } from './convert.js';
import { sanitizeCss } from './cssfilter.js';
import { sanitizeUserHtml } from './htmlfilter.js';
import { createPageBuilder } from './shared/build.js';
import { PROJECT_VERSION, childrenOf, cleanProject, firstHeadingOfProject, walk, wrapperOf, type GjsNode, type GjsProject, type Issue } from './shared/clean.js';
import type { CodeProps } from './shared/props.js';

/**
 * The stored page document, version 2: the GrapesJS project (the editable source of truth) plus the server-derived `forms` and
 * `products`. Those two lists are always recomputed from the cleaned project on save and never read from the request, so a client
 * cannot choose a price or a form definition. Version 1 (legacy block trees) is converted on first read or write.
 */
export interface ProjectDoc {
  version: typeof PROJECT_VERSION;
  project: GjsProject;
  forms: FormBlock[];
  products: CheckoutBlock[];
}

export type DocResult = { ok: true; doc: ProjectDoc; notes: string[] } | { ok: false; issues: Issue[] };

export interface NormalizeOptions {
  /** May the saver author scripts (custom code `js`, raw HTML)? Otherwise code a user did not already have is stripped. */
  scriptsOk?: boolean;
  /** The currently stored document, used to keep code blocks the saver did not touch. */
  previous?: ProjectDoc | null;
}

function codeById(doc: ProjectDoc | null | undefined): Map<string, CodeProps> {
  const m = new Map<string, CodeProps>();
  if (!doc) return m;
  walk(wrapperOf(doc.project), (n) => {
    const id = ((n.attributes as Record<string, string> | undefined) ?? {}).id;
    if (n.type === 'fn-code' && id && n.fnCode) m.set(id, n.fnCode as CodeProps);
  });
  return m;
}

/** Accepts a version-2 document or a legacy block document and returns the cleaned version-2 document (or the reasons it was refused). */
export function normalizeDoc(raw: unknown, opts: NormalizeOptions = {}): DocResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, issues: [{ path: 'doc', message: 'Document must be an object' }] };
  const o = raw as Record<string, unknown>;
  let project: unknown;
  const notes: string[] = [];
  if (o.version === PROJECT_VERSION) {
    project = o.project;
  } else if (typeof o.version === 'number' && o.version > PROJECT_VERSION) {
    return { ok: false, issues: [{ path: 'version', message: `Unsupported document version ${o.version}` }] };
  } else {
    const legacy = parseDocument(raw);
    if (!legacy.ok) return { ok: false, issues: legacy.issues };
    const c = convertDocument(legacy.doc);
    project = c.project;
    notes.push(...c.notes);
  }
  const cleaned = cleanProject(project);
  if (!cleaned.ok) return cleaned;
  notes.push(...cleaned.notes);
  if (!opts.scriptsOk) {
    const prev = codeById(opts.previous);
    walk(wrapperOf(cleaned.project), (n) => {
      if (n.type !== 'fn-code') return;
      const id = ((n.attributes as Record<string, string> | undefined) ?? {}).id;
      const code = n.fnCode as CodeProps;
      const before = id ? prev.get(id) : undefined;
      if (before && before.html === code.html && before.css === code.css && before.js === code.js) return; // untouched: keep
      // New or edited code from an account that may not author scripts is reduced to what it could publish anyway: sanitised HTML and CSS, no script.
      const safe = { html: sanitizeUserHtml(code.html), css: sanitizeCss(code.css), js: '' };
      if (safe.html !== code.html || safe.css !== code.css || code.js) {
        n.fnCode = safe;
        notes.push(`Custom code "${id ?? ''}" was reduced to safe HTML and CSS: this account may not author scripts`);
      }
    });
  }
  return { ok: true, doc: { version: PROJECT_VERSION, project: cleaned.project, forms: cleaned.forms, products: cleaned.products }, notes };
}

/** Parses a stored `doc_json`. Legacy documents are converted on the fly; a document that no longer validates opens as an empty page. */
export function loadDoc(json: string): ProjectDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  const r = normalizeDoc(raw, { scriptsOk: true });
  return r.ok ? r.doc : emptyDoc();
}

export const isStoredAsProject = (json: string): boolean => /^\s*\{\s*"version"\s*:\s*2\b/.test(json);
export { isLegacyDocument };

export function emptyDoc(): ProjectDoc {
  return { version: PROJECT_VERSION, project: createPageBuilder('e').project([]), forms: [], products: [] };
}

export function defaultStepDoc(headline = 'Your headline goes here'): ProjectDoc {
  const pm = createPageBuilder('d');
  const project = pm.project([
    pm.section(
      [
        pm.stack([
          pm.eyebrow('Welcome', { align: 'center' }),
          pm.heading(headline, { level: 1, align: 'center' }),
          pm.text('Tell visitors what they get and why it matters. Drag blocks from the left panel, click any text to edit it.', { align: 'center', muted: true }),
          pm.button('Continue', { type: 'next_step' }, { size: 'lg', align: 'center' }),
        ]),
      ],
      { width: 'medium', padding: 'xl', align: 'center' },
    ),
  ]);
  const r = normalizeDoc({ version: PROJECT_VERSION, project }, { scriptsOk: true });
  if (!r.ok) throw new Error('default document invalid');
  return r.doc;
}

/** First heading text of a stored document (either version) without the cost of a full clean: used for list thumbnails. */
export function headingOfJson(json: string): string | null {
  try {
    const raw = JSON.parse(json) as { version?: number; project?: GjsProject; blocks?: Array<Record<string, unknown>> };
    if (raw.version === PROJECT_VERSION && raw.project) return firstHeadingOfProject(raw.project);
    const found = legacyHeading(raw.blocks ?? []);
    return found;
  } catch {
    return null;
  }
}

function legacyHeading(blocks: Array<Record<string, unknown>>): string | null {
  for (const b of blocks) {
    if (b.type === 'heading' && typeof b.text === 'string' && b.text.trim()) return b.text.trim();
    const kids = Array.isArray(b.children) ? (b.children as Array<Record<string, unknown>>) : Array.isArray(b.columns) ? (b.columns as Array<{ children?: Array<Record<string, unknown>> }>).flatMap((c) => c.children ?? []) : [];
    const hit = legacyHeading(kids);
    if (hit) return hit;
  }
  return null;
}

export const firstHeadingOfDoc = (doc: ProjectDoc): string | null => firstHeadingOfProject(doc.project);

/** Deep-copies a document and rewrites "go to step" button actions through `idMap` (old step id -> new step id). Unknown ids fall back to "next step". */
export function remapStepRefs(doc: ProjectDoc, idMap: Map<string, string>): ProjectDoc {
  const copy = structuredClone(doc);
  walk(wrapperOf(copy.project), (n: GjsNode) => {
    const a = n.fnAction as { type?: string; stepId?: string } | undefined;
    if (a?.type === 'step') {
      const target = a.stepId ? idMap.get(a.stepId) : undefined;
      n.fnAction = target ? { type: 'step', stepId: target } : { type: 'next_step' };
    }
  });
  return copy;
}

export { childrenOf };
