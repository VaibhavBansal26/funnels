import { collectBlocks, LIMITS, measure, type Block, type PageDocument } from '@blocks';

/** Where a block lives: top level (parentId null) or inside a section (slot 0) / one column of a columns block (slot = column index). */
export interface Loc {
  parentId: string | null;
  slot: number;
  index: number;
}

export type Container = Extract<Block, { type: 'section' | 'columns' }>;
export const isContainer = (b: Block | null | undefined): b is Container => !!b && (b.type === 'section' || b.type === 'columns');

/** The mutable child list for a location in a (cloned) document, or null when the parent does not exist. */
function listAt(blocks: Block[], parentId: string | null, slot: number): Block[] | null {
  if (parentId === null) return blocks;
  const parent = collectBlocks(blocks).find((b) => b.id === parentId);
  if (!parent) return null;
  if (parent.type === 'section') return slot === 0 ? parent.children : null;
  if (parent.type === 'columns') return parent.columns[slot]?.children ?? null;
  return null;
}

export function findBlock(doc: Pick<PageDocument, 'blocks'>, id: string): { block: Block; loc: Loc } | null {
  const walk = (list: Block[], parentId: string | null, slot: number): { block: Block; loc: Loc } | null => {
    for (let index = 0; index < list.length; index++) {
      const b = list[index]!;
      if (b.id === id) return { block: b, loc: { parentId, slot, index } };
      if (b.type === 'section') {
        const hit = walk(b.children, b.id, 0);
        if (hit) return hit;
      } else if (b.type === 'columns') {
        for (let c = 0; c < b.columns.length; c++) {
          const hit = walk(b.columns[c]!.children, b.id, c);
          if (hit) return hit;
        }
      }
    }
    return null;
  };
  return walk(doc.blocks, null, 0);
}

const clone = (doc: PageDocument): PageDocument => structuredClone(doc);

/** Whether the resulting document still respects the block-count and nesting limits. */
export const withinLimits = (doc: PageDocument): boolean => {
  const m = measure(doc.blocks);
  return m.count <= LIMITS.maxBlocks && m.depth <= LIMITS.maxDepth;
};

/** Returns null when the location is invalid or the limits would be exceeded. */
export function insertAt(doc: PageDocument, loc: Loc, block: Block): PageDocument | null {
  const next = clone(doc);
  const list = listAt(next.blocks, loc.parentId, loc.slot);
  if (!list) return null;
  list.splice(Math.max(0, Math.min(loc.index, list.length)), 0, structuredClone(block));
  return withinLimits(next) ? next : null;
}

export function removeBlock(doc: PageDocument, id: string): PageDocument {
  const next = clone(doc);
  const hit = findBlock(next, id);
  if (!hit) return doc;
  listAt(next.blocks, hit.loc.parentId, hit.loc.slot)!.splice(hit.loc.index, 1);
  return next;
}

export function updateBlock(doc: PageDocument, id: string, patch: Record<string, unknown>): PageDocument {
  const next = clone(doc);
  const hit = findBlock(next, id);
  if (!hit) return doc;
  Object.assign(hit.block, patch);
  return next;
}

/** Moves `id` to `loc`. The target index refers to the list *before* removal, so dropping "after myself" is a no-op. Containers cannot move into themselves. */
export function moveTo(doc: PageDocument, id: string, loc: Loc): PageDocument | null {
  const src = findBlock(doc, id);
  if (!src) return null;
  if (loc.parentId !== null && (loc.parentId === id || findBlock({ blocks: [src.block] }, loc.parentId))) return null;
  const next = clone(doc);
  const hit = findBlock(next, id)!;
  const sameList = hit.loc.parentId === loc.parentId && hit.loc.slot === loc.slot;
  listAt(next.blocks, hit.loc.parentId, hit.loc.slot)!.splice(hit.loc.index, 1);
  const target = listAt(next.blocks, loc.parentId, loc.slot);
  if (!target) return null;
  const index = sameList && loc.index > hit.loc.index ? loc.index - 1 : loc.index;
  target.splice(Math.max(0, Math.min(index, target.length)), 0, hit.block);
  return withinLimits(next) ? next : null;
}

/** One step up (-1) or down (+1) inside the block's own list. */
export function moveBy(doc: PageDocument, id: string, delta: -1 | 1): PageDocument | null {
  const hit = findBlock(doc, id);
  if (!hit) return null;
  const list = listAt(doc.blocks, hit.loc.parentId, hit.loc.slot)!;
  const to = hit.loc.index + delta;
  if (to < 0 || to >= list.length) return null;
  return moveTo(doc, id, { ...hit.loc, index: delta === 1 ? to + 1 : to });
}

