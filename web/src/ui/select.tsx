import { Check, ChevronDown } from 'lucide-react';
import { Select as RadixSelect } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Accessible select with a styled listbox (Radix). Options are passed as data; an empty-string value is allowed (Radix itself forbids it,
 * so it is mapped to a sentinel). Pass `size="sm"` for the dense inspector.
 */
const EMPTY = '__empty__';

export const Select = forwardRef<HTMLButtonElement, { value: string; onValueChange: (v: string) => void; options: Option[]; placeholder?: string; size?: 'sm' | 'md'; className?: string; id?: string; 'aria-label'?: string; disabled?: boolean }>(
  ({ value, onValueChange, options, placeholder, size = 'md', className, ...rest }, ref) => (
    <RadixSelect.Root value={value === '' ? EMPTY : value} onValueChange={(v) => onValueChange(v === EMPTY ? '' : v)} disabled={rest.disabled}>
      <RadixSelect.Trigger
        ref={ref}
        id={rest.id}
        aria-label={rest['aria-label']}
        className={cn('inline-flex w-full items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-left text-sm text-fg transition-[border-color,box-shadow] duration-150 hover:border-muted/60 focus-visible:border-ring focus-visible:outline-0 focus-visible:ring-4 focus-visible:ring-ring/15 disabled:opacity-60 data-[placeholder]:text-muted', size === 'sm' ? 'min-h-8 px-2.5 text-[0.8125rem]' : 'min-h-10 max-sm:min-h-11', className)}
      >
        <span className="truncate"><RadixSelect.Value placeholder={placeholder} /></span>
        <RadixSelect.Icon><ChevronDown className="size-4 text-muted" /></RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={4} className="z-[160] max-h-72 min-w-[var(--radix-select-trigger-width)] animate-[pop-in_0.12s] overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-pop">
          <RadixSelect.Viewport className="p-1.5">
            {options.map((o) => (
              <RadixSelect.Item key={o.value} value={o.value === '' ? EMPTY : o.value} disabled={o.disabled} className="relative flex cursor-pointer select-none items-center rounded-lg py-2 pr-8 pl-3 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2">
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2"><Check className="size-4 text-primary" /></RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  ),
);
Select.displayName = 'Select';
