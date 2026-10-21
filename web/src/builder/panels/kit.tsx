import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn, Tooltip } from '../../ui';

/** Small building blocks shared by the builder panels (dense inspector controls, collapsible sections, segmented buttons). */
export function Section({ title, defaultOpen = true, children, badge, id }: { title: string; defaultOpen?: boolean; children: ReactNode; badge?: ReactNode; id?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-border/70" data-section={id ?? title}>
      <h3 className="m-0">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-[0.8125rem] font-semibold text-fg transition-colors hover:bg-surface-2/70">
          <ChevronDown className={cn('size-3.5 text-muted transition-transform', !open && '-rotate-90')} aria-hidden="true" />
          <span className="flex-1">{title}</span>
          {badge}
        </button>
      </h3>
      {open ? <div className="flex flex-col gap-3.5 px-4 pb-4">{children}</div> : null}
    </section>
  );
}

export function Row({ label, children, htmlFor, hint }: { label: string; children: ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-3">
      <label htmlFor={htmlFor} className="text-[0.8125rem] text-muted" title={hint}>{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const inputCls = 'min-h-8 w-full min-w-0 rounded-lg border border-border-strong bg-surface px-2.5 text-[0.8125rem] text-fg transition-[border-color,box-shadow] placeholder:text-muted/70 hover:border-muted/60 focus-visible:border-ring focus-visible:outline-0 focus-visible:ring-4 focus-visible:ring-ring/15 aria-[invalid=true]:border-danger';

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T | ''; onChange: (v: T) => void; options: { value: T; label: ReactNode; title: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-full gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <Tooltip key={o.value} label={o.title}>
          <button type="button" aria-label={o.title} aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={cn('flex min-h-7 flex-1 items-center justify-center rounded-md px-1.5 text-[0.78rem] font-medium text-muted transition-colors hover:text-fg [&_svg]:size-3.5', value === o.value && 'bg-surface text-fg shadow-sm')}>
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
      <div className="grid size-12 place-items-center rounded-full bg-surface-2 text-primary [&_svg]:size-5">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children ? <p className="text-[0.82rem] text-muted">{children}</p> : null}
    </div>
  );
}
