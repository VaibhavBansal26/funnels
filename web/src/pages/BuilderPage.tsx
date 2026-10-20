import { useQueryClient } from '@tanstack/react-query';
import { parseDocument, emptyDocument, type Block, type BlockType } from '@blocks';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { keys, useCustomBlocks, useFunnel, useMutate, usePage } from '../api/hooks';
import type { FunnelDetail, PageData, Step } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AltAssist, TextAssist } from '../builder/AiAssist';
import { Canvas } from '../builder/Canvas';
import { HistoryDrawer } from '../builder/HistoryDrawer';
import { Inspector } from '../builder/Inspector';
import { randomId } from '../builder/ids';
import { Outline } from '../builder/Outline';
import { Palette } from '../builder/Palette';
import { PageSettingsDialog } from '../builder/PageSettingsDialog';
import { builderReducer, canRedo, canUndo, initialState, isDirty } from '../builder/reducer';
import { describeIssues, prepareSave } from '../builder/serialize';
import { findBlock, isContainer } from '../builder/tree';
import type { Device } from '../components/PreviewFrame';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, ErrorBanner, Loading, Modal, TextField } from '../components/ui';

type SaveState = { kind: 'idle' | 'saving' | 'saved' | 'autosaved' | 'error'; at?: Date; message?: string };
const AUTOSAVE_MS = 20_000;

