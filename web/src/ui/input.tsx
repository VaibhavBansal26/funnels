import { Label as RadixLabel } from 'radix-ui';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const control =
  'min-h-10 w-full rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-muted/70 hover:border-muted/60 focus-visible:border-ring focus-visible:outline-0 focus-visible:ring-4 focus-visible:ring-ring/15 max-sm:min-h-11 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, type = 'text', ...props }, ref) => (
  <input ref={ref} type={type} className={cn(control, className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-24 resize-y', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Label = forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<typeof RadixLabel.Root>>(({ className, ...props }, ref) => (
  <RadixLabel.Root ref={ref} className={cn('text-[0.8125rem] font-medium', className)} {...props} />
));
Label.displayName = 'Label';

/** Label + control + hint/error, wired for assistive technology. */
export function FormField({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; className?: string; children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described })}
      {hint ? <span id={`${id}-hint`} className="text-[0.8125rem] text-muted">{hint}</span> : null}
      {error ? <span id={`${id}-err`} role="alert" className="text-[0.8125rem] text-danger">{error}</span> : null}
    </div>
  );
}
