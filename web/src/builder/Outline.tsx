import { useState } from 'react';
import type { Block, BlockType } from '@blocks';
import { BLOCK_LABELS } from './Inspector';
import { dropLoc, isContainer, visibleIds, type DropZone, type Loc } from './tree';

export const DRAG_MOVE = 'application/x-fn-move';
export const DRAG_ADD = 'application/x-fn-add';

const snippet = (b: Block): string => {
  const t = (b as { text?: string; productName?: string; name?: string }).text ?? (b as { productName?: string }).productName ?? (b as { name?: string }).name ?? '';
  return t.length > 28 ? `${t.slice(0, 28)}…` : t;
};

interface Props {
  blocks: Block[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMoveTo: (id: string, loc: Loc) => void;
  onAdd: (type: BlockType, loc: Loc) => void;
  onMoveBy: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
}

/** Structure tree. Blocks can be reordered by drag and drop or from the keyboard (Alt+Arrow moves the focused block, Delete removes it). */
export function Outline({ blocks, selectedId, onSelect, onMoveTo, onAdd, onMoveBy, onRemove }: Props) {
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  const doc = { blocks };

  const handleDrop = (e: React.DragEvent, loc: Loc | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    if (!loc) return;
    const move = e.dataTransfer.getData(DRAG_MOVE);
    const add = e.dataTransfer.getData(DRAG_ADD);
    if (move) onMoveTo(move, loc);
    else if (add) onAdd(add as BlockType, loc);
  };

  const zoneOf = (e: React.DragEvent, container: boolean): DropZone => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / (r.height || 1);
    return y < 0.3 ? 'before' : y > 0.7 ? 'after' : container ? 'into' : y < 0.5 ? 'before' : 'after';
  };

  const focusNeighbor = (id: string, delta: number) => {
    const ids = visibleIds(doc);
    const next = ids[ids.indexOf(id) + delta];
    if (next) {
      onSelect(next);
      document.querySelector<HTMLElement>(`[data-node="${next}"]`)?.focus();
    }
  };

  const renderList = (list: Block[]) => (
    <ul role="group">
      {list.map((b) => (
        <li key={b.id} role="none">
          <div
            role="treeitem"
            tabIndex={selectedId === b.id || (!selectedId && blocks[0]?.id === b.id) ? 0 : -1}
            aria-selected={selectedId === b.id}
            data-node={b.id}
            className={`node${drop?.id === b.id ? ` drop-${drop.zone === 'into' ? 'into' : 'before'}` : ''}`}
            style={drop?.id === b.id && drop.zone === 'after' ? { boxShadow: '0 2px 0 var(--primary)' } : undefined}
            draggable
            onClick={(e) => { e.stopPropagation(); onSelect(b.id); }}
            onDragStart={(e) => { e.dataTransfer.setData(DRAG_MOVE, b.id); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDrop({ id: b.id, zone: zoneOf(e, isContainer(b)) }); }}
            onDragLeave={() => setDrop((d) => (d?.id === b.id ? null : d))}
            onDrop={(e) => handleDrop(e, dropLoc(doc, b.id, zoneOf(e, isContainer(b))))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (e.altKey) onMoveBy(b.id, e.key === 'ArrowDown' ? 1 : -1);
                else focusNeighbor(b.id, e.key === 'ArrowDown' ? 1 : -1);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                onRemove(b.id);
              } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(b.id);
              }
            }}
          >
            <span aria-hidden="true" className="muted">⋮⋮</span>
            <span className="label"><strong>{BLOCK_LABELS[b.type]}</strong> <span className="muted">{snippet(b)}</span></span>
          </div>
          {b.type === 'section' ? renderList(b.children) : null}
          {b.type === 'columns' ? (
            <ul role="group">
              {b.columns.map((c, i) => (
                <li key={c.id} role="none">
                  <div className={`node${drop?.id === `${b.id}:${i}` ? ' drop-into' : ''}`} style={{ cursor: 'default' }}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDrop({ id: `${b.id}:${i}`, zone: 'into' }); }}
                    onDragLeave={() => setDrop(null)}
                    onDrop={(e) => handleDrop(e, { parentId: b.id, slot: i, index: c.children.length })}>
                    <span className="label muted">Column {i + 1}{c.children.length === 0 ? ' (drop blocks here)' : ''}</span>
                  </div>
                  {renderList(c.children)}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className="outline"
      role="tree"
      aria-label="Page structure"
      style={{ minHeight: 80 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => handleDrop(e, { parentId: null, slot: 0, index: blocks.length })}
    >
      {blocks.length === 0 ? <p className="muted small" style={{ padding: 8 }}>This page is empty. Click or drag a block from the palette.</p> : renderList(blocks)}
    </div>
  );
}

