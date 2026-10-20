import type { Component } from 'grapesjs';
import { Copy, CopyPlus, EyeOff, Maximize, MousePointerClick, Plus, Trash2, ArrowUp, ArrowDown, ArrowUpFromLine, ZoomIn, ZoomOut, ClipboardPaste, Save } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, cn, Tooltip } from '../../ui';
import { DEVICES } from '../editor/createEditor';
import { SELECTION_EVENTS, TREE_EVENTS, useBuilder, useEditorEvents } from '../useEditor';

const ZOOMS = [50, 67, 75, 90, 100, 110, 125, 150];

export function ZoomBar({ areaRef }: { areaRef: RefObject<HTMLDivElement | null> }) {
  const { editor } = useBuilder();
  const [zoom, setZoom] = useState(100);
  const apply = (n: number) => {
    const z = Math.max(50, Math.min(150, Math.round(n)));
    editor.Canvas.setZoom(z);
    setZoom(z);
  };
  const fit = () => {
    const area = areaRef.current;
    const dev = DEVICES.find((d) => d.id === editor.getDevice());
    const width = dev?.width ? parseInt(dev.width, 10) : 1280;
    if (area) apply(((area.clientWidth - 48) / width) * 100);
  };
  useEffect(() => {
    const on = () => setZoom(Math.round(editor.Canvas.getZoom?.() ?? 100));
    editor.on('canvas:zoom', on);
    return () => void editor.off('canvas:zoom', on);
  }, [editor]);
  const step = (dir: 1 | -1) => apply(dir === 1 ? (ZOOMS.find((z) => z > zoom) ?? 150) : ([...ZOOMS].reverse().find((z) => z < zoom) ?? 50));
  return (
    <div role="group" aria-label="Zoom" className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-surface/95 p-1 shadow-pop backdrop-blur">
      <Tooltip label="Zoom out" side="top"><Button size="icon-sm" variant="ghost" aria-label="Zoom out" disabled={zoom <= 50} onClick={() => step(-1)}><ZoomOut /></Button></Tooltip>
      <button type="button" aria-label="Reset zoom to 100 percent" onClick={() => apply(100)} className="min-w-12 rounded-md px-1 text-center text-[0.78rem] font-semibold tabular-nums hover:bg-surface-2">{zoom}%</button>
      <Tooltip label="Zoom in" side="top"><Button size="icon-sm" variant="ghost" aria-label="Zoom in" disabled={zoom >= 150} onClick={() => step(1)}><ZoomIn /></Button></Tooltip>
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
      <Tooltip label="Fit the page to the available width" side="top"><Button size="icon-sm" variant="ghost" aria-label="Fit to width" onClick={fit}><Maximize /></Button></Tooltip>
    </div>
  );
}

/** Shown over an empty page: a hint, not an obstacle (pointer events pass through to the canvas so blocks can still be dropped). */
export function EmptyHint() {
  const { editor } = useBuilder();
  useEditorEvents(editor, TREE_EVENTS);
  const empty = (editor.getWrapper()?.components().length ?? 0) === 0;
  if (!empty) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
      <div className="flex max-w-xs flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 bg-surface/90 px-8 py-10 text-center shadow-card">
        <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-primary"><MousePointerClick className="size-5" /></span>
        <h2 className="text-base font-semibold">Start building</h2>
        <p className="text-sm text-muted">Drag a block from the left onto this page, or click one to insert it. Try “Hero” to begin.</p>
        <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary"><Plus className="size-3.5" /> Blocks → Sections → Hero</span>
      </div>
    </div>
  );
}

interface Menu { x: number; y: number; target: Component }

