import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = ({ children }: { children: ReactNode }) => <RadixTooltip.Provider delayDuration={350} skipDelayDuration={200}>{children}</RadixTooltip.Provider>;

/** Hover/focus hint for icon buttons. The label also belongs on the trigger as aria-label: tooltips are not announced reliably. */
export function Tooltip({ label, children, side = 'bottom', shortcut }: { label: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; shortcut?: string }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} className="z-[200] flex animate-[fade-in_0.12s] items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-pop">
          {label}
          {shortcut ? <kbd className="rounded bg-bg/20 px-1 font-mono text-[0.7rem]">{shortcut}</kbd> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
