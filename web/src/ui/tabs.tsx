import { Tabs as RadixTabs } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export const Tabs = RadixTabs.Root;
export const TabsList = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixTabs.List>>(({ className, ...p }, ref) => (
  <RadixTabs.List ref={ref} className={cn('flex gap-1 border-b border-border', className)} {...p} />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>>(({ className, ...p }, ref) => (
  <RadixTabs.Trigger ref={ref} className={cn('-mb-px inline-flex items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-semibold text-muted transition-colors hover:text-fg data-[state=active]:border-primary data-[state=active]:text-primary [&_svg]:size-4', className)} {...p} />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixTabs.Content>>(({ className, ...p }, ref) => (
  <RadixTabs.Content ref={ref} className={cn('focus-visible:outline-none', className)} {...p} />
));
TabsContent.displayName = 'TabsContent';
