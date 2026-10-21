import { DropdownMenu as RadixMenu } from 'radix-ui';
import { forwardRef } from 'react';
import { cn } from './cn';

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuContent = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixMenu.Content>>(({ className, sideOffset = 6, ...p }, ref) => (
  <RadixMenu.Portal>
    <RadixMenu.Content ref={ref} sideOffset={sideOffset} className={cn('z-[150] min-w-48 animate-[pop-in_0.12s] rounded-xl border border-border bg-surface p-1.5 text-sm text-fg shadow-pop', className)} {...p} />
  </RadixMenu.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';
export const DropdownMenuItem = forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof RadixMenu.Item> & { danger?: boolean }>(({ className, danger, ...p }, ref) => (
  <RadixMenu.Item ref={ref} className={cn('flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4', danger && 'text-danger', className)} {...p} />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';
export const DropdownMenuSeparator = () => <RadixMenu.Separator className="my-1.5 h-px bg-border" />;
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof RadixMenu.Label>) => <RadixMenu.Label className={cn('px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted', className)} {...p} />;
