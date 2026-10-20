// Adapted from the legacy builder (see docs/PROVENANCE.md): its Layer manager panel (visibility toggle, nested list, drag to reorder), rebuilt on the
// GrapesJS Layers API with lock toggles, keyboard navigation and the same drop rules as the canvas.
import type { Component } from 'grapesjs';
import { Box, ChevronRight, Eye, EyeOff, Layers as LayersIcon, Lock, LockOpen } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn, Tooltip } from '../../ui';
import { blockIcon } from '../blockIcons';
import { canDrop } from '../editor/rules';
import { SELECTION_EVENTS, TREE_EVENTS, useBuilder, useEditorEvents } from '../useEditor';
import { PanelEmpty } from './kit';

const ICON: Record<string, string> = {
  'fn-section': 'PanelTop', 'fn-row': 'Columns2', 'fn-column': 'RectangleHorizontal', 'fn-heading': 'Heading1', 'fn-text': 'Pilcrow', 'fn-button': 'MousePointerClick', 'fn-list': 'List',
  'fn-divider': 'Minus', 'fn-spacer': 'MoveVertical', image: 'Image', 'fn-video': 'Video', 'fn-faq': 'CircleHelp', 'fn-tabs': 'PanelsTopLeft', 'fn-countdown': 'Timer', 'fn-progress': 'GaugeCircle',
  'fn-form': 'Mail', 'fn-checkout': 'ShoppingCart', 'fn-code': 'Code', 'fn-popup': 'AppWindow', link: 'Link',
};
const typeOf = (c: Component): string => String(c.get('type') ?? 'default');

type Zone = 'before' | 'inside' | 'after';
interface Drop { id: string; zone: Zone; ok: boolean }

