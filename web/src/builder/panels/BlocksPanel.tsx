import type { Block, Component, Editor } from 'grapesjs';
import { GripVertical, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { keys, useCustomBlocks, useMutate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { Button, cn, Input, Tooltip } from '../../ui';
import { blockIcon } from '../blockIcons';
import { BLOCK_CATEGORIES } from '../editor/blocks';
import { canDrop } from '../editor/rules';
import { useBuilder } from '../useEditor';
import { useEditorEvents } from '../useEditor';
import { Section } from './kit';

const MY = 'My blocks';

/**
 * Where a clicked (not dragged) block goes: into the nearest container around the selection that accepts it (after the branch the selection is in),
 * else at the end of the page. Same drop rules as dragging, so the keyboard path and the mouse path cannot disagree.
 */
export function insertBlock(editor: Editor, block: Block): Component | undefined {
  const content = block.getContent() as { type?: string; tagName?: string };
  const src = { type: String(content.type ?? 'default'), tag: String(content.tagName ?? '') };
  const wrapper = editor.getWrapper()!;
  let parent: Component = wrapper;
  let at: number | undefined;
  let cur: Component | undefined = editor.getSelected();
  let branch: Component | undefined;
  while (cur && cur !== wrapper) {
    if (canDrop(src, String(cur.get('type') ?? 'default'))) {
      parent = cur;
      at = branch ? cur.components().indexOf(branch) + 1 : undefined;
      break;
    }
    branch = cur;
    cur = cur.parent();
  }
  const added = parent.components().add(content as never, at === undefined ? {} : { at }) as Component | Component[];
  const first = Array.isArray(added) ? added[0] : added;
  if (first) {
    editor.select(first);
    first.getEl()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return first;
}

function Tile({ block, mine, onDelete }: { block: Block; mine?: boolean; onDelete?: () => void }) {
  const { editor } = useBuilder();
  const Icon = blockIcon(String(block.get('attributes')?.['data-icon'] ?? ''));
  return (
    <div className="group relative">
      <button
        type="button"
        draggable
        data-block={block.getId()}
        aria-label={`Add ${block.getLabel()}. Drag onto the page, or press Enter to insert`}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', block.getId());
          editor.Blocks.__startDrag(block, e.nativeEvent);
        }}
        onDragEnd={() => editor.Blocks.__endDrag()}
        onClick={() => insertBlock(editor, block)}
        className="flex w-full cursor-grab flex-col items-center gap-1.5 rounded-xl border border-transparent bg-surface-2 px-1.5 py-3.5 text-center text-[0.78rem] font-medium text-fg transition-colors hover:border-border-strong hover:bg-surface-3/60 active:cursor-grabbing [&_svg]:size-5 [&_svg]:text-muted"
      >
        <GripVertical className="absolute top-1.5 left-1 !size-3 !text-muted opacity-0 group-hover:opacity-100" aria-hidden="true" />
        <Icon aria-hidden="true" />
        <span className="line-clamp-2 leading-tight">{block.getLabel()}</span>
      </button>
      {mine ? (
        <Tooltip label="Delete saved block" side="top">
          <button type="button" aria-label={`Delete saved block ${block.getLabel()}`} onClick={onDelete} className="absolute top-1 right-1 hidden size-6 place-items-center rounded-md bg-surface text-muted shadow hover:text-danger group-focus-within:grid group-hover:grid"><Trash2 className="size-3.5" /></button>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function BlocksPanel() {
  const { editor, env, ui } = useBuilder();
  const { can } = useAuth();
  const [query, setQuery] = useState('');
  const saved = useCustomBlocks();
  const del = useMutate((id: string) => api.delete(`/api/blocks/${id}`), [keys.blocks]);
  useEditorEvents(editor, 'block:add block:remove component:selected component:deselected'); // (selection too: "Save selection as block" depends on it)

  // "My blocks" (saved per workspace) live in the block manager next to the built-in library.
  useEffect(() => {
    const ids: string[] = [];
    for (const b of saved.data?.data ?? []) {
      const id = `my-${b.id}`;
      ids.push(id);
      if (!editor.Blocks.get(id)) editor.Blocks.add(id, { label: b.name, category: MY, content: b.block as never, attributes: { 'data-icon': 'Blocks', 'data-keywords': 'saved custom reusable' }, select: true } as never);
    }
    for (const b of editor.Blocks.getAll().models) if (b.getCategoryLabel() === MY && !ids.includes(b.getId())) editor.Blocks.remove(b.getId());
  }, [editor, saved.data]);

  const q = query.trim().toLowerCase();
  // Not memoised: the block list changes through editor events (saved blocks are added in an effect), and filtering ~50 blocks is cheap.
  const groups = (() => {
    const all = editor.Blocks.getAll().models.filter((b) => !q || `${b.getLabel()} ${b.get('attributes')?.['data-keywords'] ?? ''} ${b.getCategoryLabel()}`.toLowerCase().includes(q));
    const order: string[] = [...BLOCK_CATEGORIES, MY];
    return order.map((c) => ({ c, blocks: all.filter((b) => b.getCategoryLabel() === c) })).filter((g) => g.blocks.length);
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Blocks">
      <div className="border-b border-border/70 p-4">
        <div className="relative">
          <label htmlFor="block-search" className="sr-only">Search blocks</label>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="block-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search blocks" className="min-h-9 pl-8 text-[0.8125rem]" />
        </div>
        <p className="mt-2.5 mb-0 text-xs text-muted">Drag onto the page, or click to insert.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? <p className="p-6 text-center text-sm text-muted">No block matches “{query}”.</p> : null}
        {groups.map((g) => (
          <Section key={`${g.c}${q ? ':search' : ''}`} title={g.c} defaultOpen={!!q || g.c === 'Sections'} badge={<span className="rounded-full bg-surface-2 px-1.5 text-[0.7rem] font-semibold text-muted">{g.blocks.length}</span>}>
            <div className={cn('grid grid-cols-2 gap-2.5')}>
              {g.blocks.map((b) => <Tile key={b.getId()} block={b} mine={g.c === MY} onDelete={() => del.mutate(b.getId().replace(/^my-/, ''))} />)}
            </div>
          </Section>
        ))}
        {can('blocks:manage') ? (
          <div className="p-3">
            <Button size="sm" className="w-full" onClick={ui.saveBlock} disabled={!editor.getSelected()} title="Select an element on the page first">Save selection as block</Button>
          </div>
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">{env.canScripts ? '' : ''}</span>
    </div>
  );
}
