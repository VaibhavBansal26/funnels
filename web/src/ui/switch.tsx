import { Switch as RadixSwitch } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export const Switch = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof RadixSwitch.Root>>(({ className, ...props }, ref) => (
  <RadixSwitch.Root ref={ref} className={cn('peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-border-strong transition-colors data-[state=checked]:bg-primary disabled:opacity-55', className)} {...props}>
    <RadixSwitch.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
  </RadixSwitch.Root>
));
Switch.displayName = 'Switch';