export function LayersPanel() {
  const { editor } = useBuilder();
  useEditorEvents(editor, `${TREE_EVENTS} ${SELECTION_EVENTS}`);
  const root = editor.Layers.getRoot();
  const [drop, setDrop] = useState<Drop | null>(null);
  const dragging = useRef<Component | null>(null);

  const children = (c: Component): Component[] => editor.Layers.getComponents(c);
  const rows: { c: Component; depth: number }[] = [];
  const walk = (c: Component, depth: number) => {
    for (const k of children(c)) {
      rows.push({ c: k, depth });
      if (editor.Layers.isOpen(k) && children(k).length) walk(k, depth + 1);
    }
  };
  walk(root, 0);
  const selected = editor.getSelectedAll();

  const legal = (moved: Component, target: Component, zone: Zone): boolean => {
    if (moved === target) return false;
    for (let p: Component | undefined = target; p; p = p.parent()) if (p === moved) return false; // not into itself
    const host = zone === 'inside' ? target : target.parent();
    if (!host) return false;
    return canDrop({ type: typeOf(moved), tag: String(moved.get('tagName') ?? '') }, typeOf(host)) && moved.get('draggable') !== false;
  };
  const zoneOf = (e: React.DragEvent<HTMLElement>, target: Component): Zone => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const containers = children(target).length > 0 || target.get('droppable');
    if (containers && y > 0.28 && y < 0.72) return 'inside';
    return y < 0.5 ? 'before' : 'after';
  };
  const commit = (moved: Component, target: Component, zone: Zone) => {
    const host = zone === 'inside' ? target : target.parent()!;
    const at = zone === 'inside' ? host.components().length : host.components().indexOf(target) + (zone === 'after' ? 1 : 0);
    // `at` is an index in the CURRENT list (like insertBefore); GrapesJS itself allows for the element leaving its old place when it stays in the same parent.
    moved.move(host, { at });
    editor.select(moved);
    if (zone === 'inside') editor.Layers.setOpen(host, true);
  };

  if (rows.length === 0) return <PanelEmpty icon={<LayersIcon />} title="The page is empty">Add a block from the Blocks tab. Its structure appears here, and you can drag layers to reorder them.</PanelEmpty>;

  const move = (to: Component | undefined) => to && editor.select(to);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const row = rows[i]!;
    if (e.key === 'ArrowDown') (e.preventDefault(), move(rows[i + 1]?.c));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(rows[i - 1]?.c));
    else if (e.key === 'ArrowRight' && children(row.c).length) (e.preventDefault(), editor.Layers.setOpen(row.c, true));
    else if (e.key === 'ArrowLeft') (e.preventDefault(), editor.Layers.isOpen(row.c) && children(row.c).length ? editor.Layers.setOpen(row.c, false) : move(row.c.parent() && row.c.parent() !== root ? row.c.parent() : undefined));
    else if ((e.key === 'Delete' || e.key === 'Backspace') && row.c.get('removable') !== false) (e.preventDefault(), row.c.remove());
    else if (e.altKey && e.key === 'ArrowUp') (e.preventDefault(), editor.runCommand('fn:move-up'));
    else if (e.altKey && e.key === 'ArrowDown') (e.preventDefault(), editor.runCommand('fn:move-down'));
  };

  return (
    <div role="tree" aria-label="Page layers" className="min-h-0 flex-1 overflow-y-auto py-1.5" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}>
      {rows.map(({ c, depth }, i) => {
        const id = c.getId();
        const kids = children(c).length > 0;
        const open = editor.Layers.isOpen(c);
        const visible = editor.Layers.isVisible(c);
        const locked = editor.Layers.isLocked(c);
        const isSel = selected.includes(c);
        const Icon = ICON[typeOf(c)] ? blockIcon(ICON[typeOf(c)]!) : Box;
        const d = drop?.id === id ? drop : null;
        return (
          <div
            key={c.cid}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={isSel}
            aria-expanded={kids ? open : undefined}
            tabIndex={isSel || (!selected.length && i === 0) ? 0 : -1}
            data-layer={id}
            draggable={c.get('draggable') !== false && !locked}
            onDragStart={(e) => { dragging.current = c; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
            onDragEnd={() => { dragging.current = null; setDrop(null); }}
            onDragOver={(e) => {
              const moved = dragging.current;
              if (!moved) return;
              const zone = zoneOf(e, c);
              const ok = legal(moved, c, zone);
              if (ok) e.preventDefault();
              setDrop({ id, zone, ok });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const moved = dragging.current;
              if (moved && d?.ok) commit(moved, c, d.zone);
              dragging.current = null;
              setDrop(null);
            }}
            onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey ? editor.selectToggle(c) : editor.select(c))}
            onKeyDown={(e) => onKey(e, i)}
            className={cn('group relative mx-1.5 flex min-h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[0.82rem] outline-none', isSel ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2', !visible && 'opacity-50', 'focus-visible:ring-2 focus-visible:ring-ring',
              d?.ok && d.zone === 'before' && 'before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded before:bg-primary',
              d?.ok && d.zone === 'after' && 'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded after:bg-primary',
              d?.ok && d.zone === 'inside' && 'ring-2 ring-primary', d && !d.ok && 'cursor-not-allowed ring-1 ring-danger/50')}
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <button type="button" tabIndex={-1} aria-label={open ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); if (kids) editor.Layers.setOpen(c, !open); }} className={cn('grid size-5 place-items-center rounded text-muted hover:bg-surface-3', !kids && 'invisible')}>
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </button>
            <Icon className="size-3.5 shrink-0 text-muted group-aria-selected:text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" onDoubleClick={() => { const n = window.prompt('Layer name', editor.Layers.getName(c)); if (n) editor.Layers.setName(c, n); }}>{editor.Layers.getName(c)}</span>
            <Tooltip label={locked ? 'Unlock' : 'Lock (cannot be selected or moved)'} side="left"><button type="button" tabIndex={-1} aria-label={locked ? 'Unlock layer' : 'Lock layer'} aria-pressed={locked} onClick={(e) => { e.stopPropagation(); editor.Layers.setLocked(c, !locked); }} className={cn('grid size-6 place-items-center rounded text-muted hover:bg-surface-3', !locked && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>{locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}</button></Tooltip>
            <Tooltip label={visible ? 'Hide in editor' : 'Show'} side="left"><button type="button" tabIndex={-1} aria-label={visible ? 'Hide layer in the editor' : 'Show layer'} aria-pressed={!visible} onClick={(e) => { e.stopPropagation(); editor.Layers.setVisible(c, !visible); }} className={cn('grid size-6 place-items-center rounded text-muted hover:bg-surface-3', visible && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>{visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}</button></Tooltip>
          </div>
        );
      })}
    </div>
  );
}
