import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn, Tooltip } from '../../ui';

/** Small building blocks shared by the builder panels (dense inspector controls, collapsible sections, segmented buttons). */
export function Section({ title, defaultOpen = true, children, badge, id }: { title: string; defaultOpen?: boolean; children: ReactNode; badge?: ReactNode; id?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border" data-section={id ?? title}>
      <h3 className="m-0">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[0.8rem] font-semibold tracking-wide text-fg uppercase hover:bg-surface-2">
          <ChevronDown className={cn('size-3.5 text-muted transition-transform', !open && '-rotate-90')} aria-hidden="true" />
          <span className="flex-1">{title}</span>
          {badge}
        </button>
      </h3>
      {open ? <div className="flex flex-col gap-3 px-3 pb-3.5">{children}</div> : null}
    </section>
  );
}

export function Row({ label, children, htmlFor, hint }: { label: string; children: ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <label htmlFor={htmlFor} className="text-[0.8rem] font-medium text-muted" title={hint}>{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const inputCls = 'min-h-7 w-full min-w-0 rounded-md border border-border-strong bg-surface px-2 text-[0.82rem] text-fg shadow-sm placeholder:text-muted/70 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 aria-[invalid=true]:border-danger';

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T | ''; onChange: (v: T) => void; options: { value: T; label: ReactNode; title: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-full overflow-hidden rounded-md border border-border-strong bg-surface shadow-sm">
      {options.map((o) => (
        <Tooltip key={o.value} label={o.title}>
          <button type="button" aria-label={o.title} aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={cn('flex min-h-7 flex-1 items-center justify-center px-1.5 text-[0.78rem] font-semibold text-muted hover:bg-surface-2 [&_svg]:size-3.5', value === o.value && 'bg-primary-soft text-primary')}>
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function PanelEmpty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-primary-soft text-primary [&_svg]:size-5">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children ? <p className="text-[0.82rem] text-muted">{children}</p> : null}
    </div>
  );
}
