import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Kind = 'info' | 'ok' | 'error';
interface Toast { id: number; kind: Kind; message: string }
interface ToastApi { push(message: string, kind?: Kind): void }

const Ctx = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children, ttl = 5000 }: { children: ReactNode; ttl?: number }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, kind: Kind = 'info') => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-4), { id, kind, message }]);
      if (ttl > 0) setTimeout(() => dismiss(id), ttl);
    },
    [dismiss, ttl],
  );
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="grow">{t.message}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = (): ToastApi => useContext(Ctx);
