import { isSuspended } from './suspension.js';
import type { CheckoutBlock, FormBlock } from '../blocks/index.js';
import { loadDoc, type ProjectDoc } from '../pagemodel/doc.js';
import type { Deps } from '../deps.js';
import { AppError, notFound } from '../errors.js';
import type { FunnelRow, StepRow } from '../repos/types.js';

export interface PublicTarget<B extends FormBlock | CheckoutBlock> {
  funnel: FunnelRow;
  step: StepRow;
  block: B;
  workspaceId: string;
  doc: ProjectDoc;
}

/**
 * Resolves the (funnel, step, block) a public request addresses. The workspace is derived from the
 * funnel, never from the request. Unknown, trashed or mismatched ids are all the same 404.
 */
export async function resolvePublicBlock<T extends 'form' | 'checkout'>(
  deps: Deps,
  funnelId: string,
  stepId: string,
  blockId: string,
  type: T,
): Promise<PublicTarget<T extends 'form' ? FormBlock : CheckoutBlock>> {
  const funnel = await deps.db.get<FunnelRow>('SELECT * FROM funnels WHERE id = ? AND deleted_at IS NULL', funnelId);
  const step = funnel ? await deps.db.get<StepRow>('SELECT * FROM steps WHERE id = ? AND funnel_id = ?', stepId, funnelId) : undefined;
  const page = step ? await deps.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', stepId) : undefined;
  if (!funnel || !step || !page) throw notFound('Form');
  if (await isSuspended(deps, funnel.workspace_id)) throw new AppError(503, 'SITE_UNAVAILABLE', 'This site is currently unavailable');
  // The definitions come from the server-derived lists stored with the document (never from page HTML or the request).
  const doc = readDoc(page.doc_json);
  const block = type === 'form' ? doc.forms.find((f) => f.id === blockId) : doc.products.find((p) => p.id === blockId);
  if (!block) throw notFound('Form');
  return { funnel, step, block: block as never, workspaceId: funnel.workspace_id, doc };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function sanitizeUtms(input: unknown): Record<string, string> | null {
  if (typeof input !== 'object' || input === null) return null;
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}

/** Stored version-2 documents are used as they are (their lists were derived and validated on save); anything older is converted first. */
function readDoc(json: string): ProjectDoc {
  try {
    const raw = JSON.parse(json) as Partial<ProjectDoc>;
    if (raw.version === 2 && Array.isArray(raw.forms) && Array.isArray(raw.products)) return raw as ProjectDoc;
  } catch {
    /* converted below */
  }
  return loadDoc(json);
}