/** Moves a block out of its container, directly after that container. */
export function moveOut(doc: PageDocument, id: string): PageDocument | null {
  const hit = findBlock(doc, id);
  if (!hit || hit.loc.parentId === null) return null;
  const parent = findBlock(doc, hit.loc.parentId)!;
  return moveTo(doc, id, { ...parent.loc, index: parent.loc.index + 1 });
}

/** Moves a block into the container just before it (appended to the end of its last column / children). */
export function moveIntoPrevious(doc: PageDocument, id: string): PageDocument | null {
  const hit = findBlock(doc, id);
  if (!hit || hit.loc.index === 0) return null;
  const list = listAt(doc.blocks, hit.loc.parentId, hit.loc.slot)!;
  const prev = list[hit.loc.index - 1]!;
  if (!isContainer(prev)) return null;
  const slot = prev.type === 'columns' ? prev.columns.length - 1 : 0;
  const children = prev.type === 'columns' ? prev.columns[slot]!.children : prev.children;
  return moveTo(doc, id, { parentId: prev.id, slot, index: children.length });
}

/** A deep copy of a block (and its descendants) with fresh ids from `nextId`. */
export function cloneWithNewIds(block: Block, nextId: () => string): Block {
  const copy = structuredClone(block);
  const walk = (b: Block) => {
    b.id = nextId();
    if (b.type === 'section') b.children.forEach(walk);
    if (b.type === 'columns') b.columns.forEach((c) => { c.id = nextId(); c.children.forEach(walk); });
  };
  walk(copy);
  return copy;
}

export function duplicateBlock(doc: PageDocument, id: string, nextId: () => string): { doc: PageDocument; newId: string } | null {
  const hit = findBlock(doc, id);
  if (!hit) return null;
  const copy = cloneWithNewIds(hit.block, nextId);
  const next = insertAt(doc, { ...hit.loc, index: hit.loc.index + 1 }, copy);
  return next ? { doc: next, newId: copy.id } : null;
}

/** Sensible default placement for a new block: into the selected container, else right after the selected block, else at the end. */
export function defaultLoc(doc: PageDocument, selectedId: string | null): Loc {
  const sel = selectedId ? findBlock(doc, selectedId) : null;
  if (!sel) return { parentId: null, slot: 0, index: doc.blocks.length };
  const b = sel.block;
  if (b.type === 'section') return { parentId: b.id, slot: 0, index: b.children.length };
  if (b.type === 'columns') {
    const slot = b.columns.length - 1;
    return { parentId: b.id, slot, index: b.columns[slot]!.children.length };
  }
  return { ...sel.loc, index: sel.loc.index + 1 };
}

/** Ids in the order a keyboard user walks the outline. */
export function visibleIds(doc: Pick<PageDocument, 'blocks'>): string[] {
  return collectBlocks(doc.blocks).map((b) => b.id);
}

export function addColumn(doc: PageDocument, columnsId: string, newId: string): PageDocument | null {
  const hit = findBlock(doc, columnsId);
  if (!hit || hit.block.type !== 'columns' || hit.block.columns.length >= 5) return null;
  const next = clone(doc);
  const b = findBlock(next, columnsId)!.block as Extract<Block, { type: 'columns' }>;
  b.columns.push({ id: newId, children: [] });
  return next;
}

/** Removes a column, appending its children to the previous column so no content is lost. Needs at least two columns. */
export function removeColumn(doc: PageDocument, columnsId: string, slot: number): PageDocument | null {
  const hit = findBlock(doc, columnsId);
  if (!hit || hit.block.type !== 'columns' || hit.block.columns.length < 2 || !hit.block.columns[slot]) return null;
  const next = clone(doc);
  const b = findBlock(next, columnsId)!.block as Extract<Block, { type: 'columns' }>;
  const [removed] = b.columns.splice(slot, 1);
  b.columns[Math.max(0, slot - 1)]!.children.push(...removed!.children);
  return next;
}

export type DropZone = 'before' | 'after' | 'into';

/** Resolves a drag-and-drop target (a node and the zone of it that was hit) to an insertion location. */
export function dropLoc(doc: Pick<PageDocument, 'blocks'>, targetId: string, zone: DropZone): Loc | null {
  const hit = findBlock(doc, targetId);
  if (!hit) return null;
  if (zone === 'before') return hit.loc;
  if (zone === 'into' && isContainer(hit.block)) {
    const b = hit.block;
    const slot = b.type === 'columns' ? b.columns.length - 1 : 0;
    return { parentId: b.id, slot, index: (b.type === 'columns' ? b.columns[slot]!.children : b.children).length };
  }
  return { ...hit.loc, index: hit.loc.index + 1 };
}
