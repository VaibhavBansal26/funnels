// Adapted from the legacy builder (see docs/PROVENANCE.md): the legacy top bar (back, active page dropdown, desktop / mobile switch, undo, redo, popup, X-ray (outline) toggle,
// preview, save), reorganised with the step switcher, a tablet size, history, page settings and publish.
import { ArrowLeft, Eye, History, Keyboard, Monitor, MoreHorizontal, Pencil, Redo2, Rocket, Save, Settings2, Smartphone, CreditCard, Tablet, Undo2, ExternalLink, LayoutPanelLeft, SlidersHorizontal, LoaderCircle, CircleAlert, Check } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Button, buttonVariants, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Select, Tooltip } from '../../ui';
import { DEVICES, type DeviceId } from '../editor/createEditor';
import { useBuilder, useEditorEvents } from '../useEditor';

export type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'autosaved' | 'error'; at?: Date; message?: string };

const DEVICE_ICON = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;

export function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  let icon = <Check className="size-3.5" />;
  let text = 'All changes saved';
  let tone = 'text-muted';
  if (state.kind === 'saving') (icon = <LoaderCircle className="size-3.5 animate-spin" />, (text = 'Saving…'));
  else if (state.kind === 'error') (icon = <CircleAlert className="size-3.5" />, (text = state.message ?? 'Save failed'), (tone = 'text-danger'));
  else if (dirty) (icon = <span className="size-2 rounded-full bg-warn" />, (text = 'Unsaved changes'), (tone = 'text-warn'));
  else if (state.at) text = `${state.kind === 'autosaved' ? 'Autosaved' : 'Saved'} ${state.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return <span role="status" aria-live="polite" className={cn('hidden items-center gap-1.5 text-[0.8rem] font-medium md:inline-flex', tone)}>{icon}<span className="max-w-48 truncate">{text}</span></span>;
}

export function TopBar({ funnelName, stepId, steps, onStep, device, onDevice, previewing, onPreviewToggle, state, dirty, onSave, onPublish, onHistory, onSettings, onShortcuts, onOpenPreview, onPayments, toggles, onTogglePanels }: {
  funnelName: string; stepId: string; steps: { id: string; name: string; position: number }[]; onStep: (id: string) => void;
  device: DeviceId; onDevice: (d: DeviceId) => void; previewing: boolean; onPreviewToggle: () => void;
  state: SaveState; dirty: boolean; onSave: () => void; onPublish: () => void; onHistory: () => void; onSettings: () => void; onShortcuts: () => void; onOpenPreview: () => void; onPayments?: () => void;
  toggles: { left: boolean; right: boolean }; onTogglePanels: (which: 'left' | 'right') => void;
}) {
  const { editor, env } = useBuilder();
  useEditorEvents(editor, 'undo redo update component:add component:remove');
  const um = editor.UndoManager;
  return (
    <header role="toolbar" aria-label="Builder" className="flex h-12 shrink-0 items-center gap-1 border-b border-border/70 bg-surface px-2.5 sm:gap-1.5 sm:px-3">
      <Tooltip label="Back to the funnel"><Link to={`/funnels/${env.funnelId}/steps`} aria-label={`Back to ${funnelName}`} className={buttonVariants({ variant: 'ghost', size: 'icon' })}><ArrowLeft /></Link></Tooltip>
      {toggles.left ? <Tooltip label="Blocks, layers and pages"><Button variant="ghost" size="icon" aria-label="Open blocks, layers and pages" onClick={() => onTogglePanels('left')}><LayoutPanelLeft /></Button></Tooltip> : null}
      <div className="hidden min-w-0 max-w-44 flex-col leading-tight xl:flex">
        <span className="truncate text-[0.72rem] font-medium text-muted">{funnelName}</span>
      </div>
      <div className="w-[5.5rem] sm:w-44">
        <Select size="sm" aria-label="Step" value={stepId} onValueChange={onStep} options={steps.map((s) => ({ value: s.id, label: `${s.position}. ${s.name}` }))} />
      </div>
      <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
      <div className="hidden items-center sm:flex">
        <Tooltip label="Undo" shortcut="⌘Z"><Button variant="ghost" size="icon" aria-label="Undo" disabled={!um.hasUndo()} onClick={() => editor.runCommand('core:undo')}><Undo2 /></Button></Tooltip>
        <Tooltip label="Redo" shortcut="⇧⌘Z"><Button variant="ghost" size="icon" aria-label="Redo" disabled={!um.hasRedo()} onClick={() => editor.runCommand('core:redo')}><Redo2 /></Button></Tooltip>
      </div>
      <div role="group" aria-label="Device size" className="mx-auto hidden items-center rounded-lg bg-surface-2 p-0.5 sm:flex">
        {DEVICES.map((d) => {
          const Icon = DEVICE_ICON[d.id];
          return (
            <Tooltip key={d.id} label={`${d.name}${d.width ? ` (${d.width})` : ''}`}>
              <button type="button" aria-label={d.name} aria-pressed={device === d.id} onClick={() => onDevice(d.id)} className={cn('grid h-7 w-9 place-items-center rounded-md text-muted [&_svg]:size-4', device === d.id ? 'bg-surface text-primary shadow-sm' : 'hover:text-fg')}><Icon /></button>
            </Tooltip>
          );
        })}
      </div>
      <span className="flex-1 sm:hidden" />
      <Tooltip label={previewing ? 'Back to editing' : 'Preview without editing tools'} shortcut="⇧⌘P">
        <Button variant={previewing ? 'soft' : 'ghost'} size="sm" className="hidden sm:inline-flex" aria-pressed={previewing} onClick={onPreviewToggle}>{previewing ? <Pencil /> : <Eye />}<span className="hidden xl:inline">{previewing ? 'Edit' : 'Preview'}</span></Button>
      </Tooltip>
      <SaveStatus state={state} dirty={dirty} />
      <Button size="sm" aria-label="Save" disabled={state.kind === 'saving' || (!dirty && state.kind !== 'error')} onClick={onSave}><Save /><span className="hidden xl:inline">Save</span></Button>
      <Button size="sm" variant="primary" aria-label="Publish" onClick={onPublish}><Rocket /><span className="hidden sm:inline">Publish</span></Button>
      <DropdownMenu>
        <Tooltip label="More"><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger></Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className="sm:hidden" disabled={!um.hasUndo()} onSelect={() => editor.runCommand('core:undo')}><Undo2 /> Undo</DropdownMenuItem>
          <DropdownMenuItem className="sm:hidden" disabled={!um.hasRedo()} onSelect={() => editor.runCommand('core:redo')}><Redo2 /> Redo</DropdownMenuItem>
          <DropdownMenuItem className="sm:hidden" onSelect={onPreviewToggle}>{previewing ? <Pencil /> : <Eye />} {previewing ? 'Back to editing' : 'Preview'}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenPreview}><ExternalLink /> View saved page</DropdownMenuItem>
          <DropdownMenuItem onSelect={onHistory}><History /> Version history</DropdownMenuItem>
          <DropdownMenuItem onSelect={onSettings}><Settings2 /> Page settings</DropdownMenuItem>
          {onPayments ? <DropdownMenuItem onSelect={onPayments}><CreditCard /> Add payments</DropdownMenuItem> : null}
          <DropdownMenuItem className="hidden lg:flex" onSelect={onShortcuts}><Keyboard /> Keyboard shortcuts <kbd className="ml-auto font-mono text-xs text-muted">?</kbd></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {toggles.right ? <Tooltip label="Style and settings"><Button variant="ghost" size="icon" aria-label="Open style and settings" onClick={() => onTogglePanels('right')}><SlidersHorizontal /></Button></Tooltip> : null}
      <Badge className="hidden" tone="neutral">{steps.length}</Badge>
    </header>
  );
}
