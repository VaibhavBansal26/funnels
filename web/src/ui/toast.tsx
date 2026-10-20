import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Toast as RadixToast } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

type Kind = 'info' | 'ok' | 'error';
interface Item { id: number; kind: Kind; message: string }
export interface ToastApi { push(message: string, kind?: Kind): void }

const Ctx = createContext<ToastApi>({ push: () => undefined });

/** Toasts on Radix Toast: announced politely (errors assertively), pause on hover/focus, swipe or button to dismiss. */
export function ToastProvider({ children, ttl = 5000 }: { children: ReactNode; ttl?: number }) {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const push = useCallback((message: string, kind: Kind = 'info') => {
    const id = next.current++;
    setItems((t) => [...t.slice(-4), { id, kind, message }]);
  }, []);
  const api = useMemo(() => ({ push }), [push]);
  const icon = { info: <Info className="size-4" />, ok: <CheckCircle2 className="size-4" />, error: <XCircle className="size-4" /> };
  return (
    <Ctx.Provider value={api}>
      <RadixToast.Provider duration={ttl > 0 ? ttl : 3_600_000} swipeDirection="right" label="Notifications">
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            type={t.kind === 'error' ? 'foreground' : 'background'}
            onOpenChange={(open) => !open && setItems((all) => all.filter((x) => x.id !== t.id))}
            className={cn('flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm shadow-pop data-[state=closed]:animate-[fade-in_0.1s_reverse] data-[state=open]:animate-[slide-in-right_0.2s]', t.kind === 'error' ? 'border-danger/40 bg-danger-soft text-danger' : t.kind === 'ok' ? 'border-ok/40 bg-ok-soft text-ok' : 'border-border bg-surface text-fg')}
          >
            <span className="mt-0.5">{icon[t.kind]}</span>
            <RadixToast.Description className="min-w-0 flex-1 break-words">{t.message}</RadixToast.Description>
            <RadixToast.Close aria-label="Dismiss notification" className="rounded p-0.5 hover:bg-black/10"><X className="size-4" /></RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed right-4 bottom-4 z-[300] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </Ctx.Provider>
  );
}

export const useToast = (): ToastApi => useContext(Ctx);
