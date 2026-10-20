import { Slider as RadixSlider } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export const Slider = forwardRef<HTMLSpanElement, React.ComponentPropsWithoutRef<typeof RadixSlider.Root>>(({ className, ...props }, ref) => (
  <RadixSlider.Root ref={ref} className={cn('relative flex h-5 w-full touch-none select-none items-center', className)} {...props}>
    <RadixSlider.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-surface-3">
      <RadixSlider.Range className="absolute h-full bg-primary" />
    </RadixSlider.Track>
    <RadixSlider.Thumb className="block size-4 rounded-full border-2 border-primary bg-surface shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
  </RadixSlider.Root>
));
Slider.displayName = 'Slider';
