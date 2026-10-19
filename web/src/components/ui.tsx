import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { Pagination } from '../api/types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="stack" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 44 }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <div className="alert error" role="alert">
      <div className="row between">
        <span>
          {errorMessage(error)}
          {code && code !== 'HTTP_ERROR' ? <span className="muted small"> ({code})</span> : null}
        </span>
        {onRetry ? (
          <button type="button" className="btn sm" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** Shows a skeleton while loading, an error banner on failure, an empty state for empty lists, else the children. */
export function QueryState({ q, empty, children }: { q: { isLoading: boolean; error: unknown; refetch: () => unknown; data?: unknown }; empty?: ReactNode; children: ReactNode }) {
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />;
  if (empty) return <>{empty}</>;
  return <>{children}</>;
}

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
}

/** Label + control + hint/error wiring in one place so every form is accessible by construction. */
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint ? <span id={`${id}-hint`} className="hint">{hint}</span> : null}
      {error ? <span id={`${id}-err`} className="error" role="alert">{error}</span> : null}
    </div>
  );
}

export function TextField({ label, error, hint, value, onChange, type = 'text', ...rest }: { label: string; error?: string; hint?: string; value: string; onChange: (v: string) => void; type?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(p) => <input className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} {...p} {...rest} />}
    </Field>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

/** Accessible modal: labelled, traps focus, closes on Escape, restores focus to the opener. */
export function Modal({ title, onClose, children, footer, wide, side }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; side?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const [a, z] = [items[0]!, items[items.length - 1]!];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`overlay${side ? ' right' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={side ? 'drawer' : `modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn ghost icon" aria-label="Close dialog" onClick={onClose}>×</button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, busy, onConfirm, onCancel }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} data-autofocus>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

export function Pager({ p, onPage }: { p: Pagination; onPage: (n: number) => void }) {
  if (p.totalPages <= 1 && p.total <= p.limit) return <div className="pager muted small">{p.total} total</div>;
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted small">Page {p.page} of {p.totalPages} · {p.total} total</span>
      <button type="button" className="btn sm" disabled={p.page <= 1} onClick={() => onPage(p.page - 1)}>Previous</button>
      <button type="button" className="btn sm" disabled={p.page >= p.totalPages} onClick={() => onPage(p.page + 1)}>Next</button>
    </nav>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const kind = status === 'live' || status === 'active' || status === 'delivered' ? 'ok' : status === 'failed' || status === 'dead' ? 'danger' : status === 'pending' || status === 'queued' ? 'warn' : '';
  return <span className={`badge ${kind}`}>{status}</span>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(text)} aria-label={`${label} ${text.length > 24 ? 'value' : text}`}>
      {label}
    </button>
  );
}

export const fmtMoney = (n: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
};
export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
export const fmtPct = (n: number) => `${n.toFixed(2)}%`;
export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
