import { useQuery } from '@tanstack/react-query';
import type { Block, Component, Editor } from 'grapesjs';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import { keys, useBackups, useMutate } from '../api/hooks';
import type { Step } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { HtmlFrame } from '../components/PreviewFrame';
import { Empty, ErrorBanner, fmtDate, Loading } from '../components/ui';
import { Badge, Button, Dialog, FormField, Input, Select, Textarea } from '../ui';
import { exportComponent } from './editor/exportBlock';
import { applyPageLook, readPageLook, type PageLook } from './editor/pageLook';
import { FONT_STACKS } from '@pagemodel';
import { AssetLibrary, type Asset } from './panels/AssetsPanel';
import { Row, inputCls } from './panels/kit';
import { useBuilder } from './useEditor';

/* ---------- keyboard shortcuts ---------- */
const SHORTCUTS: [string, [string, string][]][] = [
  ['Editing', [['Undo', '⌘ Z'], ['Redo', '⇧ ⌘ Z'], ['Duplicate', '⌘ D'], ['Copy / paste', '⌘ C / ⌘ V'], ['Delete', 'Delete'], ['Save', '⌘ S']]],
  ['Selection', [['Select multiple', 'Shift + click'], ['Select parent', '⇧ ↑'], ['Next / previous element', 'Tab / ⇧ Tab in layers, ↑ ↓']]],
  ['Arrange (keyboard alternative to dragging)', [['Move up / down', '⌥ ↑ / ⌥ ↓'], ['Move out of parent', '⌥ ←'], ['Reorder in Layers', '⌥ ↑ / ⌥ ↓ on a layer']]],
  ['View', [['Preview', '⇧ ⌘ P'], ['Zoom', 'Zoom bar at the bottom of the canvas'], ['This help', '?']]],
  ['Text', [['Bold / italic / underline', '⌘ B / I / U'], ['Edit text', 'Double-click, then select to format'], ['Finish editing', 'Click outside or Esc']]],
];
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Keyboard shortcuts" description="Ctrl instead of ⌘ on Windows and Linux." size="lg">
      <div className="grid gap-5 sm:grid-cols-2">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{group}</h3>
            <dl className="m-0 flex flex-col gap-1.5">
              {rows.map(([name, keysText]) => (
                <div key={name} className="flex items-center justify-between gap-3 text-sm"><dt>{name}</dt><dd className="m-0"><kbd className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[0.75rem]">{keysText}</kbd></dd></div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/* ---------- asset picker (image traits, backgrounds) ---------- */
export function AssetPickerDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (url: string) => void }) {
  const [url, setUrl] = useState('');
  const pick = (a: Asset) => { onPick(a.url); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Choose an image" description="Pick an uploaded image, upload a new one, or paste an address." size="lg">
      <div className="flex h-[26rem] flex-col"><AssetLibrary onPick={pick} compact /></div>
      <form className="mt-3 flex items-end gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); if (/^(https?:\/\/|\/)/.test(url.trim())) { onPick(url.trim()); onClose(); } }}>
        <FormField label="Or use an image address" className="flex-1">{(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/photo.jpg" />}</FormField>
        <Button type="submit" variant="primary" disabled={!/^(https?:\/\/|\/)/.test(url.trim())}>Use address</Button>
      </form>
    </Dialog>
  );
}

/* ---------- version history (legacy: History / backups, newest 10, restore backs up the replaced version) ---------- */
export function HistoryDialog({ open, onClose, dirty, onRestored }: { open: boolean; onClose: () => void; dirty: boolean; onRestored: () => void }) {
  const { env } = useBuilder();
  const list = useBackups(env.funnelId, env.stepId, open);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['backup', selected], enabled: !!selected, queryFn: () => api.get<{ html: string; label: string }>(`/api/funnels/${env.funnelId}/steps/${env.stepId}/backups/${selected}`) });
  const restore = useMutate((id: string) => api.post(`/api/funnels/${env.funnelId}/steps/${env.stepId}/backups/${id}/restore`), [['backups', env.stepId]]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} side="right" title="Version history" description="Each save keeps the version it replaced. The newest 10 are kept.">
      {dirty ? <div className="alert warn" role="status">You have unsaved changes. Restoring replaces them.</div> : null}
      <ErrorBanner error={list.error ?? restore.error} onRetry={() => void list.refetch()} />
      {list.isLoading ? <Loading rows={2} /> : null}
      {list.data && list.data.data.length === 0 ? <Empty title="No versions yet">Versions appear after you save.</Empty> : null}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {list.data?.data.map((b, i) => (
          <li key={b.id} className="card">
            <div className="row between"><strong className="text-sm">{b.label}</strong><span className="small muted">{fmtDate(b.createdAt)}</span></div>
            <div className="row mt-2">
              <Button size="sm" aria-expanded={selected === b.id} onClick={() => setSelected(selected === b.id ? null : b.id)}>{selected === b.id ? 'Hide preview' : 'Preview'}</Button>
              <Button size="sm" variant="primary" disabled={restore.isPending} onClick={() => restore.mutate(b.id, { onSuccess: onRestored })}>Restore{i === 0 ? ' latest' : ''}</Button>
            </div>
            {selected === b.id ? (detail.isLoading ? <Loading rows={1} /> : detail.data ? <div className="mt-2"><HtmlFrame html={detail.data.html} title={`Version ${b.label}`} device="mobile" height={320} /></div> : <ErrorBanner error={detail.error} />) : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ---------- page settings (step details, SEO, look, custom CSS, tracking) ---------- */
export interface PageSettingsValue { name: string; path: string; title: string; seo: string; css: string; header: string; footer: string; accent: string; background: string; font: string }
export function validatePageSettings(v: PageSettingsValue): Partial<Record<'name' | 'path' | 'title' | 'seo' | 'accent' | 'background', string>> {
  const e: Partial<Record<'name' | 'path' | 'title' | 'seo' | 'accent' | 'background', string>> = {};
  const color = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|(rgb|hsl)a?\([0-9.,%\s/]{3,40}\))$/;
  if (!v.name.trim()) e.name = 'Give the step a name';
  if (!/^\/([a-zA-Z0-9-]|%[0-9A-Fa-f]{2})*([^/.]\/?)?$/.test(v.path) || /[\s?#\\]/.test(v.path)) e.path = 'Use a path like /thank-you: letters, digits and "-" only';
  if (v.title.length > 200) e.title = 'Keep the title under 200 characters';
  if (v.seo.length > 400) e.seo = 'Keep the description under 400 characters';
  if (v.accent && !color.test(v.accent)) e.accent = 'Use a colour such as #2563eb';
  if (v.background && !color.test(v.background)) e.background = 'Use a colour such as #ffffff';
  return e;
}

export function PageSettingsDialog({ open, onClose, funnelId, domainId, step }: { open: boolean; onClose: () => void; funnelId: string; domainId?: string; step: Step }) {
  const { editor } = useBuilder();
  const { can } = useAuth();
  const look = readPageLook(editor);
  const [v, setV] = useState<PageSettingsValue>({ name: step.name, path: step.path, title: step.title ?? '', seo: step.seoDescription ?? '', css: step.customCss ?? '', header: step.headerTrackingCode ?? '', footer: step.footerTrackingCode ?? '', accent: look.accent, background: look.background, font: look.font });
  const [pathError, setPathError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const errors = validatePageSettings(v);
  const save = useMutate((body: object) => api.patch(`/api/funnels/${funnelId}/steps/${step.id}`, body), [keys.funnel(funnelId), keys.funnels]);
  useEffect(() => {
    if (v.path === step.path) { setPathError(null); setSuggestions([]); return; }
    const t = setTimeout(() => {
      api.post<{ success: boolean; uniquePaths: string[] }>('/api/funnels/validate-path', { path: v.path, funnelId, stepId: step.id, domainId })
        .then((r) => { setPathError(r.success ? null : 'This path is already used'); setSuggestions(r.success ? [] : r.uniquePaths); })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [v.path, step.path, step.id, funnelId, domainId]);
  const submit = () => {
    if (Object.keys(errors).length || pathError) return;
    const body: Record<string, unknown> = { name: v.name.trim(), base_path: v.path, title: v.title || null, seo_description: v.seo || null, custom_css: v.css || null };
    if (can('funnels:tracking')) Object.assign(body, { header_tracking_code: v.header || null, footer_tracking_code: v.footer || null });
    save.mutate(body, { onSuccess: () => { applyPageLook(editor, { accent: v.accent, background: v.background, font: v.font } as Partial<PageLook>); onClose(); } });
  };
  const serverField = save.error instanceof ApiError ? save.error.fieldErrors : {};
  const set = (n: Partial<PageSettingsValue>) => setV({ ...v, ...n });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Page settings" size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending || Object.keys(errors).length > 0 || !!pathError} onClick={submit}>Apply</Button></>}>
      <ErrorBanner error={save.error} />
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Details</h3>
          <FormField label="Step name" error={errors.name ?? serverField.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => set({ name: e.target.value })} />}</FormField>
          <FormField label="Path" error={errors.path ?? pathError ?? undefined}>{(p) => <Input {...p} value={v.path} onChange={(e) => set({ path: e.target.value })} />}</FormField>
          {suggestions.length ? <p className="small">Try: {suggestions.map((s) => <Button key={s} size="xs" className="mr-1" onClick={() => set({ path: s })}>{s}</Button>)}</p> : null}
          <h3 className="mt-2 text-sm font-semibold">Look</h3>
          <FormField label="Accent colour" error={errors.accent}>{(p) => <Input {...p} value={v.accent} onChange={(e) => set({ accent: e.target.value })} placeholder="#4338ca" />}</FormField>
          <FormField label="Page background" error={errors.background}>{(p) => <Input {...p} value={v.background} onChange={(e) => set({ background: e.target.value })} placeholder="#ffffff" />}</FormField>
          <FormField label="Font">{(p) => <Select {...p} value={v.font} onValueChange={(font) => set({ font })} options={[{ value: '', label: 'Inter (default)' }, ...Object.keys(FONT_STACKS).map((k) => ({ value: k, label: k }))]} />}</FormField>
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">SEO</h3>
          <FormField label="Page title" hint="Shown in the browser tab and search results" error={errors.title}>{(p) => <Input {...p} value={v.title} onChange={(e) => set({ title: e.target.value })} />}</FormField>
          <FormField label="Meta description" error={errors.seo}>{(p) => <Textarea {...p} rows={3} value={v.seo} onChange={(e) => set({ seo: e.target.value })} />}</FormField>
          <h3 className="mt-2 text-sm font-semibold">Custom CSS</h3>
          <FormField label="CSS for this page" hint="Filtered like everything else: unsafe rules are removed when the page is published.">{(p) => <Textarea {...p} rows={4} className="font-mono text-[0.8rem]" value={v.css} onChange={(e) => set({ css: e.target.value })} />}</FormField>
        </div>
      </div>
      {can('funnels:tracking') ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Tracking code</h3>
          <p className="small muted mb-2">Published only when the workspace allows custom scripts (Settings).</p>
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="Header code">{(p) => <Textarea {...p} rows={3} className="font-mono text-[0.8rem]" value={v.header} onChange={(e) => set({ header: e.target.value })} />}</FormField>
            <FormField label="Footer code">{(p) => <Textarea {...p} rows={3} className="font-mono text-[0.8rem]" value={v.footer} onChange={(e) => set({ footer: e.target.value })} />}</FormField>
          </div>
        </div>
      ) : <p className="small muted mt-4">Admins can edit tracking code.</p>}
    </Dialog>
  );
}

/* ---------- AI rewrite for the selected text (calls the existing /api/ai/rewrite and /api/ai/headlines) ---------- */
type Tone = 'persuasive' | 'concise' | 'friendly' | 'formal';
const plain = (c: Component): string => (c.getEl()?.innerText ?? '').trim();

export function AiRewriteDialog({ target, onClose }: { target: Component | null; onClose: () => void }) {
  const { editor, ui } = useBuilder();
  const [tone, setTone] = useState<Tone>('persuasive');
  const [length, setLength] = useState<'shorter' | 'same' | 'longer'>('same');
  const text = target ? plain(target) : '';
  const isHeading = !!target && /^h[1-6]$/.test(String(target.get('tagName')));
  const rewrite = useMutate(() => api.post<{ text: string; source: string }>('/api/ai/rewrite', { text, tone, length }));
  const ideas = useMutate(() => api.post<{ headlines: string[]; source: string }>('/api/ai/headlines', { topic: text, tone }));
  useEffect(() => { rewrite.reset(); ideas.reset(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const apply = (t: string) => {
    if (!target) return;
    // Plain text replaces the content (formatting inside the block is replaced); structure and styling of the element are untouched.
    target.components([{ type: 'textnode', content: t }] as never);
    editor.select(target);
    ui.toast('Text updated', 'ok');
    onClose();
  };
  const note = (s: string) => <span className="small muted">{s === 'model' ? 'Written by the AI model.' : 'Written by the built-in writer.'} Review before applying.</span>;
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()} title="Rewrite with AI" description="Suggestions are only applied when you click Apply." size="md">
      <blockquote className="m-0 mb-3 rounded-md border-l-4 border-primary bg-surface-2 px-3 py-2 text-sm">{text || 'This element has no text.'}</blockquote>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Tone">{(p) => <Select {...p} value={tone} onValueChange={(t) => setTone(t as Tone)} options={['persuasive', 'concise', 'friendly', 'formal'].map((t) => ({ value: t, label: t }))} />}</FormField>
        <FormField label="Length">{(p) => <Select {...p} value={length} onValueChange={(l) => setLength(l as typeof length)} options={[{ value: 'shorter', label: 'Shorter' }, { value: 'same', label: 'Same' }, { value: 'longer', label: 'Longer' }]} />}</FormField>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" disabled={!text || rewrite.isPending} onClick={() => rewrite.mutate(undefined)}>{rewrite.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />} Rewrite</Button>
        {isHeading ? <Button disabled={!text || ideas.isPending} onClick={() => ideas.mutate(undefined)}>{ideas.isPending ? 'Thinking…' : '5 headline ideas'}</Button> : null}
      </div>
      <ErrorBanner error={rewrite.error ?? ideas.error} />
      {rewrite.data ? (
        <div className="mt-4 flex flex-col gap-2" aria-label="Rewrite suggestion">
          <blockquote className="m-0 rounded-md border-l-4 border-ok bg-ok-soft px-3 py-2 text-sm">{rewrite.data.text}</blockquote>
          {note(rewrite.data.source)}
          <div className="row"><Button variant="primary" size="sm" onClick={() => apply(rewrite.data!.text)}>Apply</Button><Button size="sm" onClick={() => rewrite.reset()}>Discard</Button></div>
        </div>
      ) : null}
      {ideas.data ? (
        <div className="mt-4 flex flex-col gap-2" aria-label="Headline ideas">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{ideas.data.headlines.map((h) => <li key={h}><Button className="w-full justify-start whitespace-normal text-left" onClick={() => apply(h)}>{h}</Button></li>)}</ul>
          {note(ideas.data.source)}
        </div>
      ) : null}
    </Dialog>
  );
}

/* ---------- link dialog for the inline text editor ---------- */
export function LinkDialog({ state, onClose }: { state: { rte: { exec(c: string, v?: string): void; doc: Document }; range: Range | null; href: string } | null; onClose: () => void }) {
  const [href, setHref] = useState('');
  useEffect(() => setHref(state?.href ?? ''), [state]);
  const restore = () => {
    if (!state) return;
    const sel = state.rte.doc.getSelection();
    if (sel && state.range) { sel.removeAllRanges(); sel.addRange(state.range); }
  };
  const ok = /^(https?:\/\/|mailto:|tel:|\/|#)\S*$/.test(href.trim());
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()} title="Link" size="sm"
      footer={<>{state?.href ? <Button variant="danger" onClick={() => { restore(); state.rte.exec('unlink'); onClose(); }}>Remove link</Button> : null}<Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} onClick={() => { restore(); state!.rte.exec('createLink', href.trim()); onClose(); }}>Apply</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); if (ok && state) { restore(); state.rte.exec('createLink', href.trim()); onClose(); } }}>
        <FormField label="Address" hint="https://…, mailto:…, tel:…, /path or #anchor">{(p) => <Input {...p} data-autofocus value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://example.com" />}</FormField>
      </form>
    </Dialog>
  );
}

/* ---------- save selection as a reusable block ---------- */
export function SaveBlockDialog({ open, onClose, editor }: { open: boolean; onClose: () => void; editor: Editor }) {
  const { ui } = useBuilder();
  const [name, setName] = useState('');
  const save = useMutate((b: { name: string; block: unknown }) => api.post('/api/blocks', b), [keys.blocks]);
  const sel = editor.getSelected();
  useEffect(() => setName(''), [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Save as my block" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || save.isPending || !sel} onClick={() => sel && save.mutate({ name: name.trim(), block: exportComponent(editor, sel) }, { onSuccess: () => { ui.toast('Block saved', 'ok'); onClose(); } })}>Save</Button></>}>
      <ErrorBanner error={save.error} />
      <FormField label="Name" hint="Blocks with forms or checkouts cannot be saved (their ids must be unique on a page).">{(p) => <Input {...p} data-autofocus value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
    </Dialog>
  );
}

export type { Block };
export { Row, inputCls, Badge };
