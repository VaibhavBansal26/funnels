import type { ReactNode } from 'react';
import { cn } from './cn';

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong/70 px-6 py-16 text-center', className)}>
      {icon ? <div className="grid size-12 place-items-center rounded-full mb-1 bg-primary-soft text-primary [&_svg]:size-5">{icon}</div> : null}
      <h3 className="text-[0.9375rem] font-semibold">{title}</h3>
      {children ? <p className="max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
