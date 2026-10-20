import { Pipette, X } from 'lucide-react';
import { useId } from 'react';
import { cn } from './cn';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const PRESETS = ['#0f172a', '#1e293b', '#475569', '#94a3b8', '#ffffff', '#f1f5f9', '#4338ca', '#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#be185d', '#7c3aed'];

/** Normalises #rgb to #rrggbb for <input type=color>; anything else (rgb(), names, gradients) falls back to black in the native control only. */
const toHex = (v: string): string => {
  const m = /^#([0-9a-f]{3})$/i.exec(v.trim());
  if (m) return `#${[...m[1]!].map((c) => c + c).join('')}`;
  return /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : '#000000';
};

/** Colour field: swatch + hex/CSS text input, with a popover of presets and the native picker. An empty value means "inherit". */
export function ColorPicker({ value, onChange, label, size = 'md', className }: { value: string; onChange: (v: string) => void; label: string; size?: 'sm' | 'md'; className?: string }) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${label}: ${value || 'none'}. Open colour picker`} className={cn('relative shrink-0 overflow-hidden rounded-md border border-border-strong shadow-sm', size === 'sm' ? 'size-7' : 'size-9')} style={{ background: 'repeating-conic-gradient(#cbd5e1 0% 25%, #fff 0% 50%) 50% / 10px 10px' }}>
            <span className="absolute inset-0" style={{ background: value || 'transparent' }} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-60">
          <div className="grid grid-cols-7 gap-1.5">
            {PRESETS.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => onChange(c)} className="size-6 rounded-md border border-border-strong shadow-sm" style={{ background: c }} />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-muted"><Pipette className="size-3.5" /> Custom</label>
            <input id={id} type="color" value={toHex(value)} onChange={(e) => onChange(e.target.value)} className="h-7 w-full cursor-pointer rounded border border-border-strong bg-transparent p-0" />
          </div>
          <button type="button" onClick={() => onChange('')} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg"><X className="size-3" /> Clear</button>
        </PopoverContent>
      </Popover>
      <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder="inherit" spellCheck={false} className={cn('w-full min-w-0 rounded-md border border-border-strong bg-surface px-2 font-mono text-xs text-fg shadow-sm focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40', size === 'sm' ? 'min-h-7' : 'min-h-9')} />
    </div>
  );
}
