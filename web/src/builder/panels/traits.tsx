// Adapted from the legacy builder (see docs/PROVENANCE.md): the per-element settings it had as separate React setting types (ButtonSettings / OnClickSettings, FormSettings,
// CountdownSettings, CheckoutSettings with order bump and one-click upsell, FaqSettings, ImageSettings, VideoSettings, PopupSetting, ProgressBarSettings).
// Here each is an editor for one typed GrapesJS trait; values are validated with the same schemas the server applies.
import type { Component, Editor, Trait } from 'grapesjs';
import { ArrowDown, ArrowUp, ImageIcon, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CheckoutSchemaHint, FormPropsSchema, ProductPropsSchema, VideoPropsSchema, CountdownPropsSchema, parseVideoUrl, type FormProps, type ProductProps } from '../pagemodel-bridge';
import { api, errorMessage } from '../../api/client';
import { Button, Input, Select, Slider, Switch, Textarea } from '../../ui';
import { randomId } from '../editor/types';
import { useBuilder } from '../useEditor';
import { inputCls, Row } from './kit';

export interface TraitProps {
  editor: Editor;
  component: Component;
  trait: Trait;
}

const val = <T,>(t: Trait, fallback: T): T => (t.getValue() as T | undefined) ?? fallback;
/** The trait's CURRENT value merged over what this render saw: two edits in quick succession (two fields, two keystrokes) must not overwrite each other with a stale copy. */
const live = <T extends object>(t: Trait, seen: T): T => ({ ...seen, ...((t.getValue() as T | undefined) ?? {}) });
const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[0.8rem] font-medium text-muted">{label}</span>
    {children}
    {hint ? <span className="text-[0.72rem] text-muted">{hint}</span> : null}
  </div>
);
const Check = ({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <label htmlFor={id} className="flex items-center gap-2 text-[0.82rem] font-medium">
    <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} /> {label}
  </label>
);
const Issues = ({ issues }: { issues: string[] }) => (issues.length ? <ul role="alert" className="m-0 list-disc rounded-md bg-danger-soft px-5 py-2 text-[0.78rem] text-danger">{issues.slice(0, 4).map((i) => <li key={i}>{i}</li>)}</ul> : null);

/* ---------- basic ---------- */
export function BasicTrait({ trait }: TraitProps) {
  const type = trait.get('type');
  const label = trait.getLabel();
  const id = `trait-${trait.getName()}`;
  const [error, setError] = useState('');
  if (type === 'checkbox') return <Check id={id} label={label} checked={!!trait.getValue()} onChange={(v) => trait.setValue(v)} />;
  if (type === 'select') {
    const options = trait.getOptions().map((o: { id?: string; value?: string; label?: string; name?: string }) => ({ value: String(o.id ?? o.value ?? ''), label: String(o.label ?? o.name ?? o.id ?? o.value) }));
    return <Row label={label} htmlFor={id}><Select size="sm" id={id} value={String(trait.getValue() ?? '')} options={options} onValueChange={(v) => trait.setValue(v)} aria-label={label} /></Row>;
  }
  if (type === 'number') {
    return <Row label={label} htmlFor={id}><input id={id} type="number" className={inputCls} value={Number(trait.getValue() ?? 0)} min={trait.get('min')} max={trait.get('max')} step={trait.get('step') ?? 1} onChange={(e) => trait.setValue(Number(e.target.value))} /></Row>;
  }
  const isId = trait.getName() === 'id';
  return (
    <Row label={label} htmlFor={id}>
      <input
        id={id}
        className={inputCls}
        aria-invalid={!!error || undefined}
        value={String(trait.getValue() ?? '')}
        placeholder={String(trait.get('placeholder') ?? '')}
        onChange={(e) => {
          const v = e.target.value;
          if (isId && v && !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v)) return setError('Start with a letter; letters, digits, - and _ only');
          setError('');
          trait.setValue(v);
        }}
      />
      {error ? <span role="alert" className="text-[0.72rem] text-danger">{error}</span> : null}
    </Row>
  );
}

