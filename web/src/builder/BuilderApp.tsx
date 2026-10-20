import { useQueryClient } from '@tanstack/react-query';
import type { Component } from 'grapesjs';
import { Monitor, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { keys } from '../api/hooks';
import type { FunnelDetail, PageData, Step } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ui';
import { Button, cn, Dialog, TooltipProvider, useToast } from '../ui';
import './builder.css';
import { AiRewriteDialog, AssetPickerDialog, HistoryDialog, LinkDialog, PageSettingsDialog, SaveBlockDialog, ShortcutsDialog } from './dialogs';
import { createEditor, DEVICES, type DeviceId, type FnEditor } from './editor/createEditor';
import { checkProject, loadDoc, readProject } from './editor/load';
import { CanvasArea } from './panels/CanvasArea';
import { Inspector } from './panels/Inspector';
import { LeftRail, type LeftTab } from './panels/LeftRail';
import { TopBar, type SaveState } from './panels/TopBar';
import { useLayout } from './useBreakpoint';
import { BuilderProvider, type BuilderUi } from './useEditor';

const AUTOSAVE_MS = 20_000;

/**
 * The page builder: one GrapesJS editor per step. GrapesJS owns the canvas, drag and drop, selection, undo and styles; every panel around it
 * is React (blocks, layers, pages, images, inspector, dialogs). Saving sends the editable project data only; the server validates, cleans and
 * renders the published page from it.
 */
export function BuilderApp({ funnel, step, page, reload }: { funnel: FunnelDetail; step: Step; page: PageData; reload: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { session, can } = useAuth();
  const layout = useLayout();
  const host = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<FnEditor | null>(null);
  const [device, setDevice] = useState<DeviceId>('desktop');
  const [previewing, setPreviewing] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [leftTab, setLeftTab] = useState<LeftTab>('blocks');
  const [drawer, setDrawer] = useState<null | 'left' | 'right'>(null);
  const [dialog, setDialog] = useState<null | 'shortcuts' | 'settings' | 'history' | 'publish' | 'saveBlock'>(null);
  const [picker, setPicker] = useState<null | { pick: (url: string) => void }>(null);
  const [aiTarget, setAiTarget] = useState<Component | null>(null);
  const [link, setLink] = useState<null | { rte: never; range: Range | null; href: string }>(null);
  const [mobileNotice, setMobileNotice] = useState(true);
  const version = useRef(page.version);
  const savedSig = useRef('0:-1');
  const saving = useRef(false);
  const canScripts = !!session?.workspace.allowCustomScripts && can('workspace:manage');

  const sig = useCallback((ed: FnEditor) => `${ed.UndoManager.getStack().length}:${ed.UndoManager.getPointer()}`, []);

  // ---- editor lifecycle ----
  useEffect(() => {
    const ed = createEditor(host.current!, { funnelId: funnel.id, stepId: step.id, steps: funnel.steps.map((s) => ({ id: s.id, name: s.name })), canScripts });
    const onLoad = () => {
      const r = loadDoc(ed, page.doc);
      if (!r.ok) {
        setIssues(r.issues);
        toast.push('This page contained content that could not be opened; it was replaced by an empty page. Nothing is lost until you save.', 'error');
      } else setNotes(r.notes);
      savedSig.current = sig(ed);
      (window as unknown as { __editor?: FnEditor }).__editor = ed;
      setEditor(ed);
    };
    ed.on('load', onLoad);
    return () => {
      ed.fnDispose?.();
      ed.destroy();
      setEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- dirty tracking ----
  useEffect(() => {
    if (!editor) return;
    // Dirty means "the undo history moved since the last save": selecting, hovering and scrolling never count, every real edit (components, styles, props) does.
    const on = () => setDirty(sig(editor) !== savedSig.current);
    const stack = editor.UndoManager.getStack() as unknown as { on(e: string, cb: () => void): void; off(e: string, cb: () => void): void };
    stack.on('add remove reset', on);
    editor.on('update undo redo', on);
    return () => { stack.off('add remove reset', on); editor.off('update undo redo', on); };
  }, [editor, sig]);

  // ---- saving ----
  const doSave = useCallback(
    async (backup: boolean) => {
      if (!editor || saving.current) return;
      const check = checkProject(editor);
      if (!check.ok) {
        setIssues(check.issues.map((i) => `${i.path}: ${i.message}`));
        setSave({ kind: 'error', message: 'Fix the highlighted problems before saving' });
        return;
      }
      setIssues([]);
      saving.current = true;
      setSave({ kind: 'saving' });
      const mark = sig(editor);
      try {
        const r = await api.put<{ version: number }>(`/api/funnels/${funnel.id}/steps/${step.id}/page`, { doc: { version: 2, project: readProject(editor) }, version: version.current, backup });
        version.current = r.version;
        savedSig.current = mark;
        setDirty(sig(editor) !== mark);
        void qc.invalidateQueries({ queryKey: keys.funnels });
        void qc.invalidateQueries({ queryKey: ['page-html', step.id] });
        setSave({ kind: backup ? 'saved' : 'autosaved', at: new Date() });
      } catch (e) {
        const conflict = e instanceof ApiError && e.code === 'VERSION_CONFLICT';
        const invalid = e instanceof ApiError && e.code === 'INVALID_DOCUMENT';
        if (invalid) setIssues(((e as ApiError).details as { path: string; message: string }[] | undefined)?.map((i) => `${i.path}: ${i.message}`) ?? []);
        setSave({ kind: 'error', message: conflict ? 'This page was changed in another tab or by a teammate. Reload to get the latest version.' : errorMessage(e) });
      } finally {
        saving.current = false;
      }
    },
    [editor, funnel.id, step.id, qc, sig],
  );
  const saveRef = useRef(doSave);
  saveRef.current = doSave;

  useEffect(() => {
    if (!dirty || save.kind === 'error' || save.kind === 'saving') return;
    const t = setTimeout(() => void saveRef.current(false), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, save.kind, editor && sig(editor)]);

  // Ctrl/Cmd+S saves wherever the focus is (inputs in the panels included); inside the canvas the GrapesJS keymap does the same.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const blocker = useBlocker(dirty);

  // ---- events from GrapesJS into React ----
  useEffect(() => {
    if (!editor) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...a: any[]) => void> = {
      'fn:save': () => void saveRef.current(true),
      'fn:help': () => setDialog('shortcuts'),
      'fn:ai-rewrite': (c: Component) => c && setAiTarget(c),
      'fn:rte-link': (s: { rte: never; range: Range | null; href: string }) => setLink(s),
      'run:core:preview': () => setPreviewing(true),
      'stop:core:preview': () => setPreviewing(false),
      'change:device': () => setDevice((DEVICES.find((d) => d.id === editor.getDevice())?.id ?? 'desktop') as DeviceId),
      'fn:tab-activate': (btn: Component) => {
        const nav = btn.parent();
        const tabs = nav?.parent();
        if (!nav || !tabs) return;
        const i = nav.components().indexOf(btn);
        const panels = tabs.components().models.filter((c) => c.get('type') === 'fn-tab-panel');
        nav.components().forEach((b: Component) => (b === btn ? b.addClass('fn-active') : b.removeClass('fn-active')));
        panels.forEach((p, k) => (k === i ? p.removeAttributes('hidden') : p.addAttributes({ hidden: '' })));
      },
    };
    for (const [k, h] of Object.entries(handlers)) editor.on(k, h);
    return () => { for (const [k, h] of Object.entries(handlers)) editor.off(k, h); };
  }, [editor]);

  // ---- actions exposed to the panels ----
  const ui: BuilderUi = useMemo(
    () => ({
      openAssets: (pick) => setPicker({ pick: pick ?? (() => undefined) }),
      openShortcuts: () => setDialog('shortcuts'),
      openPageSettings: () => setDialog('settings'),
      openHistory: () => setDialog('history'),
      saveBlock: () => setDialog('saveBlock'),
      toast: (m, k) => toast.push(m, k),
      save: (b) => saveRef.current(b),
      goToStep: (id) => nav(`/funnels/${funnel.id}/builder/${id}`),
    }),
    [toast, nav, funnel.id],
  );

  const setDeviceTo = (d: DeviceId) => {
    const dev = DEVICES.find((x) => x.id === d)!;
    editor?.setDevice(dev.name);
    setDevice(d);
  };
  const togglePreview = () => (editor?.Commands.isActive('core:preview') ? editor.stopCommand('core:preview') : editor?.runCommand('core:preview'));
  const openPreview = async () => {
    try {
      const t = await api.post<{ token: string }>(`/api/funnels/${funnel.id}/preview-token`);
      window.open(`/preview/${funnel.id}${step.path}?token=${t.token}`, '_blank', 'noopener');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  const wide = layout === 'wide';
  const hidePanels = previewing;
  const ctx = useMemo(() => (editor ? { editor, env: { funnelId: funnel.id, stepId: step.id, steps: funnel.steps.map((s) => ({ id: s.id, name: s.name })), canScripts }, ui } : null), [editor, funnel.id, funnel.steps, step.id, canScripts, ui]);
  const provide = (node: React.ReactNode) => (ctx ? <BuilderProvider value={ctx}>{node}</BuilderProvider> : null);

  return (
    <TooltipProvider>
      <div className="flex h-dvh min-h-[28rem] flex-col bg-bg text-fg" data-builder-ready={editor ? '1' : '0'} data-device={device}>
        {provide(
          <>
            <TopBar
              funnelName={funnel.name} stepId={step.id} steps={funnel.steps} onStep={(id) => ui.goToStep(id)}
              device={device} onDevice={setDeviceTo} previewing={previewing} onPreviewToggle={togglePreview}
              state={save} dirty={dirty} onSave={() => void doSave(true)} onPublish={() => setDialog('publish')}
              onHistory={() => setDialog('history')} onSettings={() => setDialog('settings')} onShortcuts={() => setDialog('shortcuts')} onOpenPreview={() => void openPreview()}
              toggles={{ left: layout === 'small', right: !wide }} onTogglePanels={(w) => setDrawer(drawer === w ? null : w)}
            />
            {save.kind === 'error' && save.message?.includes('Reload') ? <div className="alert error m-2" role="alert">{save.message} <Button size="sm" onClick={reload}>Reload page</Button></div> : null}
            {issues.length ? <div className="alert error m-2" role="alert"><strong>Fix before saving</strong><ul className="m-0 list-disc pl-5">{issues.slice(0, 6).map((i) => <li key={i}>{i}</li>)}</ul></div> : null}
            {notes.length ? <div className="alert warn m-2" role="status">{notes.slice(0, 2).join(' ')} <Button size="sm" onClick={() => setNotes([])}>Dismiss</Button></div> : null}
            {layout === 'small' && mobileNotice ? (
              <div role="status" className="m-2 flex items-start gap-2 rounded-lg border border-info/30 bg-info-soft p-3 text-sm text-info">
                <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">The builder works best on a larger screen. You can still make changes here; use a tablet or desktop for precise layout work.</span>
                <Button size="icon-sm" variant="ghost" aria-label="Dismiss notice" onClick={() => setMobileNotice(false)}><X /></Button>
              </div>
            ) : null}
          </>,
        )}
        <div className="relative flex min-h-0 flex-1">
          {!hidePanels && (layout !== 'small' || drawer === 'left') ? provide(
            <aside aria-label="Blocks, layers and pages" className={cn('flex min-h-0 flex-col border-border bg-surface', layout === 'small' ? 'absolute inset-y-0 left-0 z-30 w-[min(20rem,92vw)] border-r shadow-pop' : cn('shrink-0 border-r', wide ? 'w-[19.5rem]' : 'w-64'))}>
              {layout === 'small' ? <div className="flex items-center justify-between border-b border-border px-3 py-1.5"><span className="text-sm font-semibold">Add and arrange</span><Button size="icon-sm" variant="ghost" aria-label="Close panel" onClick={() => setDrawer(null)}><X /></Button></div> : null}
              <LeftRail tab={leftTab} onTab={setLeftTab} />
            </aside>,
          ) : null}
          <div ref={area} className="relative min-w-0 flex-1 bg-surface-3" data-canvas-area>
            <div ref={host} className="builder-canvas absolute inset-0" />
            {provide(<CanvasArea areaRef={area} previewing={previewing} />)}
            {!editor ? <div className="absolute inset-0 grid place-items-center text-sm text-muted" role="status">Loading the editor…</div> : null}
          </div>
          {!hidePanels && (wide || drawer === 'right') ? provide(
            <aside aria-label="Inspector" className={cn('flex min-h-0 flex-col border-border bg-surface', wide ? 'w-80 shrink-0 border-l' : 'absolute inset-y-0 right-0 z-30 w-[min(20rem,92vw)] border-l shadow-pop')}>
              {!wide ? <div className="flex items-center justify-between border-b border-border px-3 py-1.5"><span className="text-sm font-semibold">Inspector</span><Button size="icon-sm" variant="ghost" aria-label="Close inspector" onClick={() => setDrawer(null)}><X /></Button></div> : null}
              <Inspector />
            </aside>,
          ) : null}
        </div>
        {provide(
          <>
            <ShortcutsDialog open={dialog === 'shortcuts'} onClose={() => setDialog(null)} />
            {dialog === 'settings' ? <PageSettingsDialog open onClose={() => setDialog(null)} funnelId={funnel.id} domainId={funnel.domain?.id} step={step} /> : null}
            <HistoryDialog open={dialog === 'history'} onClose={() => setDialog(null)} dirty={dirty} onRestored={() => { setDialog(null); toast.push('Version restored', 'ok'); reload(); }} />
            {editor ? <SaveBlockDialog open={dialog === 'saveBlock'} onClose={() => setDialog(null)} editor={editor} /> : null}
            <AssetPickerDialog open={!!picker} onClose={() => setPicker(null)} onPick={(url) => picker?.pick(url)} />
            <AiRewriteDialog target={aiTarget} onClose={() => setAiTarget(null)} />
            <LinkDialog state={link as never} onClose={() => setLink(null)} />
            <PublishDialog open={dialog === 'publish'} onClose={() => setDialog(null)} funnel={funnel} dirty={dirty} save={doSave} saveState={save} onPreview={() => void openPreview()} />
          </>,
        )}
        {blocker.state === 'blocked' ? <ConfirmDialog danger title="Discard unsaved changes?" confirmLabel="Discard changes" message="You have changes that are not saved yet." onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} /> : null}
      </div>
    </TooltipProvider>
  );
}

/** Publishing = saving the page with a backup and telling the author where the page is served. Going live (domain + status) is a funnel setting, linked from here. */
function PublishDialog({ open, onClose, funnel, dirty, save, saveState, onPreview }: { open: boolean; onClose: () => void; funnel: FunnelDetail; dirty: boolean; save: (b: boolean) => Promise<void>; saveState: SaveState; onPreview: () => void }) {
  const nav = useNavigate();
  const live = funnel.status === 'live' && !!funnel.domain;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="sm" title={live ? 'Publish changes' : 'Publish'} description={live ? `Visitors of ${funnel.domain!.hostname} get the saved page.` : 'This funnel is in test mode.'}
      footer={<><Button onClick={onClose}>Close</Button>{live ? null : <Button onClick={() => { onClose(); nav(`/funnels/${funnel.id}/settings`); }}>Go live in settings</Button>}<Button variant="primary" disabled={saveState.kind === 'saving'} onClick={() => void save(true).then(onClose)}>{dirty ? 'Save and publish' : 'Publish'}</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        {live ? <p>The page is served at <strong>{funnel.domain!.hostname}</strong>. Saving updates it within seconds (the edge cache is purged).</p> : <p>Test funnels are not served on a domain. Use the preview link to check the page; connect a domain and set the funnel live in its settings to publish it for visitors.</p>}
        <div className="row"><Button size="sm" onClick={onPreview}>Open preview</Button>{dirty ? <span className="small text-warn">You have unsaved changes: they are saved first.</span> : <span className="small muted">Everything is saved.</span>}</div>
      </div>
    </Dialog>
  );
}
