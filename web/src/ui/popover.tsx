import { Popover as RadixPopover } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverContent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixPopover.Content>>(({ className, align = 'start', sideOffset = 6, ...p }, ref) => (
  <RadixPopover.Portal>
    <RadixPopover.Content ref={ref} align={align} sideOffset={sideOffset} className={cn('z-[150] w-72 animate-[pop-in_0.12s] rounded-xl border border-border bg-surface p-4 text-fg shadow-pop outline-none', className)} {...p} />
  </RadixPopover.Portal>
));
PopoverContent.displayName = 'PopoverContent';