function Editor({ funnel, step, page, reload }: { funnel: FunnelDetail; step: Step; page: PageData; reload: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const custom = useCustomBlocks();
  const parsed = useMemo(() => {
    const r = parseDocument(page.doc);
    return r.ok ? r.doc : emptyDocument();
  }, [page.doc]);
  const [state, dispatch] = useReducer(builderReducer, undefined, () => initialState(parsed, page.version));
  const [device, setDevice] = useState<Device>('desktop');
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [issues, setIssues] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [namingBlock, setNamingBlock] = useState<Block | null>(null);
  const [blockName, setBlockName] = useState('');
  const dirty = isDirty(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const saving = useRef(false);

  const stepOptions = useMemo(() => funnel.steps.map((s) => ({ id: s.id, name: s.name })), [funnel.steps]);
  const selected = state.selectedId ? findBlock(state.doc, state.selectedId) : null;

  const doSave = useCallback(
    async (backup: boolean) => {
      const s = stateRef.current;
      if (saving.current) return;
      const check = prepareSave(s.doc, s.version, backup);
      if (!check.ok) {
        setIssues(describeIssues(check.issues));
        setSave({ kind: 'error', message: 'Fix the highlighted problems before saving' });
        return;
      }
      setIssues([]);
      saving.current = true;
      setSave({ kind: 'saving' });
      try {
        const r = await api.put<{ version: number }>(`/api/funnels/${funnel.id}/steps/${step.id}/page`, check.body);
        dispatch({ type: 'saved', version: r.version, doc: check.doc });
        void qc.invalidateQueries({ queryKey: keys.funnels });
        setSave({ kind: backup ? 'saved' : 'autosaved', at: new Date() });
      } catch (e) {
        const conflict = e instanceof ApiError && e.code === 'VERSION_CONFLICT';
        setSave({ kind: 'error', message: conflict ? 'This page was changed in another tab or by a teammate. Reload to get the latest version.' : errorMessage(e) });
      } finally {
        saving.current = false;
      }
    },
    [funnel.id, step.id, qc],
  );

  // Autosave after a quiet period; autosaves do not consume backup slots.
  useEffect(() => {
    if (!dirty || save.kind === 'error') return;
    const t = setTimeout(() => void doSave(false), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, state.doc, save.kind, doSave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave(true);
      } else if (mod && !typing && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
      } else if (mod && !typing && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSave]);

  // Unsaved-changes guard: browser unload and in-app navigation.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const blocker = useBlocker(dirty);

  const saveCustom = useMutate((b: { name: string; block: Block }) => api.post('/api/blocks', b), [keys.blocks]);
  const delCustom = useMutate((id: string) => api.delete(`/api/blocks/${id}`), [keys.blocks]);

  const addBlock = useCallback((t: BlockType, loc?: Parameters<typeof builderReducer>[1] extends infer A ? (A extends { type: 'add'; loc?: infer L } ? L : never) : never) => {
    const taken = new Set<string>();
    const walk = (list: Block[]) => list.forEach((b) => { taken.add(b.id); if (b.type === 'section') walk(b.children); if (b.type === 'columns') b.columns.forEach((c) => { taken.add(c.id); walk(c.children); }); });
    walk(stateRef.current.doc.blocks);
    let id = randomId();
    while (taken.has(id)) id = randomId();
    dispatch({ type: 'add', blockType: t, id, loc });
  }, []);

  const openPreview = async () => {
    try {
      const t = await api.post<{ token: string }>(`/api/funnels/${funnel.id}/preview-token`);
      window.open(`/preview/${funnel.id}${step.path}?token=${t.token}`, '_blank', 'noopener');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  const b = selected?.block;
  const parentList = selected ? (selected.loc.parentId === null ? state.doc.blocks : (() => { const p = findBlock(state.doc, selected.loc.parentId)!.block; return p.type === 'section' ? p.children : p.type === 'columns' ? p.columns[selected.loc.slot]!.children : []; })()) : [];
  const prev = selected ? parentList[selected.loc.index - 1] : undefined;
  const textBlock = b && (b.type === 'paragraph' || b.type === 'heading') ? b : null;
  const aiSlot = textBlock
    ? <TextAssist text={textBlock.text} heading={textBlock.type === 'heading'} onApply={(text) => dispatch({ type: 'update', id: textBlock.id, patch: { text } })} />
    : b?.type === 'image' ? <AltAssist src={b.src} context={funnel.name} onApply={(alt) => dispatch({ type: 'update', id: b.id, patch: { alt } })} /> : null;

  const saveLabel =
    save.kind === 'saving' ? 'Saving…' : save.kind === 'error' ? save.message ?? 'Save failed' : dirty ? 'Unsaved changes' : save.at ? `${save.kind === 'autosaved' ? 'Autosaved' : 'Saved'} ${save.at.toLocaleTimeString()}` : 'All changes saved';

  return (
    <div className="builder">
      <div className="builder-bar" role="toolbar" aria-label="Builder">
        <Link className="btn sm ghost" to={`/funnels/${funnel.id}/steps`}>← {funnel.name}</Link>
        <label className="sr-only" htmlFor="step-switch">Step</label>
        <select id="step-switch" className="input" style={{ width: 'auto' }} value={step.id} onChange={(e) => nav(`/funnels/${funnel.id}/builder/${e.target.value}`)}>
          {funnel.steps.map((s) => <option key={s.id} value={s.id}>{s.position}. {s.name}</option>)}
        </select>
        <button type="button" className="btn sm" aria-label="Undo" disabled={!canUndo(state)} onClick={() => dispatch({ type: 'undo' })}>↶ Undo</button>
        <button type="button" className="btn sm" aria-label="Redo" disabled={!canRedo(state)} onClick={() => dispatch({ type: 'redo' })}>↷ Redo</button>
        <span className="row" role="group" aria-label="Device preview">
          {(['desktop', 'tablet', 'mobile'] as Device[]).map((d) => <button key={d} type="button" className="btn sm" aria-pressed={device === d} onClick={() => setDevice(d)}>{d}</button>)}
        </span>
        <span className="grow" />
        <span className={`save-state ${save.kind === 'error' ? 'error' : dirty ? 'dirty' : ''}`} role="status" aria-live="polite">{saveLabel}</span>
        <button type="button" className="btn sm" onClick={() => setSettingsOpen(true)}>Page settings</button>
        <button type="button" className="btn sm" onClick={() => setHistoryOpen(true)}>History</button>
        <button type="button" className="btn sm" onClick={() => void openPreview()}>Preview</button>
        <button type="button" className="btn sm primary" disabled={save.kind === 'saving' || !dirty} onClick={() => void doSave(true)}>Save</button>
      </div>

      {save.kind === 'error' && save.message?.includes('Reload') ? <div className="alert error" role="alert" style={{ margin: 8 }}>{save.message} <button type="button" className="btn sm" onClick={reload}>Reload page</button></div> : null}
      {issues.length ? <div className="alert error" role="alert" style={{ margin: 8 }}><strong>Fix before saving</strong><ul style={{ margin: 0 }}>{issues.map((i) => <li key={i}>{i}</li>)}</ul></div> : null}
      {state.notice ? <div className="alert warn" role="status" style={{ margin: 8 }}>{state.notice} <button type="button" className="btn sm" onClick={() => dispatch({ type: 'dismissNotice' })}>Dismiss</button></div> : null}

      <div className="builder-body">
        <aside className="pane left" aria-label="Blocks and structure">
          <Palette
            onAdd={(t) => addBlock(t)}
            custom={custom.data?.data ?? []}
            onInsertCustom={(c) => {
              const copy = structuredClone(c.block) as Block;
              const rename = (blk: Block) => { blk.id = randomId(); if (blk.type === 'section') blk.children.forEach(rename); if (blk.type === 'columns') blk.columns.forEach((col) => { col.id = randomId('c'); col.children.forEach(rename); }); };
              rename(copy);
              dispatch({ type: 'insert', block: copy });
            }}
            onDeleteCustom={(c) => delCustom.mutate(c.id)}
          />
          <h3>Structure</h3>
          <Outline
            blocks={state.doc.blocks}
            selectedId={state.selectedId}
            onSelect={(id) => dispatch({ type: 'select', id })}
            onMoveTo={(id, loc) => dispatch({ type: 'moveTo', id, loc })}
            onAdd={(t, loc) => addBlock(t, loc)}
            onMoveBy={(id, delta) => dispatch({ type: 'moveBy', id, delta })}
            onRemove={(id) => dispatch({ type: 'remove', id })}
          />
        </aside>

        <Canvas doc={state.doc} funnelId={funnel.id} stepId={step.id} stepName={step.name} steps={stepOptions} device={device} selectedId={state.selectedId} onSelect={(id) => dispatch({ type: 'select', id })} />

        <aside className="pane right" aria-label="Block settings">
          {b && selected ? (
            <Inspector
              key={b.id}
              block={b}
              steps={stepOptions}
              aiSlot={aiSlot}
              onChange={(patch, key) => dispatch({ type: 'update', id: b.id, patch, coalesce: key })}
              onRemove={() => dispatch({ type: 'remove', id: b.id })}
              onDuplicate={() => dispatch({ type: 'duplicate', id: b.id })}
              onMove={(delta) => dispatch({ type: 'moveBy', id: b.id, delta })}
              onMoveOut={() => dispatch({ type: 'moveOut', id: b.id })}
              onMoveIntoPrevious={() => dispatch({ type: 'moveIntoPrevious', id: b.id })}
              onAddColumn={() => dispatch({ type: 'addColumn', id: b.id })}
              onRemoveColumn={(slot) => dispatch({ type: 'removeColumn', id: b.id, slot })}
              onSaveCustom={() => { setNamingBlock(b); setBlockName(''); }}
              canMoveUp={selected.loc.index > 0}
              canMoveDown={selected.loc.index < parentList.length - 1}
              canMoveOut={selected.loc.parentId !== null}
              canMoveIn={isContainer(prev)}
            />
          ) : (
            <div className="inspector"><h2 style={{ fontSize: '1rem' }}>Nothing selected</h2><p className="muted small">Click a block in the preview or the structure list to edit it. Use the palette to add blocks; drag blocks in the structure list or press Alt+↑/↓ to reorder.</p></div>
          )}
        </aside>
      </div>

      {settingsOpen ? <PageSettingsDialog funnelId={funnel.id} domainId={funnel.domain?.id} step={step} settings={state.doc.settings} isAdmin={can('funnels:tracking')} onClose={() => setSettingsOpen(false)} onApplyDoc={(patch) => dispatch({ type: 'settings', patch })} /> : null}
      {historyOpen ? <HistoryDrawer funnelId={funnel.id} stepId={step.id} stepName={step.name} dirty={dirty} onClose={() => setHistoryOpen(false)} onRestored={() => { setHistoryOpen(false); toast.push('Version restored', 'ok'); reload(); }} /> : null}
      {namingBlock ? (
        <Modal title="Save as my block" onClose={() => setNamingBlock(null)} footer={<><button type="button" className="btn" onClick={() => setNamingBlock(null)}>Cancel</button><button type="button" className="btn primary" disabled={!blockName.trim() || saveCustom.isPending} onClick={() => saveCustom.mutate({ name: blockName.trim(), block: namingBlock }, { onSuccess: () => { toast.push('Block saved', 'ok'); setNamingBlock(null); } })}>Save</button></>}>
          <ErrorBanner error={saveCustom.error} />
          <TextField label="Name" value={blockName} onChange={setBlockName} data-autofocus />
        </Modal>
      ) : null}
      {blocker.state === 'blocked' ? <ConfirmDialog danger title="Discard unsaved changes?" confirmLabel="Discard changes" message="You have changes that are not saved yet." onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} /> : null}
    </div>
  );
}

export function BuilderPage() {
  const { id = '', stepId = '' } = useParams();
  const funnel = useFunnel(id);
  const page = usePage(id, stepId);
  const [nonce, setNonce] = useState(0);
  const qc = useQueryClient();
  const reload = useCallback(() => {
    void qc.invalidateQueries({ queryKey: keys.funnel(id) });
    qc.removeQueries({ queryKey: ['page', stepId] });
    void page.refetch().then(() => setNonce((n) => n + 1));
  }, [qc, id, stepId, page]);
  if (funnel.isLoading || page.isLoading) return <div style={{ padding: 24 }}><Loading /></div>;
  const error = funnel.error ?? page.error;
  if (error) return <div style={{ padding: 24 }}><ErrorBanner error={error} onRetry={() => { void funnel.refetch(); void page.refetch(); }} /><Link className="btn" to="/funnels">Back to funnels</Link></div>;
  const step = funnel.data!.steps.find((s) => s.id === stepId);
  if (!step) return <div style={{ padding: 24 }}><ErrorBanner error={new ApiError(404, 'NOT_FOUND', 'Step not found')} /><Link className="btn" to={`/funnels/${id}/steps`}>Back to steps</Link></div>;
  return <Editor key={`${stepId}:${page.data!.version}:${nonce}`} funnel={funnel.data!} step={step} page={page.data!} reload={reload} />;
}

