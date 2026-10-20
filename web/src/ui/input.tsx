import { Label as RadixLabel } from 'radix-ui';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const control =
  'min-h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-sm text-fg shadow-sm placeholder:text-muted/80 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, type = 'text', ...props }, ref) => (
  <input ref={ref} type={type} className={cn(control, className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-24 resize-y', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Label = forwardRef<HTMLLabelElement, React.ComponentPropsWithoutRef<typeof RadixLabel.Root>>(({ className, ...props }, ref) => (
  <RadixLabel.Root ref={ref} className={cn('text-sm font-semibold', className)} {...props} />
));
Label.displayName = 'Label';

/** Label + control + hint/error, wired for assistive technology. */
export function FormField({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; className?: string; children: (p: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const described = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': described })}
      {hint ? <span id={`${id}-hint`} className="text-[0.82rem] text-muted">{hint}</span> : null}
      {error ? <span id={`${id}-err`} role="alert" className="text-[0.85rem] text-danger">{error}</span> : null}
    </div>
  );
}
