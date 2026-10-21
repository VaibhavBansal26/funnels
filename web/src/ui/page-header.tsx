import type { ReactNode } from 'react';
import { cn } from './cn';

/** Page title block: one h1, an optional one-line description and the primary action(s) on the right. Every top-level screen starts with it. */
export function PageHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1>{title}</h1>
        {description ? <p className="mt-1.5 mb-0 max-w-2xl text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}
