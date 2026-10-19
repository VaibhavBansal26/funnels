import { parseVideoUrl, type Block, type FormField } from '@blocks';
import type { ReactNode } from 'react';
import { Field } from '../components/ui';
import { blockErrors } from './validate';

export interface StepOption {
  id: string;
  name: string;
}

export interface InspectorProps {
  block: Block;
  steps: StepOption[];
  onChange: (patch: Record<string, unknown>, coalesceKey?: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (delta: -1 | 1) => void;
  onMoveOut: () => void;
  onMoveIntoPrevious: () => void;
  onAddColumn: () => void;
  onRemoveColumn: (slot: number) => void;
  onSaveCustom?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  canMoveOut?: boolean;
  canMoveIn?: boolean;
  /** Slot for AI helpers (rewrite, headline variants, alt text). */
  aiSlot?: ReactNode;
}

export const BLOCK_LABELS: Record<Block['type'], string> = {
  section: 'Section', columns: 'Columns', heading: 'Heading', paragraph: 'Paragraph', image: 'Image', button: 'Button', video: 'Video', divider: 'Divider', spacer: 'Spacer',
  list: 'Bullet list', faq: 'FAQ accordion', countdown: 'Countdown', form: 'Opt-in form', checkout: 'Checkout / offer', html: 'Custom HTML',
};

/** ISO instant <-> value of <input type="datetime-local"> in the viewer's zone. */
export const toLocalInput = (iso: string | undefined): string => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): string | undefined => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};

type Errs = Record<string, string>;

function Txt({ label, value, onChange, error, hint, type = 'text', ...rest }: { label: string; value: string | number | undefined; onChange: (v: string) => void; error?: string; hint?: string; type?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <Field label={label} error={error} hint={hint}>{(p) => <input className="input" type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...p} {...rest} />}</Field>;
}
function Area({ label, value, onChange, error, hint, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; rows?: number }) {
  return <Field label={label} error={error} hint={hint}>{(p) => <textarea className="input" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} {...p} />}</Field>;
}
function Sel<T extends string>({ label, value, options, onChange, error }: { label: string; value: T | undefined; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; error?: string }) {
  return <Field label={label} error={error}>{(p) => <select className="input" value={value ?? options[0]![0]} onChange={(e) => onChange(e.target.value as T)} {...p}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>;
}
function Chk({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="check" style={{ marginBottom: 8 }}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}
function Color({ label, value, onChange, error }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; error?: string }) {
  return (
    <Field label={label} error={error} hint="Hex (#2563eb) or a color name">
      {(p) => (
        <span className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} {...p} />
          <input type="color" aria-label={`${label} picker`} value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#000000'} onChange={(e) => onChange(e.target.value)} style={{ width: 40, height: 36, padding: 0, border: 'none', background: 'none' }} />
        </span>
      )}
    </Field>
  );
}

const ALIGN = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] as const;

function ActionEditor({ value, onChange, steps, label }: { value: { type: string; stepId?: string; url?: string; newTab?: boolean; anchor?: string; message?: string }; onChange: (v: Record<string, unknown>) => void; steps: StepOption[]; label: string }) {
  const t = value.type;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <Sel
        label={label}
        value={t}
        options={[['next_step', 'Go to next step'], ['step', 'Go to a specific step'], ['link', 'Open external link'], ['anchor', 'Scroll to anchor']] as const}
        onChange={(v) => onChange(v === 'next_step' ? { type: v } : v === 'step' ? { type: v, stepId: steps[0]?.id ?? '' } : v === 'link' ? { type: v, url: 'https://' } : { type: v, anchor: '' })}
      />
      {t === 'step' ? <Sel label="Target step" value={value.stepId} options={steps.map((s) => [s.id, s.name] as const)} onChange={(stepId) => onChange({ type: 'step', stepId })} /> : null}
      {t === 'link' ? <><Txt label="URL" value={value.url} onChange={(url) => onChange({ ...value, url })} /><Chk label="Open in a new tab" checked={!!value.newTab} onChange={(newTab) => onChange({ ...value, newTab })} /></> : null}
      {t === 'anchor' ? <Txt label="Anchor name" value={value.anchor} hint="Set the same name in another block's Anchor field" onChange={(anchor) => onChange({ type: 'anchor', anchor })} /> : null}
    </fieldset>
  );
}