/* ---------- button action (legacy: On click settings) ---------- */
const ACTIONS = [
  { value: 'none', label: 'Does nothing' }, { value: 'next_step', label: 'Go to the next step' }, { value: 'step', label: 'Go to a step…' },
  { value: 'link', label: 'Open a web address…' }, { value: 'anchor', label: 'Scroll to an element…' }, { value: 'popup', label: 'Open a popup…' },
];
export function ActionTrait({ editor, component, trait }: TraitProps) {
  const { env } = useBuilder();
  const a = val<Record<string, unknown>>(trait, { type: 'none' });
  const set = (next: Record<string, unknown>) => trait.setValue(next);
  // anchors a button can scroll to: ids the author set (auto-generated ids of GrapesJS are not stable and are skipped)
  const anchors = [...new Set(editor.getWrapper()!.find('*').map((c) => String(c.getAttributes().id ?? '')).filter((id) => id && !/^i[a-z0-9]{3,4}$/.test(id) && id !== 'fnroot'))].slice(0, 80);
  const popups = [...new Set(editor.getWrapper()!.findType('fn-popup').map((c) => String(c.getAttributes().id ?? '')).filter(Boolean))];
  void component;
  return (
    <div className="flex flex-col gap-2.5">
      <Row label="When clicked"><Select size="sm" aria-label="When clicked" value={String(a.type)} options={ACTIONS} onValueChange={(type) => set(type === 'step' ? { type, stepId: env.steps.find((s) => s.id !== env.stepId)?.id ?? env.steps[0]?.id ?? '' } : type === 'link' ? { type, url: 'https://', newTab: false } : type === 'anchor' ? { type, anchor: anchors[0] ?? '' } : type === 'popup' ? { type, popupId: popups[0] ?? '' } : { type })} /></Row>
      {a.type === 'step' ? <Row label="Step"><Select size="sm" aria-label="Step" value={String(a.stepId)} options={env.steps.map((s, i) => ({ value: s.id, label: `${i + 1}. ${s.name}` }))} onValueChange={(stepId) => set({ type: 'step', stepId })} /></Row> : null}
      {a.type === 'link' ? (
        <>
          <Row label="Address"><input aria-label="Link address" className={inputCls} value={String(a.url ?? '')} placeholder="https://example.com or /path" onChange={(e) => set({ ...a, url: e.target.value })} /></Row>
          <Check id="act-newtab" label="Open in a new tab" checked={!!a.newTab} onChange={(newTab) => set({ ...a, newTab })} />
        </>
      ) : null}
      {a.type === 'anchor' ? (
        <Row label="Element ID">
          <input aria-label="Element ID to scroll to" list="anchor-list" className={inputCls} value={String(a.anchor ?? '')} placeholder="pricing" onChange={(e) => set({ type: 'anchor', anchor: e.target.value })} />
          <datalist id="anchor-list">{anchors.map((x) => <option key={x} value={x} />)}</datalist>
        </Row>
      ) : null}
      {a.type === 'popup' ? (popups.length ? <Row label="Popup"><Select size="sm" aria-label="Popup" value={String(a.popupId ?? '')} options={popups.map((p) => ({ value: p, label: p }))} onValueChange={(popupId) => set({ type: 'popup', popupId })} /></Row> : <p className="text-[0.78rem] text-muted">Add a Popup block first (Blocks, Interactive).</p>) : null}
    </div>
  );
}

