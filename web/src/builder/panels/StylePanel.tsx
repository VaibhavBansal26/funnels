// Adapted from the legacy builder (see docs/PROVENANCE.md): the Style Manager sectors and their organisation (typography, background, border, corner radius, shadow,
// spacing, size, position, visibility per device) and the legacy "show-desktop-only / show-mobile-only / show-none" visibility classes.
import type { Editor } from 'grapesjs';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, ImageIcon, MousePointer2, Plus, Tag, X } from 'lucide-react';
import { useState } from 'react';
import { Button, cn, Input, Select, Tooltip } from '../../ui';
import { computedStyle, FONT_FAMILIES, GRADIENTS, readStyle, SHADOWS, writeStyle } from '../styleApi';
import { SELECTION_EVENTS, useBuilder, useEditorEvents } from '../useEditor';
import { Row, Section, Segmented } from './kit';
import { BoxModel, ColorRow, SelectRow, UnitRow, ValueInput } from './styleControls';

const STATES = [{ value: '', label: 'Normal' }, { value: 'hover', label: 'Hover' }, { value: 'active', label: 'Active' }, { value: 'focus', label: 'Focus' }] as const;

function TargetBar({ editor }: { editor: Editor }) {
  const sm = editor.Selectors;
  const [draft, setDraft] = useState('');
  const classes = sm.getSelected().filter((s) => !s.get('private'));
  const componentFirst = sm.getComponentFirst();
  const state = sm.getState();
  const device = editor.Devices.get(editor.getDevice())?.get('name') ?? 'Desktop';
  const multi = editor.getSelectedAll().length;
  const addClass = () => {
    const name = draft.trim().replace(/^\./, '').replace(/\s+/g, '-');
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) return;
    sm.addSelected(name);
    setDraft('');
  };
  const rule = (() => {
    const t = editor.StyleManager.getSelected() as unknown as { selectorsToString?: () => string; getId?: () => string } | undefined;
    if (!t) return '';
    return t.selectorsToString ? t.selectorsToString() || `#${t.getId?.() ?? ''}` : `#${t.getId?.() ?? ''}`;
  })();
  return (
    <div className="flex flex-col gap-2.5 border-b border-border bg-surface-2/50 p-3">
      <div className="flex items-center gap-1.5 text-[0.75rem] text-muted">
        <MousePointer2 className="size-3.5" aria-hidden="true" />
        <span>{multi > 1 ? `${multi} elements selected` : 'Styling'}</span>
        <span className="ml-auto rounded-full bg-surface px-2 py-0.5 font-semibold text-fg shadow-sm">{device}</span>
      </div>
      <div role="radiogroup" aria-label="What to style" className="grid grid-cols-2 gap-1 rounded-lg bg-surface-3/60 p-0.5">
        {[{ v: true, label: 'This element' }, { v: false, label: 'Class' }].map((o) => (
          <button key={String(o.v)} type="button" role="radio" aria-checked={componentFirst === o.v} onClick={() => sm.setComponentFirst(o.v)} className={cn('rounded-md py-1 text-[0.78rem] font-semibold text-muted', componentFirst === o.v && 'bg-surface text-fg shadow-sm')}>{o.label}</button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Classes">
        {classes.map((c) => (
          <span key={c.getName()} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.75rem] font-semibold', c.get('active') === false ? 'border-border text-muted line-through' : 'border-primary/40 bg-primary-soft text-primary')}>
            <button type="button" aria-pressed={c.get('active') !== false} aria-label={`${c.get('active') === false ? 'Enable' : 'Disable'} class ${c.getName()} for styling`} onClick={() => c.set('active', c.get('active') === false)}><Tag className="size-3" /></button>
            .{c.getName()}
            <button type="button" aria-label={`Remove class ${c.getName()}`} onClick={() => sm.removeSelected(c)}><X className="size-3" /></button>
          </span>
        ))}
        <form className="flex min-w-24 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); addClass(); }}>
          <Input aria-label="Add a class" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add class…" className="min-h-6 px-2 text-[0.75rem]" />
          <Tooltip label="Add class"><Button type="submit" size="icon-sm" variant="ghost" aria-label="Add class"><Plus /></Button></Tooltip>
        </form>
      </div>
      <p className="text-[0.72rem] leading-snug text-muted" aria-live="polite">
        {componentFirst || classes.length === 0 ? 'Changes apply to this element only.' : `Changes apply to every element with ${classes.filter((c) => c.get('active') !== false).map((c) => `.${c.getName()}`).join('')}.`}
        {rule ? <span className="mt-0.5 block font-mono text-[0.68rem] text-muted/80">{rule}{state ? `:${state}` : ''}</span> : null}
      </p>
      <Segmented<string> label="State" value={state ?? ''} onChange={(v) => sm.setState(v)} options={STATES.map((s) => ({ value: s.value, label: s.label, title: s.value ? `Style the ${s.label.toLowerCase()} state` : 'Normal state' }))} />
    </div>
  );
}

export function StylePanel() {
  const { editor, ui } = useBuilder();
  useEditorEvents(editor, `${SELECTION_EVENTS} device:select`);
  const sel = editor.getSelected();
  if (!sel) return null;
  const style = readStyle(editor);
  const get = (p: string) => style[p] ?? '';
  const ph = (p: string) => computedStyle(editor, p);
  const set = (p: string, v: string) => writeStyle(editor, p, v);
  const type = String(sel.get('type') ?? '');
  const texty = ['fn-heading', 'fn-text', 'fn-button', 'text', 'link', 'fn-list', 'fn-tab-btn'].includes(type) || type === 'fn-section' || type === 'fn-column' || type === 'fn-box';
  const display = get('display') || ph('display');
  const flex = display.includes('flex');
  const grid = display.includes('grid');

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="Style">
      <TargetBar editor={editor} />
      <Section title="Layout" id="layout" defaultOpen={false}>
        <SelectRow label="Display" prop="display" value={get('display')} onChange={set} placeholder={ph('display') || 'block'} options={[{ value: '', label: 'Default' }, { value: 'block', label: 'Block' }, { value: 'flex', label: 'Flex' }, { value: 'grid', label: 'Grid' }, { value: 'inline-block', label: 'Inline block' }, { value: 'inline-flex', label: 'Inline flex' }, { value: 'none', label: 'Hidden (none)' }]} />
        {flex ? (
          <>
            <Row label="Direction"><Segmented<string> label="Flex direction" value={get('flex-direction')} onChange={(v) => set('flex-direction', v)} options={[{ value: 'row', label: 'Row', title: 'Row' }, { value: 'column', label: 'Column', title: 'Column' }, { value: 'row-reverse', label: 'Row ↺', title: 'Row reversed' }, { value: 'column-reverse', label: 'Col ↺', title: 'Column reversed' }]} /></Row>
            <SelectRow label="Justify" prop="justify-content" value={get('justify-content')} onChange={set} options={[{ value: '', label: 'Default' }, ...['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'].map((v) => ({ value: v, label: v }))]} />
            <SelectRow label="Align items" prop="align-items" value={get('align-items')} onChange={set} options={[{ value: '', label: 'Default' }, ...['flex-start', 'center', 'flex-end', 'stretch', 'baseline'].map((v) => ({ value: v, label: v }))]} />
            <SelectRow label="Wrap" prop="flex-wrap" value={get('flex-wrap')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'wrap', label: 'Wrap' }, { value: 'nowrap', label: 'No wrap' }]} />
          </>
        ) : null}
        {flex || grid ? <UnitRow label="Gap" prop="gap" value={get('gap')} placeholder={ph('gap')} onChange={set} list={['0', '8px', '16px', '24px', '40px']} /> : null}
        {grid ? <UnitRow label="Columns" prop="grid-template-columns" value={get('grid-template-columns')} placeholder="repeat(3, 1fr)" onChange={set} list={['repeat(2, 1fr)', 'repeat(3, 1fr)', '1fr 2fr']} /> : null}
        <UnitRow label="Flex" prop="flex" value={get('flex')} placeholder="1 1 0" onChange={set} list={['1 1 0', '0 0 auto', '1']} />
        <UnitRow label="Order" prop="order" value={get('order')} placeholder="0" onChange={set} />
      </Section>
      <Section title="Size" id="size" defaultOpen={false}>
        <UnitRow label="Width" prop="width" value={get('width')} placeholder={ph('width')} onChange={set} list={['auto', '100%', '50%', '320px']} />
        <UnitRow label="Height" prop="height" value={get('height')} placeholder={ph('height')} onChange={set} list={['auto', '100%', '240px']} />
        <UnitRow label="Min width" prop="min-width" value={get('min-width')} onChange={set} />
        <UnitRow label="Max width" prop="max-width" value={get('max-width')} onChange={set} list={['100%', '640px', '960px']} />
        <UnitRow label="Min height" prop="min-height" value={get('min-height')} onChange={set} list={['0', '240px', '100vh']} />
        <UnitRow label="Max height" prop="max-height" value={get('max-height')} onChange={set} />
        <SelectRow label="Overflow" prop="overflow" value={get('overflow')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }, { value: 'auto', label: 'Auto' }, { value: 'scroll', label: 'Scroll' }]} />
        <UnitRow label="Aspect ratio" prop="aspect-ratio" value={get('aspect-ratio')} onChange={set} list={['16 / 9', '4 / 3', '1 / 1']} />
        <SelectRow label="Image fit" prop="object-fit" value={get('object-fit')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }, { value: 'fill', label: 'Fill' }]} />
      </Section>
      <Section title="Spacing" id="spacing">
        <BoxModel get={get} placeholder={ph} set={set} />
      </Section>
      <Section title="Typography" id="typography" defaultOpen={texty}>
        <SelectRow label="Font" prop="font-family" value={get('font-family')} onChange={set} options={FONT_FAMILIES} />
        <UnitRow label="Size" prop="font-size" value={get('font-size')} placeholder={ph('font-size')} onChange={set} list={['0.875rem', '1rem', '1.25rem', '1.5rem', '2rem', '3rem']} />
        <SelectRow label="Weight" prop="font-weight" value={get('font-weight')} onChange={set} placeholder={ph('font-weight')} options={[{ value: '', label: 'Default' }, ...[['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold']].map(([value, label]) => ({ value: value!, label: `${label} (${value})` }))]} />
        <UnitRow label="Line height" prop="line-height" value={get('line-height')} placeholder={ph('line-height')} onChange={set} list={['1', '1.2', '1.5', '1.7']} />
        <UnitRow label="Letter spacing" prop="letter-spacing" value={get('letter-spacing')} onChange={set} list={['-0.02em', '0', '0.05em', '0.12em']} />
        <ColorRow label="Text colour" prop="color" value={get('color')} onChange={set} />
        <Row label="Align"><Segmented<string> label="Text alignment" value={get('text-align')} onChange={(v) => set('text-align', v)} options={[{ value: 'left', label: <AlignLeft />, title: 'Left' }, { value: 'center', label: <AlignCenter />, title: 'Centre' }, { value: 'right', label: <AlignRight />, title: 'Right' }, { value: 'justify', label: <AlignJustify />, title: 'Justify' }]} /></Row>
        <SelectRow label="Decoration" prop="text-decoration" value={get('text-decoration')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'none', label: 'None' }, { value: 'underline', label: 'Underline' }, { value: 'line-through', label: 'Strikethrough' }]} />
        <SelectRow label="Transform" prop="text-transform" value={get('text-transform')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'none', label: 'None' }, { value: 'uppercase', label: 'UPPERCASE' }, { value: 'capitalize', label: 'Capitalize' }, { value: 'lowercase', label: 'lowercase' }]} />
      </Section>
      <Section title="Background" id="background" defaultOpen={type === 'fn-section'}>
        <ColorRow label="Colour" prop="background-color" value={get('background-color') || (get('background').startsWith('#') || get('background').startsWith('rgb') ? get('background') : '')} onChange={(p, v) => set(p, v)} />
        <Row label="Gradient"><Select size="sm" aria-label="Background gradient" value={GRADIENTS.some((g) => g.value === get('background-image')) ? get('background-image') : ''} options={GRADIENTS} onValueChange={(v) => { set('background-image', v); if (v) { set('background', ''); } }} /></Row>
        <Row label="Image">
          <div className="flex items-center gap-1.5">
            <ValueInput label="Background image (url)" value={get('background-image').startsWith('url(') ? get('background-image') : ''} placeholder="url(https://…)" onCommit={(v) => set('background-image', v)} />
            <Tooltip label="Choose an uploaded image"><Button size="icon-sm" aria-label="Choose background image" onClick={() => ui.openAssets((url) => { set('background-image', `url(${url})`); set('background-size', get('background-size') || 'cover'); set('background-position', get('background-position') || 'center'); })}><ImageIcon /></Button></Tooltip>
          </div>
        </Row>
        <SelectRow label="Size" prop="background-size" value={get('background-size')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'cover', label: 'Cover' }, { value: 'contain', label: 'Contain' }, { value: 'auto', label: 'Auto' }]} />
        <SelectRow label="Position" prop="background-position" value={get('background-position')} onChange={set} options={[{ value: '', label: 'Default' }, ...['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'].map((v) => ({ value: v, label: v }))]} />
        <SelectRow label="Repeat" prop="background-repeat" value={get('background-repeat')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'no-repeat', label: 'No repeat' }, { value: 'repeat', label: 'Repeat' }, { value: 'repeat-x', label: 'Repeat X' }, { value: 'repeat-y', label: 'Repeat Y' }]} />
        <p className="text-[0.72rem] text-muted">Dark backgrounds are detected: switch the section’s colour theme in Settings so text stays readable.</p>
      </Section>
      <Section title="Border" id="border" defaultOpen={false}>
        <UnitRow label="Width" prop="border-width" value={get('border-width')} onChange={set} list={['0', '1px', '2px', '4px']} />
        <SelectRow label="Style" prop="border-style" value={get('border-style')} onChange={set} options={[{ value: '', label: 'Default' }, ...['none', 'solid', 'dashed', 'dotted', 'double'].map((v) => ({ value: v, label: v }))]} />
        <ColorRow label="Colour" prop="border-color" value={get('border-color')} onChange={set} />
        <UnitRow label="Radius" prop="border-radius" value={get('border-radius')} placeholder={ph('border-radius')} onChange={set} list={['0', '4px', '8px', '12px', '16px', '999px']} />
        <div className="grid grid-cols-4 gap-1.5">
          {(['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const).map((c) => (
            <ValueInput key={c} label={`Radius ${c}`} value={get(`border-${c}-radius`)} placeholder={c.split('-').map((w) => w[0]).join('')} onCommit={(v) => set(`border-${c}-radius`, v)} className="px-1 text-center" />
          ))}
        </div>
      </Section>
      <Section title="Effects" id="effects" defaultOpen={false}>
        <Row label="Shadow"><Select size="sm" aria-label="Box shadow preset" value={SHADOWS.some((s) => s.value === get('box-shadow')) ? get('box-shadow') : get('box-shadow') ? '__custom' : ''} options={[...SHADOWS, ...(get('box-shadow') && !SHADOWS.some((s) => s.value === get('box-shadow')) ? [{ value: '__custom', label: 'Custom' }] : [])]} onValueChange={(v) => v !== '__custom' && set('box-shadow', v)} /></Row>
        <UnitRow label="Custom shadow" prop="box-shadow" value={get('box-shadow')} placeholder="0 4px 12px rgb(0 0 0 / .15)" onChange={set} />
        <UnitRow label="Opacity" prop="opacity" value={get('opacity')} placeholder="1" onChange={set} list={['1', '0.8', '0.5', '0']} />
        <UnitRow label="Transition" prop="transition" value={get('transition')} placeholder="all .2s ease" onChange={set} list={['all .2s ease', 'transform .2s ease', 'opacity .3s ease']} />
        <UnitRow label="Transform" prop="transform" value={get('transform')} placeholder="rotate(0deg)" onChange={set} list={['scale(1.05)', 'rotate(-2deg)', 'translateY(-2px)']} />
        <SelectRow label="Cursor" prop="cursor" value={get('cursor')} onChange={set} options={[{ value: '', label: 'Default' }, { value: 'pointer', label: 'Pointer' }, { value: 'default', label: 'Arrow' }, { value: 'not-allowed', label: 'Not allowed' }]} />
      </Section>
      <Section title="Position" id="position" defaultOpen={false}>
        <SelectRow label="Position" prop="position" value={get('position')} onChange={set} options={[{ value: '', label: 'Default (static)' }, ...['relative', 'absolute', 'fixed', 'sticky'].map((v) => ({ value: v, label: v }))]} />
        <div className="grid grid-cols-2 gap-1.5">
          {(['top', 'right', 'bottom', 'left'] as const).map((s) => <ValueInput key={s} label={s} value={get(s)} placeholder={s} onCommit={(v) => set(s, v)} />)}
        </div>
        <UnitRow label="Z-index" prop="z-index" value={get('z-index')} onChange={set} list={['0', '1', '10', '100']} />
      </Section>
    </div>
  );
}
