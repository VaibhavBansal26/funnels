import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Modal dialog and side drawer on Radix Dialog: focus trap, Escape, scroll lock, labelled by its title, focus restored to the opener.
 * `side="right"` renders the drawer variant (notifications, history, panels on narrow screens).
 */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', side, hideTitle, className }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  side?: 'right' | 'left';
  hideTitle?: boolean;
  className?: string;
}) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[100] animate-[fade-in_0.15s] bg-scrim" />
        <RadixDialog.Content
          aria-describedby={description ? undefined : undefined}
          className={cn(
            'fixed z-[101] flex max-h-[90dvh] flex-col border border-border bg-surface text-fg shadow-pop outline-none',
            side
              ? cn('inset-y-0 w-full max-w-md animate-[slide-in-right_0.2s] rounded-none', side === 'right' ? 'right-0 border-r-0' : 'left-0 border-l-0', 'max-h-none')
              : cn('top-1/2 left-1/2 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 animate-[pop-in_0.15s] rounded-xl', width),
            className,
          )}
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <RadixDialog.Title className={cn('text-base font-semibold', hideTitle && 'sr-only')}>{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-0.5 text-sm text-muted">{description}</RadixDialog.Description> : null}
            </div>
            <RadixDialog.Close aria-label="Close dialog" className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><X className="size-4" /></RadixDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
