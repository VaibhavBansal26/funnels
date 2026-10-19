import { collectBlocks, type PageDocument } from '../blocks/index.js';

/** Deep-copies a document and rewrites "go to step" button actions through `idMap` (old step id -> new step id). Unknown ids fall back to "next step". */
export function remapStepRefs(doc: PageDocument, idMap: Map<string, string>): PageDocument {
  const copy = structuredClone(doc);
  for (const b of collectBlocks(copy.blocks)) {
    if (b.type === 'button' && b.action.type === 'step') {
      const target = idMap.get(b.action.stepId);
      b.action = target ? { type: 'step', stepId: target } : { type: 'next_step' };
    }
  }
  return copy;
}
