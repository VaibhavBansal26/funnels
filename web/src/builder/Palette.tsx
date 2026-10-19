import { BLOCK_TYPES, type BlockType } from '@blocks';
import type { CustomBlock } from '../api/types';
import { BLOCK_LABELS } from './Inspector';
import { DRAG_ADD } from './Outline';

export function Palette({ onAdd, custom, onInsertCustom, onDeleteCustom }: { onAdd: (t: BlockType) => void; custom: CustomBlock[]; onInsertCustom: (b: CustomBlock) => void; onDeleteCustom: (b: CustomBlock) => void }) {
  return (
    <div>
      <h3>Add a block</h3>
      <div className="palette" role="group" aria-label="Block palette">
        {BLOCK_TYPES.map((t) => (
          <button key={t} type="button" draggable onClick={() => onAdd(t)} onDragStart={(e) => { e.dataTransfer.setData(DRAG_ADD, t); e.dataTransfer.effectAllowed = 'copy'; }} aria-label={`Add ${BLOCK_LABELS[t]}`}>
            {BLOCK_LABELS[t]}
          </button>
        ))}
      </div>
      {custom.length ? (
        <>
          <h3>My blocks</h3>
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: '8px 12px 12px' }}>
            {custom.map((c) => (
              <li key={c.id} className="row" style={{ flexWrap: 'nowrap' }}>
                <button type="button" className="btn sm grow" onClick={() => onInsertCustom(c)}>{c.name}</button>
                <button type="button" className="btn sm icon danger" aria-label={`Delete saved block ${c.name}`} onClick={() => onDeleteCustom(c)}>×</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