function SuccessEditor({ value, onChange }: { value: { type: string; url?: string; message?: string }; onChange: (v: Record<string, unknown>) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <Sel label="After success" value={value.type} options={[['next_step', 'Go to next step'], ['url', 'Redirect to a URL'], ['message', 'Show a message']] as const}
        onChange={(v) => onChange(v === 'next_step' ? { type: v } : v === 'url' ? { type: v, url: 'https://' } : { type: v, message: 'Thank you!' })} />
      {value.type === 'url' ? <Txt label="Redirect URL" value={value.url} onChange={(url) => onChange({ type: 'url', url })} /> : null}
      {value.type === 'message' ? <Txt label="Message" value={value.message} onChange={(message) => onChange({ type: 'message', message })} /> : null}
    </fieldset>
  );
}

function FormFields({ fields, onChange, errors }: { fields: FormField[]; onChange: (f: FormField[]) => void; errors: Errs }) {
  const set = (i: number, patch: Partial<FormField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => {
    const to = i + d;
    if (to < 0 || to >= fields.length) return;
    const next = [...fields];
    [next[i], next[to]] = [next[to]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="stack" role="group" aria-label="Form fields">
      {fields.map((f, i) => (
        <div key={i} className="card" style={{ padding: 10 }}>
          <div className="row between"><strong className="small">Field {i + 1}</strong>
            <span className="row" style={{ gap: 2 }}>
              <button type="button" className="btn sm icon" aria-label={`Move field ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="btn sm icon" aria-label={`Move field ${i + 1} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="btn sm icon danger" aria-label={`Remove field ${i + 1}`} disabled={fields.length <= 1} onClick={() => onChange(fields.filter((_, j) => j !== i))}>×</button>
            </span></div>
          <Txt label="Label" value={f.label} error={errors[`fields.${i}.label`]} onChange={(label) => set(i, { label })} />
          <Txt label="Field id" value={f.id} error={errors[`fields.${i}.id`]} hint="Lowercase letters, digits and _" onChange={(id) => set(i, { id })} />
          <Sel label="Type" value={f.type} options={[['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['text', 'Text'], ['textarea', 'Long text'], ['select', 'Dropdown'], ['checkbox', 'Checkbox']] as const} onChange={(type) => set(i, { type })} />
          <Chk label="Required" checked={f.required} onChange={(required) => set(i, { required })} />
          {f.type === 'select' ? <Area label="Options (one per line)" rows={3} value={(f.options ?? []).join('\n')} error={errors[`fields.${i}.options`]} onChange={(v) => set(i, { options: v.split('\n').map((x) => x.trim()).filter(Boolean) })} /> : null}
          {f.type !== 'checkbox' && f.type !== 'select' ? <Txt label="Placeholder" value={f.placeholder ?? ''} onChange={(placeholder) => set(i, { placeholder: placeholder || undefined })} /> : null}
        </div>
      ))}
      {fields.length < 20 ? <button type="button" className="btn sm" onClick={() => onChange([...fields, { id: `field${fields.length + 1}`, type: 'text', label: 'New field', required: false }])}>Add field</button> : null}
    </div>
  );
}

export function Inspector(p: InspectorProps) {
  const { block: b } = p;
  const errors = blockErrors(b);
  const set = (patch: Record<string, unknown>) => p.onChange(patch, `${b.id}:${Object.keys(patch).join(',')}`);
  const e = (k: string) => errors[k];
  const generic = Object.entries(errors).filter(([k]) => !/^(fields\.\d+\.(id|label|options)|text|src|url|price|currency|productName|endsAt|minutes|background|color|html)$/.test(k) && !k.startsWith('action') && !k.startsWith('success'));

  return (
    <div className="inspector" aria-label={`${BLOCK_LABELS[b.type]} settings`}>
      <h2 style={{ fontSize: '1rem' }}>{BLOCK_LABELS[b.type]}</h2>
      <div className="toolbar" role="toolbar" aria-label="Block actions">
        <button type="button" className="btn sm" onClick={() => p.onMove(-1)} disabled={!p.canMoveUp} aria-label="Move block up">↑ Up</button>
        <button type="button" className="btn sm" onClick={() => p.onMove(1)} disabled={!p.canMoveDown} aria-label="Move block down">↓ Down</button>
        <button type="button" className="btn sm" onClick={p.onMoveOut} disabled={!p.canMoveOut} aria-label="Move block out of its container">Out</button>
        <button type="button" className="btn sm" onClick={p.onMoveIntoPrevious} disabled={!p.canMoveIn} aria-label="Move block into the previous container">Into</button>
        <button type="button" className="btn sm" onClick={p.onDuplicate}>Duplicate</button>
        {p.onSaveCustom ? <button type="button" className="btn sm" onClick={p.onSaveCustom}>Save as my block</button> : null}
        <button type="button" className="btn sm danger" onClick={p.onRemove}>Delete</button>
      </div>

      {b.type === 'heading' ? (
        <>
          <Txt label="Text" value={b.text} error={e('text')} onChange={(text) => set({ text })} />
          {p.aiSlot}
          <Sel label="Level" value={String(b.level) as '1'} options={[['1', 'H1 (page title)'], ['2', 'H2'], ['3', 'H3'], ['4', 'H4']] as const} onChange={(v) => set({ level: Number(v) })} />
          <Sel label="Alignment" value={b.align ?? 'left'} options={ALIGN} onChange={(align) => set({ align })} />
          <Color label="Color" value={b.color} error={e('color')} onChange={(color) => set({ color })} />
          <Txt label="Anchor" value={b.anchor ?? ''} error={e('anchor')} hint="Lets buttons scroll here" onChange={(anchor) => set({ anchor: anchor || undefined })} />
        </>
      ) : null}

      {b.type === 'paragraph' ? (
        <>
          <Area label="Text" rows={6} value={b.text} error={e('text')} hint="Use **bold**, *italic* and [link](https://…)" onChange={(text) => set({ text })} />
          {p.aiSlot}
          <Sel label="Alignment" value={b.align ?? 'left'} options={ALIGN} onChange={(align) => set({ align })} />
          <Color label="Color" value={b.color} error={e('color')} onChange={(color) => set({ color })} />
          <Txt label="Anchor" value={b.anchor ?? ''} error={e('anchor')} onChange={(anchor) => set({ anchor: anchor || undefined })} />
        </>
      ) : null}

      {b.type === 'image' ? (
        <>
          <Txt label="Image URL" value={b.src} error={e('src')} onChange={(src) => set({ src })} />
          <Txt label="Alt text" value={b.alt} hint="Describe the image for screen readers" onChange={(alt) => set({ alt })} />
          {p.aiSlot}
          <Txt label="Width (px)" type="number" value={b.width ?? ''} error={e('width')} onChange={(v) => set({ width: v ? Number(v) : undefined })} />
          <Sel label="Alignment" value={b.align ?? 'left'} options={ALIGN} onChange={(align) => set({ align })} />
          <Txt label="Link (optional)" value={b.href ?? ''} error={e('href')} onChange={(href) => set({ href: href || undefined })} />
        </>
      ) : null}

      {b.type === 'button' ? (
        <>
          <Txt label="Label" value={b.text} error={e('text')} onChange={(text) => set({ text })} />
          <ActionEditor label="Action" value={b.action} steps={p.steps} onChange={(action) => set({ action })} />
          {e('action.url') ? <span className="error small" role="alert">{e('action.url')}</span> : null}
          <Sel label="Style" value={b.style} options={[['primary', 'Primary'], ['secondary', 'Secondary'], ['outline', 'Outline']] as const} onChange={(style) => set({ style })} />
          <Sel label="Size" value={b.size} options={[['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] as const} onChange={(size) => set({ size })} />
          <Sel label="Alignment" value={b.align ?? 'left'} options={ALIGN} onChange={(align) => set({ align })} />
          <Chk label="Full width" checked={!!b.fullWidth} onChange={(fullWidth) => set({ fullWidth })} />
        </>
      ) : null}

      {b.type === 'video' ? (
        <>
          <Txt label="Video URL" value={b.url} error={e('url')} hint="YouTube, Vimeo or a direct https .mp4 link" onChange={(url) => set({ url })} />
          {parseVideoUrl(b.url) ? <p className="small muted">Detected: {parseVideoUrl(b.url)!.kind}</p> : null}
          <Txt label="Title (for screen readers)" value={b.title} onChange={(title) => set({ title })} />
        </>
      ) : null}

      {b.type === 'spacer' ? <Txt label="Height (px)" type="number" value={b.height} error={e('height')} onChange={(v) => set({ height: Number(v) })} /> : null}
      {b.type === 'divider' ? <p className="muted small">A thin horizontal line. Nothing to configure.</p> : null}

      {b.type === 'list' ? (
        <>
          <Area label="Items (one per line)" rows={6} value={b.items.join('\n')} onChange={(v) => set({ items: v.split('\n') })} />
          <Chk label="Numbered list" checked={!!b.ordered} onChange={(ordered) => set({ ordered })} />
          {!b.ordered ? <Sel label="Bullet style" value={b.icon} options={[['check', 'Check marks'], ['dot', 'Dots']] as const} onChange={(icon) => set({ icon })} /> : null}
        </>
      ) : null}

      {b.type === 'faq' ? (
        <div className="stack" role="group" aria-label="Questions">
          {b.items.map((it, i) => (
            <div key={i} className="card" style={{ padding: 10 }}>
              <Txt label={`Question ${i + 1}`} value={it.q} onChange={(q) => set({ items: b.items.map((x, j) => (j === i ? { ...x, q } : x)) })} />
              <Area label="Answer" rows={3} value={it.a} onChange={(a) => set({ items: b.items.map((x, j) => (j === i ? { ...x, a } : x)) })} />
              <button type="button" className="btn sm danger" onClick={() => set({ items: b.items.filter((_, j) => j !== i) })}>Remove question {i + 1}</button>
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => set({ items: [...b.items, { q: 'New question?', a: 'Answer.' }] })}>Add question</button>
        </div>
      ) : null}

      {b.type === 'countdown' ? (
        <>
          <Sel label="Type" value={b.mode} options={[['evergreen', 'Evergreen (starts when a visitor arrives)'], ['fixed', 'Fixed end date']] as const} onChange={(mode) => set(mode === 'fixed' ? { mode, endsAt: b.endsAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString() } : { mode, minutes: b.minutes ?? 30 })} />
          {b.mode === 'fixed' ? <Txt label="Ends at" type="datetime-local" value={toLocalInput(b.endsAt)} error={e('endsAt')} onChange={(v) => set({ endsAt: fromLocalInput(v) })} /> : <Txt label="Duration (minutes)" type="number" value={b.minutes ?? ''} error={e('minutes')} onChange={(v) => set({ minutes: v ? Number(v) : undefined })} />}
          <Txt label="Label" value={b.label ?? ''} onChange={(label) => set({ label: label || undefined })} />
          <Txt label="Text when finished" value={b.expiredText} onChange={(expiredText) => set({ expiredText })} />
        </>
      ) : null}

      {b.type === 'form' ? (
        <>
          <Txt label="Form name" value={b.name} onChange={(name) => set({ name })} />
          <Txt label="Button label" value={b.submitLabel} onChange={(submitLabel) => set({ submitLabel })} />
          <FormFields fields={b.fields} errors={errors} onChange={(fields) => set({ fields })} />
          {e('fields') ? <span className="error small" role="alert">{e('fields')}</span> : null}
          <Chk label="Require consent checkbox" checked={b.consent.enabled} onChange={(enabled) => set({ consent: { ...b.consent, enabled } })} />
          {b.consent.enabled ? <Txt label="Consent text" value={b.consent.text} onChange={(text) => set({ consent: { ...b.consent, text } })} /> : null}
          <SuccessEditor value={b.success} onChange={(success) => set({ success })} />
        </>
      ) : null}

      {b.type === 'checkout' ? (
        <>
          <Txt label="Product name" value={b.productName} error={e('productName')} onChange={(productName) => set({ productName })} />
          <Area label="Description" rows={3} value={b.description ?? ''} onChange={(description) => set({ description: description || undefined })} />
          <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'start' }}>
            <Txt label="Price" type="number" step="0.01" min={0} value={b.price} error={e('price')} onChange={(v) => set({ price: Number(v) })} />
            <Txt label="Currency" value={b.currency} error={e('currency')} hint="3-letter code" onChange={(v) => set({ currency: v.toUpperCase() })} />
          </div>
          <Txt label="Button label" value={b.buttonLabel} onChange={(buttonLabel) => set({ buttonLabel })} />
          <Chk label="Order bump (add-on checkbox for the main offer)" checked={b.orderBump} onChange={(orderBump) => set(orderBump ? { orderBump, oneClickUpsell: false } : { orderBump })} />
          <Chk label="One-click upsell (charges the previous order's payment method)" checked={b.oneClickUpsell} onChange={(oneClickUpsell) => set(oneClickUpsell ? { oneClickUpsell, orderBump: false } : { oneClickUpsell })} />
          {!b.orderBump ? <SuccessEditor value={b.success} onChange={(success) => set({ success })} /> : null}
          <p className="muted small">Payments use the built-in test provider: no real money moves.</p>
        </>
      ) : null}

      {b.type === 'html' ? (
        <>
          <Area label="HTML" rows={10} value={b.html} error={e('html')} hint="Scripts and event handlers are removed unless the workspace owner enables custom scripts and saves this page." onChange={(html) => set({ html })} />
        </>
      ) : null}

      {b.type === 'section' ? (
        <>
          <Color label="Background" value={b.background} error={e('background')} onChange={(background) => set({ background })} />
          <Sel label="Padding" value={b.padding} options={[['none', 'None'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Extra large']] as const} onChange={(padding) => set({ padding })} />
          <Sel label="Content width" value={b.width} options={[['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide'], ['full', 'Full']] as const} onChange={(width) => set({ width })} />
          <Sel label="Text alignment" value={b.align} options={[['left', 'Left'], ['center', 'Center']] as const} onChange={(align) => set({ align })} />
          <Txt label="Anchor" value={b.anchor ?? ''} error={e('anchor')} onChange={(anchor) => set({ anchor: anchor || undefined })} />
        </>
      ) : null}

      {b.type === 'columns' ? (
        <>
          <Sel label="Gap" value={b.gap} options={[['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']] as const} onChange={(gap) => set({ gap })} />
          <p className="small">{b.columns.length} column{b.columns.length === 1 ? '' : 's'} (1 to 5)</p>
          <div className="row">
            <button type="button" className="btn sm" disabled={b.columns.length >= 5} onClick={p.onAddColumn}>Add column</button>
            {b.columns.map((_, i) => <button key={i} type="button" className="btn sm" disabled={b.columns.length <= 1} onClick={() => p.onRemoveColumn(i)} aria-label={`Remove column ${i + 1}`}>Remove column {i + 1}</button>)}
          </div>
        </>
      ) : null}

      {generic.length ? (
        <div className="alert error" role="alert">
          <strong>Fix before saving</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{generic.map(([k, m]) => <li key={k}>{k ? `${k}: ` : ''}{m}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
