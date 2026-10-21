import type { Component } from 'grapesjs';
import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { describeOp, type EditOp, type NodeSpec } from '@pagemodel';
import { api, errorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, FormField, Textarea } from '../../ui';
import { applyOps, buildOutline, diffRows, labelFor, type Outline } from '../aiEdit';
import { SELECTION_EVENTS, useBuilder, useEditorEvents } from '../useEditor';

const SUGGESTIONS = ['Make the hero shorter', 'Add an FAQ about shipping', 'Change the tone to playful', 'Add a testimonial section', 'Translate to Spanish'];

interface Proposal {
  summary: string;
  ops: EditOp[];
  source: 'model' | 'heuristic' | 'fallback';
  message?: string;
  outline: Outline;
  phase: 'proposed' | 'previewing';
  /** Undo-history signature right after the preview was applied: Reject undoes only while nothing was done after it. */
  sig?: string;
  skipped?: string[];
}

const SOURCE: Record<Proposal['source'], string> = { model: 'Suggested by the AI model', heuristic: 'Suggested by the built-in assistant', fallback: 'The AI model could not be used; the built-in assistant answered' };

/**
 * AI assistant: describe a change to the page, review the operations (never raw HTML), preview them on the canvas as one undoable step, then keep or undo.
 * Selection aware: with an element selected the instruction applies to it. Also "write this section" from a short description.
 */
