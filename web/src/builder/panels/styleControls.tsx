import { useEffect, useId, useRef, useState } from 'react';
import { safeCssValue } from '@pagemodel';
import { ColorPicker, Select, type Option } from '../../ui';
import { inputCls, Row } from './kit';

/**
 * Text field for one CSS value with number stepping (ArrowUp/Down, Shift for x10), commit on change after a short pause, and validation with the
 * server's value filter (an unacceptable value is flagged and never applied). `value` is what the style target holds; `placeholder` is the computed one.
 */
export function ValueInput({ label, value, placeholder, onCommit, list, className }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => boolean; list?: string[]; className?: string }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  useEffect(() => { setText(value); setBad(false); }, [value]);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    const ok = v === '' || safeCssValue(v) !== null;
    setBad(!ok);
    if (ok) onCommit(v);
  };
  const step = (dir: 1 | -1, big: boolean) => {
    const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec((text || placeholder || '0').trim());
    if (!m) return;
    const n = Math.round((parseFloat(m[1]!) + dir * (big ? 10 : 1)) * 100) / 100;
    const next = `${n}${m[2] || 'px'}`;
    setText(next);
    commit(next);
  };
  return (
    <>
      <input
        aria-label={label}
        aria-invalid={bad || undefined}
        value={text}
        placeholder={placeholder}
        list={list ? id : undefined}
        spellCheck={false}
        className={`${inputCls} ${className ?? ''}`}
        onChange={(e) => { setText(e.target.value); clearTimeout(timer.current); timer.current = setTimeout(() => commit(e.target.value), 350); }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(text);
          else if (e.key === 'ArrowUp') (e.preventDefault(), step(1, e.shiftKey));
          else if (e.key === 'ArrowDown') (e.preventDefault(), step(-1, e.shiftKey));
        }}
      />
      {list ? <datalist id={id}>{list.map((o) => <option key={o} value={o} />)}</datalist> : null}
    </>
  );
}

export const UnitRow = ({ label, prop, value, placeholder, onChange, list }: { label: string; prop: string; value: string; placeholder?: string; onChange: (p: string, v: string) => boolean; list?: string[] }) => (
  <Row label={label} hint={prop}><ValueInput label={`${label} (${prop})`} value={value} placeholder={placeholder} onCommit={(v) => onChange(prop, v)} list={list} /></Row>
);

export function SelectRow({ label, prop, value, options, onChange, placeholder }: { label: string; prop: string; value: string; options: Option[]; onChange: (p: string, v: string) => boolean; placeholder?: string }) {
  const known = options.some((o) => o.value === value);
  return (
    <Row label={label} hint={prop}>
      <Select size="sm" aria-label={`${label} (${prop})`} value={value} placeholder={placeholder ?? 'Default'} options={known || value === '' ? options : [{ value, label: value }, ...options]} onValueChange={(v) => onChange(prop, v)} />
    </Row>
  );
}

export const ColorRow = ({ label, prop, value, onChange }: { label: string; prop: string; value: string; onChange: (p: string, v: string) => boolean }) => (
  <Row label={label} hint={prop}><ColorPicker size="sm" label={`${label} (${prop})`} value={value} onChange={(v) => onChange(prop, v)} /></Row>
);

/** The classic box-model picture: margin around padding, four values each, laid out on a grid so nothing overlaps at any panel width. */
export function BoxModel({ get, placeholder, set }: { get: (p: string) => string; placeholder: (p: string) => string; set: (p: string, v: string) => boolean }) {
  const cell = (kind: 'margin' | 'padding', s: 'top' | 'right' | 'bottom' | 'left', cls: string) => (
    <div className={cls}>
      <ValueInput label={`${kind} ${s}`} value={get(`${kind}-${s}`)} placeholder={placeholder(`${kind}-${s}`)} onCommit={(v) => set(`${kind}-${s}`, v)} className="!min-h-6 !px-0 text-center text-[0.7rem]" />
    </div>
  );
  const grid = 'grid grid-cols-[3.25rem_1fr_3.25rem] items-center gap-1';
  return (
    <div role="group" aria-label="Spacing" className={`${grid} rounded-lg border border-dashed border-border-strong bg-surface-2 p-2`}>
      <span className="col-span-3 -mb-0.5 text-[0.65rem] font-medium tracking-wide text-muted uppercase">Margin</span>
      {cell('margin', 'top', 'col-start-2')}
      {cell('margin', 'left', 'col-start-1 row-start-3')}
      <div className={`${grid} col-start-2 row-start-3 rounded-md border border-dashed border-border-strong bg-surface p-1.5`}>
        <span className="col-span-3 -mb-0.5 text-[0.65rem] font-medium tracking-wide text-muted uppercase">Padding</span>
        {cell('padding', 'top', 'col-start-2')}
        {cell('padding', 'left', 'col-start-1 row-start-3')}
        <div className="col-start-2 row-start-3 h-6 rounded bg-surface shadow-sm" aria-hidden="true" />
        {cell('padding', 'right', 'col-start-3 row-start-3')}
        {cell('padding', 'bottom', 'col-start-2 row-start-4')}
      </div>
      {cell('margin', 'right', 'col-start-3 row-start-3')}
      {cell('margin', 'bottom', 'col-start-2 row-start-4')}
    </div>
  );
}