/** Right-click menu for the element under the pointer. Reachable by keyboard through the shortcuts listed in the help dialog. */
export function ContextMenu() {
  const { editor, ui } = useBuilder();
  const [menu, setMenu] = useState<Menu | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEditorEvents(editor, SELECTION_EVENTS);
  useEffect(() => {
    const attach = (doc?: Document | null) => {
      if (!doc) return () => undefined;
      const onCtx = (ev: MouseEvent) => {
        const model = (ev.target as unknown as { __cashData?: { model?: Component } })?.__cashData?.model ?? editor.getSelected();
        if (!model || model === editor.getWrapper()) return;
        ev.preventDefault();
        editor.select(model);
        const frame = editor.Canvas.getFrameEl().getBoundingClientRect();
        const zoom = (editor.Canvas.getZoom?.() ?? 100) / 100;
        setMenu({ x: frame.left + ev.clientX * zoom, y: frame.top + ev.clientY * zoom, target: model });
      };
      doc.addEventListener('contextmenu', onCtx);
      return () => doc.removeEventListener('contextmenu', onCtx);
    };
    let off = attach(editor.Canvas.getDocument());
    const reattach = () => { off(); off = attach(editor.Canvas.getDocument()); };
    editor.on('canvas:frame:load:body', reattach);
    return () => { off(); editor.off('canvas:frame:load:body', reattach); };
  }, [editor]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    editor.on('canvas:frame:load:body', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); window.removeEventListener('keydown', key); };
  }, [menu, editor]);
  useEffect(() => { menu && ref.current?.querySelector<HTMLElement>('button')?.focus(); }, [menu]);
  if (!menu) return null;
  const t = menu.target;
  const run = (fn: () => void) => () => { setMenu(null); fn(); };
  const item = (label: string, icon: React.ReactNode, fn: () => void, opts: { disabled?: boolean; danger?: boolean; kbd?: string } = {}) => (
    <button key={label} type="button" role="menuitem" disabled={opts.disabled} onMouseDown={(e) => e.stopPropagation()} onClick={run(fn)} className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.82rem] hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-40 [&_svg]:size-3.5', opts.danger && 'text-danger')}>
      {icon}<span className="flex-1">{label}</span>{opts.kbd ? <kbd className="font-mono text-[0.68rem] text-muted">{opts.kbd}</kbd> : null}
    </button>
  );
  const sep = (k: string) => <div key={k} role="separator" className="my-1 h-px bg-border" />;
  return (
    <div ref={ref} role="menu" aria-label={`${t.getName()} actions`} style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 340) }} className="fixed z-[180] w-56 rounded-lg border border-border bg-surface p-1 shadow-pop" onKeyDown={(e) => {
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus());
      else if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus());
    }}>
      <div className="px-2.5 pt-1 pb-1.5 text-[0.72rem] font-semibold tracking-wide text-muted uppercase">{t.getName()}</div>
      {item('Select parent', <ArrowUp />, () => editor.runCommand('fn:select-parent'), { disabled: !t.parent() || t.parent() === editor.getWrapper(), kbd: '⇧↑' })}
      {item('Duplicate', <CopyPlus />, () => editor.runCommand('tlb-clone'), { disabled: t.get('copyable') === false, kbd: '⌘D' })}
      {item('Copy', <Copy />, () => editor.runCommand('core:copy'), { kbd: '⌘C' })}
      {item('Paste', <ClipboardPaste />, () => editor.runCommand('core:paste'), { kbd: '⌘V' })}
      {sep('a')}
      {item('Move up', <ArrowUp />, () => editor.runCommand('fn:move-up'), { kbd: '⌥↑' })}
      {item('Move down', <ArrowDown />, () => editor.runCommand('fn:move-down'), { kbd: '⌥↓' })}
      {item('Move out of parent', <ArrowUpFromLine />, () => editor.runCommand('fn:move-out'), { kbd: '⌥←' })}
      {sep('b')}
      {item('Hide on phones', <EyeOff />, () => { t.removeClass('show-none'); t.removeClass('show-mobile-only'); t.addClass('show-desktop-only'); })}
      {item('Save as block…', <Save />, () => ui.saveBlock())}
      {sep('c')}
      {item('Delete', <Trash2 />, () => editor.runCommand('core:component-delete'), { danger: true, disabled: t.get('removable') === false, kbd: '⌫' })}
    </div>
  );
}

export function CanvasArea({ areaRef, previewing }: { areaRef: RefObject<HTMLDivElement | null>; previewing: boolean }) {
  return (
    <>
      {previewing ? null : <EmptyHint />}
      <ZoomBar areaRef={areaRef} />
      {previewing ? null : <ContextMenu />}
    </>
  );
}
