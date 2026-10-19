import { newBlock, type Block, type BlockType, type PageDocument } from '@blocks';
import { collectBlocks } from '@blocks';
import { uniqueId } from './ids';
import { addColumn, defaultLoc, duplicateBlock, findBlock, insertAt, moveBy, moveIntoPrevious, moveOut, moveTo, removeBlock, removeColumn, updateBlock, type Loc } from './tree';

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 1000;

export interface BuilderState {
  doc: PageDocument;
  past: PageDocument[];
  future: PageDocument[];
  selectedId: string | null;
  savedJson: string;
  version: number;
  notice: string | null;
  lastEdit: { key: string; at: number } | null;
}

export type BuilderAction =
  | { type: 'load'; doc: PageDocument; version: number }
  | { type: 'saved'; version: number; doc: PageDocument }
  | { type: 'select'; id: string | null }
  | { type: 'add'; blockType: BlockType; id: string; loc?: Loc }
  | { type: 'insert'; block: Block; loc?: Loc }
  | { type: 'update'; id: string; patch: Record<string, unknown>; coalesce?: string; now?: number }
  | { type: 'remove'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'moveBy'; id: string; delta: -1 | 1 }
  | { type: 'moveTo'; id: string; loc: Loc }
  | { type: 'moveOut'; id: string }
  | { type: 'moveIntoPrevious'; id: string }
  | { type: 'addColumn'; id: string }
  | { type: 'removeColumn'; id: string; slot: number }
  | { type: 'settings'; patch: Partial<PageDocument['settings']> }
  | { type: 'replace'; doc: PageDocument }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'dismissNotice' };

export const initialState = (doc: PageDocument, version = 0): BuilderState => ({ doc, past: [], future: [], selectedId: null, savedJson: JSON.stringify(doc), version, notice: null, lastEdit: null });

export const isDirty = (s: BuilderState): boolean => JSON.stringify(s.doc) !== s.savedJson;
export const canUndo = (s: BuilderState): boolean => s.past.length > 0;
export const canRedo = (s: BuilderState): boolean => s.future.length > 0;

const LIMIT_NOTICE = 'That would exceed the limit of 400 blocks or 4 nesting levels.';

/** Records the current document in history and installs `doc` as the new present. Clears redo and any edit-coalescing window. */
function commit(s: BuilderState, doc: PageDocument, extra: Partial<BuilderState> = {}): BuilderState {
  return { ...s, doc, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: [], notice: null, lastEdit: null, ...extra };
}

const idsOf = (doc: PageDocument) => new Set(collectBlocks(doc.blocks).flatMap((b) => [b.id, ...(b.type === 'columns' ? b.columns.map((c) => c.id) : [])]));

export function builderReducer(s: BuilderState, a: BuilderAction): BuilderState {
  switch (a.type) {
    case 'load':
      return initialState(a.doc, a.version);
    case 'saved':
      // The saved snapshot is the document that was sent, so edits made while the request was in flight stay marked as unsaved.
      return { ...s, savedJson: JSON.stringify(a.doc), version: a.version };
    case 'select':
      return s.selectedId === a.id ? s : { ...s, selectedId: a.id };
    case 'add': {
      const loc = a.loc ?? defaultLoc(s.doc, s.selectedId);
      const next = insertAt(s.doc, loc, newBlock(a.blockType, a.id));
      return next ? commit(s, next, { selectedId: a.id }) : { ...s, notice: LIMIT_NOTICE };
    }
    case 'insert': {
      const next = insertAt(s.doc, a.loc ?? defaultLoc(s.doc, s.selectedId), a.block);
      return next ? commit(s, next, { selectedId: a.block.id }) : { ...s, notice: LIMIT_NOTICE };
    }
    case 'update': {
      if (!findBlock(s.doc, a.id)) return s;
      const next = updateBlock(s.doc, a.id, a.patch);
      const now = a.now ?? Date.now();
      // Typing in a field produces one history entry per burst, not one per keystroke.
      if (a.coalesce && s.lastEdit?.key === a.coalesce && now - s.lastEdit.at < COALESCE_MS) return { ...s, doc: next, future: [], lastEdit: { key: a.coalesce, at: now } };
      return commit(s, next, { lastEdit: a.coalesce ? { key: a.coalesce, at: now } : null });
    }
    case 'remove': {
      if (!findBlock(s.doc, a.id)) return s;
      const hit = findBlock(s.doc, a.id)!;
      return commit(s, removeBlock(s.doc, a.id), { selectedId: s.selectedId === a.id || (s.selectedId && findBlock({ blocks: [hit.block] }, s.selectedId)) ? null : s.selectedId });
    }
    case 'duplicate': {
      const taken = idsOf(s.doc);
      const r = duplicateBlock(s.doc, a.id, () => uniqueId(taken));
      return r ? commit(s, r.doc, { selectedId: r.newId }) : { ...s, notice: LIMIT_NOTICE };
    }
    case 'moveBy': {
      const next = moveBy(s.doc, a.id, a.delta);
      return next ? commit(s, next) : s;
    }
    case 'moveTo': {
      const next = moveTo(s.doc, a.id, a.loc);
      if (!next) return { ...s, notice: findBlock(s.doc, a.id) ? LIMIT_NOTICE : null };
      return JSON.stringify(next) === JSON.stringify(s.doc) ? s : commit(s, next);
    }
    case 'moveOut': {
      const next = moveOut(s.doc, a.id);
      return next ? commit(s, next) : s;
    }
    case 'moveIntoPrevious': {
      const next = moveIntoPrevious(s.doc, a.id);
      return next ? commit(s, next) : { ...s, notice: LIMIT_NOTICE };
    }
    case 'addColumn': {
      const next = addColumn(s.doc, a.id, uniqueId(idsOf(s.doc), 'c'));
      return next ? commit(s, next) : s;
    }
    case 'removeColumn': {
      const next = removeColumn(s.doc, a.id, a.slot);
      return next ? commit(s, next) : s;
    }
    case 'settings':
      return commit(s, { ...s.doc, settings: { ...s.doc.settings, ...a.patch } });
    case 'replace':
      return commit(s, a.doc, { selectedId: null });
    case 'undo': {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { ...s, doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT), lastEdit: null, notice: null, selectedId: s.selectedId && findBlock(prev, s.selectedId) ? s.selectedId : null };
    }
    case 'redo': {
      const [next, ...rest] = s.future;
      if (!next) return s;
      return { ...s, doc: next, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: rest, lastEdit: null, notice: null, selectedId: s.selectedId && findBlock(next, s.selectedId) ? s.selectedId : null };
    }
    case 'dismissNotice':
      return { ...s, notice: null };
  }
}