export function AiPanel() {
  const { editor, ui } = useBuilder();
  const { can } = useAuth();
  useEditorEvents(editor, SELECTION_EVENTS);
  const [instruction, setInstruction] = useState('');
  const [section, setSection] = useState('');
  const [busy, setBusy] = useState<null | 'edit' | 'section'>(null);
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState<Proposal | null>(null);
  const allowed = can('ai:use') && can('funnels:write');
  const selected = editor.getSelected();
  const selectedIsPage = !selected || selected === editor.getWrapper();
  const um = editor.UndoManager;
  const sig = () => `${um.getStack().length}:${um.getPointer()}`;

  const run = async <T,>(kind: 'edit' | 'section', fn: () => Promise<T>, done: (r: T) => void) => {
    setBusy(kind);
    setError(null);
    try {
      done(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const ask = (text: string) =>
    run('edit', async () => {
      const outline = buildOutline(editor);
      const r = await api.post<{ summary: string; ops: EditOp[]; source: Proposal['source']; message?: string }>('/api/ai/edit', { instruction: text, outline: outline.root, ...(selected && !selectedIsPage ? { selectedId: selected.getId() } : {}) });
      return { ...r, outline };
    }, (r) => setP({ ...r, phase: 'proposed' }));

  const write = () =>
    run('section', async () => {
      const outline = buildOutline(editor);
      const r = await api.post<{ node: NodeSpec; source: Proposal['source']; message?: string }>('/api/ai/section', { description: section });
      const anchor = selected && !selectedIsPage ? selected : null;
      const op: EditOp = anchor ? { op: 'insert', target: anchor.getId(), position: 'after', node: r.node } : { op: 'insert', target: editor.getWrapper()!.getId(), position: 'end', node: r.node };
      return { summary: 'Add the new section', ops: [op], source: r.source, message: r.message, outline };
    }, (r) => setP({ ...r, phase: 'proposed' }));

  const preview = () => {
    if (!p) return;
    const r = applyOps(editor, p.ops, p.outline.map);
    setP({ ...p, phase: 'previewing', sig: sig(), skipped: r.skipped });
    if (r.applied === 0) ui.toast('Nothing could be applied', 'error');
  };
  const keep = () => { ui.toast('Changes kept. Undo reverts them in one step.', 'ok'); setP(null); setInstruction(''); setSection(''); };
  const reject = () => {
    if (p?.phase === 'previewing' && p.sig === sig()) um.undo();
    else if (p?.phase === 'previewing') ui.toast('You edited the page after the preview, so it was not undone automatically. Use Undo to step back.', 'info');
    setP(null);
  };
  const label = labelFor(p?.outline.map ?? new Map<string, Component>());

  if (!allowed) return <div className="p-3 text-sm text-muted" role="note">Using the AI assistant needs the permissions to use AI and to edit funnels.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3" data-testid="ai-panel">
      <section className="flex flex-col gap-2" aria-label="Edit this page">
        <h3 className="m-0 text-sm font-semibold">Edit with AI</h3>
        <p className="m-0 text-xs text-muted" role="status">{selected && !selectedIsPage ? `Applies to the selected ${String(selected.get('name') ?? selected.get('type') ?? 'element').toLowerCase()}.` : 'Nothing selected: applies to the whole page. Select an element to focus the change.'}</p>
        <FormField label="What should change?">{(f) => <Textarea {...f} rows={3} value={instruction} maxLength={1000} disabled={!!busy || p?.phase === 'previewing'} onChange={(e) => setInstruction(e.target.value)} placeholder="Make the hero shorter" />}</FormField>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Examples">
          {SUGGESTIONS.map((s) => <Button key={s} size="xs" disabled={!!busy || p?.phase === 'previewing'} onClick={() => setInstruction(s)}>{s}</Button>)}
        </div>
        <div><Button variant="primary" disabled={!instruction.trim() || !!busy || p?.phase === 'previewing'} onClick={() => void ask(instruction.trim())}>{busy === 'edit' ? <Loader2 className="animate-spin" /> : <Sparkles />} Suggest changes</Button></div>
      </section>

      <section className="flex flex-col gap-2 border-t border-border pt-3" aria-label="Write a section">
        <h3 className="m-0 text-sm font-semibold">Write a section</h3>
        <FormField label="Describe it" hint={selected && !selectedIsPage ? 'It is added after the selected block.' : 'It is added at the end of the page.'}>{(f) => <Textarea {...f} rows={2} value={section} maxLength={600} disabled={!!busy || p?.phase === 'previewing'} onChange={(e) => setSection(e.target.value)} placeholder="Three reasons to choose us" />}</FormField>
        <div><Button disabled={!section.trim() || !!busy || p?.phase === 'previewing'} onClick={() => void write()}>{busy === 'section' ? <Loader2 className="animate-spin" /> : null} Write section</Button></div>
      </section>

      {error ? <div className="alert error" role="alert">{error}</div> : null}

      {p ? (
        <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3" aria-label="Proposed changes" data-testid="ai-proposal">
          <strong className="text-sm">{p.summary}</strong>
          <span className="text-xs text-muted">{SOURCE[p.source]}. Review before applying.</span>
          {p.message ? <p className="m-0 text-sm" role="status">{p.message}</p> : null}
          {p.ops.length ? (
            <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Changes">
              {diffRows(p.ops, p.outline.map).map((row, i) => (
                <li key={i} className="text-sm">
                  {row.op.op === 'setText' ? (
                    <><span className="text-xs text-muted">Text of {label(row.op.target)}</span>
                      <del className="block text-danger">{row.before}</del>
                      <ins className="block text-ok no-underline">{row.after}</ins></>
                  ) : describeOp(row.op, label)}
                </li>
              ))}
            </ol>
          ) : <p className="m-0 text-sm text-muted">No changes to make.</p>}
          {p.skipped?.length ? <p className="m-0 text-xs text-warn" role="status">Skipped: {[...new Set(p.skipped)].join('; ')}.</p> : null}
          <div className="flex flex-wrap gap-2">
            {p.phase === 'proposed' ? (
              <>
                <Button variant="primary" disabled={!p.ops.length} onClick={preview}>Preview on the page</Button>
                <Button onClick={() => setP(null)}>Discard</Button>
              </>
            ) : (
              <>
                <Button variant="primary" onClick={keep}>Keep changes</Button>
                <Button onClick={reject}>Undo changes</Button>
              </>
            )}
          </div>
          {p.phase === 'previewing' ? <p className="m-0 text-xs text-muted">The changes are on the canvas now as a single step: Undo (⌘Z) also reverts them all at once.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