/* ---------- image source (legacy: Image settings) ---------- */
export function AssetTrait({ trait, component, editor }: TraitProps) {
  const { ui } = useBuilder();
  const [busy, setBusy] = useState(false);
  const src = String(trait.getValue() ?? '');
  // AI alt text (POST /api/ai/alt-text): a suggestion written into the alt field, which the author reviews; nothing is applied silently.
  const suggestAlt = async () => {
    setBusy(true);
    try {
      const heading = editor.getWrapper()?.findType('fn-heading')[0]?.getEl()?.textContent?.trim();
      const r = await api.post<{ alt: string }>('/api/ai/alt-text', { src: src.startsWith('data:') ? 'image' : src, ...(heading ? { context: heading } : {}) });
      component.addAttributes({ alt: r.alt });
      ui.toast('Alt text suggested. Check that it describes your image.', 'ok');
    } catch (e) {
      ui.toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid aspect-video place-items-center overflow-hidden rounded-lg border border-border bg-surface-2">
        {src ? <img src={src} alt="" className="size-full object-contain" /> : <ImageIcon className="size-6 text-muted" aria-hidden="true" />}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" className="flex-1" onClick={() => ui.openAssets((url) => trait.setValue(url))}><ImageIcon /> Choose image</Button>
        <Button size="sm" disabled={busy || !src} onClick={() => void suggestAlt()}><Sparkles /> {busy ? 'Thinking…' : 'Suggest alt text'}</Button>
      </div>
      <Row label="Image URL"><input aria-label="Image URL" className={inputCls} value={src.startsWith('data:') ? '(embedded image)' : src} onChange={(e) => trait.setValue(e.target.value)} placeholder="https://…" /></Row>
    </div>
  );
}

/* ---------- video (legacy: Video settings; domain allow-list) ---------- */
export function VideoTrait({ trait }: TraitProps) {
  const v = val<{ url: string; title: string }>(trait, { url: '', title: 'Video' });
  const parsed = parseVideoUrl(v.url);
  return (
    <div className="flex flex-col gap-2.5">
      <Row label="Video URL"><input aria-label="Video URL" aria-invalid={!parsed || undefined} className={inputCls} value={v.url} onChange={(e) => trait.setValue({ ...live(trait, v), url: e.target.value })} placeholder="https://www.youtube.com/watch?v=…" /></Row>
      <p role="status" className={parsed ? 'text-[0.75rem] text-ok' : 'text-[0.75rem] text-danger'}>{parsed ? `${parsed.kind === 'mp4' ? 'MP4 file' : parsed.kind === 'youtube' ? 'YouTube' : 'Vimeo'} video` : 'Only YouTube, Vimeo and https .mp4 links are allowed.'}</p>
      <Row label="Title"><input aria-label="Video title" className={inputCls} value={v.title} onChange={(e) => trait.setValue({ ...live(trait, v), title: e.target.value })} /></Row>
    </div>
  );
}

/* ---------- countdown (legacy: Countdown / Evergreen / Minute timer settings) ---------- */
const toLocal = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
export function CountdownTrait({ trait }: TraitProps) {
  const v = val<Record<string, unknown>>(trait, { mode: 'evergreen', minutes: 30 });
  const set = (n: Record<string, unknown>) => trait.setValue({ ...live(trait, v), ...n });
  const issues = (() => { const r = CountdownPropsSchema.safeParse(v); return r.success ? [] : r.error.issues.map((i) => i.message); })();
  return (
    <div className="flex flex-col gap-2.5">
      <Row label="Type"><Select size="sm" aria-label="Countdown type" value={String(v.mode)} options={[{ value: 'evergreen', label: 'Evergreen (per visitor)' }, { value: 'fixed', label: 'Fixed date' }]} onValueChange={(mode) => set({ mode, ...(mode === 'fixed' && !v.endsAt ? { endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 19) + 'Z' } : {}) })} /></Row>
      {v.mode === 'fixed' ? <Row label="Ends at"><input type="datetime-local" aria-label="Ends at" className={inputCls} value={toLocal(String(v.endsAt ?? ''))} onChange={(e) => e.target.value && set({ endsAt: new Date(e.target.value).toISOString() })} /></Row> : <Row label="Minutes"><input type="number" min={1} aria-label="Minutes" className={inputCls} value={Number(v.minutes ?? 30)} onChange={(e) => set({ minutes: Math.max(1, Math.round(Number(e.target.value) || 1)) })} /></Row>}
      <Row label="Label"><input aria-label="Countdown label" className={inputCls} value={String(v.label ?? '')} onChange={(e) => set({ label: e.target.value })} /></Row>
      <Row label="When over"><input aria-label="Text when expired" className={inputCls} value={String(v.expiredText ?? '')} onChange={(e) => set({ expiredText: e.target.value })} /></Row>
      <Issues issues={issues} />
    </div>
  );
}

export function ProgressTrait({ trait }: TraitProps) {
  const v = val<{ value: number; label?: string }>(trait, { value: 50 });
  return (
    <div className="flex flex-col gap-2.5">
      <Row label={`Value ${v.value}%`}><Slider min={0} max={100} step={1} value={[v.value]} aria-label="Progress value" onValueChange={([n]) => trait.setValue({ ...live(trait, v), value: n })} /></Row>
      <Row label="Label"><input aria-label="Progress label" className={inputCls} value={v.label ?? ''} onChange={(e) => trait.setValue({ ...live(trait, v), label: e.target.value })} /></Row>
    </div>
  );
}

/* ---------- success action shared by forms and checkouts ---------- */
function SuccessEditor({ value, onChange }: { value: { type: string; url?: string; message?: string }; onChange: (v: Record<string, unknown>) => void }) {
  return (
    <>
      <Row label="After success"><Select size="sm" aria-label="After success" value={value.type} options={[{ value: 'next_step', label: 'Go to the next step' }, { value: 'url', label: 'Go to a web address' }, { value: 'message', label: 'Show a message' }]} onValueChange={(type) => onChange(type === 'url' ? { type, url: 'https://' } : type === 'message' ? { type, message: 'Thank you!' } : { type })} /></Row>
      {value.type === 'url' ? <Row label="Address"><input aria-label="Success address" className={inputCls} value={value.url ?? ''} onChange={(e) => onChange({ type: 'url', url: e.target.value })} /></Row> : null}
      {value.type === 'message' ? <Row label="Message"><input aria-label="Success message" className={inputCls} value={value.message ?? ''} onChange={(e) => onChange({ type: 'message', message: e.target.value })} /></Row> : null}
    </>
  );
}

/* ---------- form (legacy: Form settings, now real fields posted to the app's public endpoint) ---------- */
const FIELD_TYPES = [{ value: 'name', label: 'Name' }, { value: 'email', label: 'Email' }, { value: 'phone', label: 'Phone' }, { value: 'text', label: 'Text' }, { value: 'textarea', label: 'Long text' }, { value: 'select', label: 'Dropdown' }, { value: 'checkbox', label: 'Checkbox' }];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30) || 'field';
export function FormTrait({ trait }: TraitProps) {
  const f = val<FormProps>(trait, { name: 'Form', fields: [], submitLabel: 'Submit', consent: { enabled: false, text: '' }, success: { type: 'next_step' } });
  const set = (n: Partial<FormProps>) => trait.setValue({ ...live(trait, f), ...n });
  const setField = (i: number, n: Record<string, unknown>) => set({ fields: live(trait, f).fields.map((x, k) => (k === i ? { ...x, ...n } : x)) as FormProps['fields'] });
  const move = (i: number, d: -1 | 1) => { const a = [...live(trait, f).fields]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; set({ fields: a }); };
  const parsed = FormPropsSchema.safeParse(f);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  return (
    <div className="flex flex-col gap-3">
      <Row label="Form name"><input aria-label="Form name" className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} /></Row>
      <div className="flex flex-col gap-2" role="list" aria-label="Form fields">
        {f.fields.map((x, i) => (
          <div key={`${x.id}-${i}`} role="listitem" className="rounded-lg border border-border bg-surface-2/50 p-2">
            <div className="flex items-center gap-1.5">
              <Select size="sm" className="w-28" aria-label={`Field ${i + 1} type`} value={x.type} options={FIELD_TYPES} onValueChange={(type) => setField(i, { type, ...(type === 'select' && !x.options?.length ? { options: ['Option 1', 'Option 2'] } : {}) })} />
              <input aria-label={`Field ${i + 1} label`} className={inputCls} value={x.label} onChange={(e) => setField(i, { label: e.target.value })} />
              <Button variant="ghost" size="icon-sm" aria-label="Move field up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Move field down" disabled={i === f.fields.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove field ${x.label}`} disabled={f.fields.length <= 1} onClick={() => set({ fields: live(trait, f).fields.filter((_, k) => k !== i) })}><Trash2 /></Button>
            </div>
            <div className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-2">
              <input aria-label={`Field ${i + 1} placeholder`} className={inputCls} placeholder="Placeholder (optional)" value={x.placeholder ?? ''} onChange={(e) => setField(i, { placeholder: e.target.value || undefined })} />
              <Check id={`req-${i}`} label="Required" checked={!!x.required} onChange={(required) => setField(i, { required })} />
            </div>
            {x.type === 'select' ? <Textarea aria-label={`Field ${i + 1} options, one per line`} className="mt-1.5 min-h-16 text-[0.8rem]" value={(x.options ?? []).join('\n')} onChange={(e) => setField(i, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} placeholder="One option per line" /> : null}
          </div>
        ))}
        <Button size="sm" disabled={f.fields.length >= 20} onClick={() => { const label = `Field ${f.fields.length + 1}`; let id = slug(label); while (f.fields.some((x) => x.id === id)) id += '_'; set({ fields: [...f.fields, { id, type: 'text', label, required: false }] }); }}><Plus /> Add field</Button>
      </div>
      <Row label="Button text"><input aria-label="Submit button text" className={inputCls} value={f.submitLabel} onChange={(e) => set({ submitLabel: e.target.value })} /></Row>
      <Check id="consent" label="Ask for consent" checked={!!f.consent?.enabled} onChange={(enabled) => set({ consent: { enabled, text: f.consent?.text ?? 'I agree to be contacted.' } })} />
      {f.consent?.enabled ? <Row label="Consent text"><input aria-label="Consent text" className={inputCls} value={f.consent.text} onChange={(e) => set({ consent: { enabled: true, text: e.target.value } })} /></Row> : null}
      <SuccessEditor value={f.success as never} onChange={(success) => set({ success: success as FormProps['success'] })} />
      <p className="rounded-md bg-surface-2 p-2 text-[0.72rem] text-muted">Submissions go to the app’s public form endpoint (spam trap and rate limit included) and create leads. The fields are stored on the server when you save.</p>
      <Issues issues={issues} />
    </div>
  );
}

/* ---------- checkout (legacy: Checkout settings, order bump, one-click upsell) ---------- */
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NZD', 'INR'].map((c) => ({ value: c, label: c }));
export function ProductTrait({ trait }: TraitProps) {
  const p = val<ProductProps>(trait, { productName: '', price: 0, currency: 'USD', buttonLabel: 'Buy now', orderBump: false, oneClickUpsell: false, success: { type: 'next_step' } });
  const set = (n: Partial<ProductProps>) => trait.setValue({ ...live(trait, p), ...n });
  const role = p.orderBump ? 'bump' : p.oneClickUpsell ? 'upsell' : 'main';
  const parsed = ProductPropsSchema.safeParse(p);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  return (
    <div className="flex flex-col gap-2.5">
      <Row label="Role"><Select size="sm" aria-label="Role of this offer" value={role} options={[{ value: 'main', label: 'Main offer' }, { value: 'bump', label: 'Order bump (added to the main offer)' }, { value: 'upsell', label: 'One-click upsell' }]} onValueChange={(v) => set({ orderBump: v === 'bump', oneClickUpsell: v === 'upsell' })} /></Row>
      <Row label="Product"><input aria-label="Product name" className={inputCls} value={p.productName} onChange={(e) => set({ productName: e.target.value })} /></Row>
      <Row label="Description"><input aria-label="Product description" className={inputCls} value={p.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} /></Row>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <Row label="Price"><input type="number" min={0} step="0.01" aria-label="Price" className={inputCls} value={p.price} onChange={(e) => set({ price: Math.max(0, Number(e.target.value) || 0) })} /></Row>
        <Select size="sm" aria-label="Currency" value={p.currency} options={CURRENCIES} onValueChange={(currency) => set({ currency })} />
      </div>
      {role !== 'bump' ? <Row label="Button text"><input aria-label="Buy button text" className={inputCls} value={p.buttonLabel} onChange={(e) => set({ buttonLabel: e.target.value })} /></Row> : null}
      {role !== 'bump' ? <SuccessEditor value={p.success as never} onChange={(success) => set({ success: success as ProductProps['success'] })} /> : null}
      <p className="rounded-md bg-surface-2 p-2 text-[0.72rem] text-muted">{CheckoutSchemaHint}</p>
      <Issues issues={issues} />
    </div>
  );
}

/* ---------- custom code (legacy: Custom code block) ---------- */
export function CodeTrait({ trait }: TraitProps) {
  const { env } = useBuilder();
  const c = val<{ html: string; css: string; js: string }>(trait, { html: '', css: '', js: '' });
  if (!env.canScripts) {
    return <p className="rounded-md bg-warn-soft p-2.5 text-[0.8rem] text-warn">Scripts and raw HTML are only for workspace owners with “custom scripts” enabled in Settings. Anyone can see this block; saving removes scripts you did not write.</p>;
  }
  const area = (key: 'html' | 'css' | 'js', label: string) => (
    <Field label={label}><Textarea aria-label={label} spellCheck={false} className="min-h-24 font-mono text-[0.78rem]" value={c[key]} onChange={(e) => trait.setValue({ ...live(trait, c), [key]: e.target.value })} /></Field>
  );
  return (
    <div className="flex flex-col gap-2.5">
      {area('html', 'HTML')}
      {area('css', 'CSS')}
      {area('js', 'JavaScript')}
      <p className="rounded-md bg-warn-soft p-2 text-[0.72rem] text-warn">Runs on the published page only, never in this editor. Published pages live on separate hosts, so scripts cannot reach your account.</p>
    </div>
  );
}

/* ---------- FAQ / tabs / list item management ---------- */
const textNode = (t: string) => ({ type: 'textnode', content: t });
export function FaqTrait({ component }: TraitProps) {
  const items = component.components().models;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.78rem] text-muted">Click a question or answer on the page to edit it.</p>
      {items.map((it, i) => (
        <div key={it.cid} className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/50 px-2 py-1">
          <span className="min-w-0 flex-1 truncate text-[0.8rem]">{it.components().models[0]?.getEl()?.textContent || `Question ${i + 1}`}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => it.move(component, { at: i - 1 })}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === items.length - 1} onClick={() => it.move(component, { at: i + 2 })}><ArrowDown /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Remove question" disabled={items.length <= 1} onClick={() => it.remove()}><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" onClick={() => component.components().add({ type: 'fn-faq-item', tagName: 'details', classes: ['fn-faq-item'], components: [{ type: 'text', tagName: 'summary', components: [textNode('A new question?')] }, { type: 'text', tagName: 'div', components: [textNode('Your answer.')] }] } as never)}><Plus /> Add question</Button>
    </div>
  );
}

export function TabsTrait({ component, editor }: TraitProps) {
  const nav = component.components().models.find((c) => c.get('type') === 'fn-tab-nav');
  const panels = component.components().models.filter((c) => c.get('type') === 'fn-tab-panel');
  const buttons = nav?.components().models ?? [];
  const activate = (i: number) => buttons[i] && editor.trigger('fn:tab-activate', buttons[i]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.78rem] text-muted">Click a tab on the page to edit its label and content. The tab that is open when you save opens first.</p>
      {buttons.map((b, i) => (
        <div key={b.cid} className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2/50 px-2 py-1">
          <button type="button" className="min-w-0 flex-1 truncate text-left text-[0.8rem]" onClick={() => activate(i)}>{b.getEl()?.textContent || `Tab ${i + 1}`}</button>
          <Button variant="ghost" size="icon-sm" aria-label="Remove tab" disabled={buttons.length <= 1} onClick={() => { panels[i]?.remove(); b.remove(); }}><Trash2 /></Button>
        </div>
      ))}
      <Button size="sm" disabled={buttons.length >= 8} onClick={() => { nav?.components().add({ type: 'fn-tab-btn', tagName: 'button', classes: ['fn-tab-btn'], attributes: { type: 'button' }, components: [textNode(`Tab ${buttons.length + 1}`)] } as never); component.components().add({ type: 'fn-tab-panel', tagName: 'div', classes: ['fn-tab-panel'], attributes: { hidden: '' }, components: [{ type: 'fn-text', tagName: 'p', classes: [], components: [textNode('Tab content.')] }] } as never); }}><Plus /> Add tab</Button>
    </div>
  );
}

export function ListTrait({ component }: TraitProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[0.78rem] text-muted">Click an item on the page to edit it.</p>
      <div className="flex gap-1.5">
        <Button size="sm" className="flex-1" onClick={() => component.components().add({ type: 'text', tagName: 'li', components: [textNode('New item')] } as never)}><Plus /> Add item</Button>
        <Button size="sm" disabled={component.components().length <= 1} onClick={() => component.components().at(component.components().length - 1)?.remove()}><Trash2 /> Remove last</Button>
      </div>
    </div>
  );
}

export function PopupTrait({ component }: TraitProps) {
  return <p className="text-[0.78rem] text-muted">This popup is hidden on the published page. Give a button the action “Open a popup” and pick <code className="font-mono">{String(component.getAttributes().id ?? '')}</code> to open it. Visitors close it with the × button, Escape or a click outside.</p>;
}

export const TRAIT_EDITORS: Record<string, (p: TraitProps) => ReactNode> = {
  'fn-action': (p) => <ActionTrait {...p} />, 'fn-asset': (p) => <AssetTrait {...p} />, 'fn-video': (p) => <VideoTrait {...p} />, 'fn-countdown': (p) => <CountdownTrait {...p} />,
  'fn-progress': (p) => <ProgressTrait {...p} />, 'fn-form': (p) => <FormTrait {...p} />, 'fn-product': (p) => <ProductTrait {...p} />, 'fn-code': (p) => <CodeTrait {...p} />,
  'fn-faq-items': (p) => <FaqTrait {...p} />, 'fn-tabs-items': (p) => <TabsTrait {...p} />, 'fn-list-items': (p) => <ListTrait {...p} />, 'fn-popup-open': (p) => <PopupTrait {...p} />,
};
export { randomId, VideoPropsSchema, Input };
