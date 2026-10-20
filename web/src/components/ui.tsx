import { Check, Copy, Inbox } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { Pagination } from '../api/types';
import { Badge, Button, Dialog, EmptyState, FormField, Input, Skeleton } from '../ui';

/** App-level building blocks on top of src/ui (the design system). Pages import from here; the primitives live in src/ui. */
export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" aria-busy="true" className="flex flex-col gap-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11" />
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
          {code && code !== 'HTTP_ERROR' ? <span className="text-xs opacity-80"> ({code})</span> : null}
        </span>
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <EmptyState icon={<Inbox />} title={title} action={action}>
      {children}
    </EmptyState>
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
  return (
    <FormField label={label} error={error} hint={hint} className="mb-3">
      {children}
    </FormField>
  );
}

export function TextField({ label, error, hint, value, onChange, type = 'text', ...rest }: { label: string; error?: string; hint?: string; value: string; onChange: (v: string) => void; type?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(p) => <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} {...p} {...rest} />}
    </Field>
  );
}

/** Modal (or right-hand drawer with `side`): labelled, traps focus, closes on Escape, restores focus to the opener. */
export function Modal({ title, onClose, children, footer, wide, side }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; side?: boolean }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} footer={footer} size={wide ? 'lg' : 'md'} side={side ? 'right' : undefined}>
      {children}
    </Dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger, busy, onConfirm, onCancel }: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} data-autofocus>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

export function Pager({ p, onPage }: { p: Pagination; onPage: (n: number) => void }) {
  if (p.totalPages <= 1 && p.total <= p.limit) return <div className="pager small muted">{p.total} total</div>;
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="small muted">Page {p.page} of {p.totalPages} · {p.total} total</span>
      <Button size="sm" disabled={p.page <= 1} onClick={() => onPage(p.page - 1)}>Previous</Button>
      <Button size="sm" disabled={p.page >= p.totalPages} onClick={() => onPage(p.page + 1)}>Next</Button>
    </nav>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'live' || status === 'active' || status === 'delivered' ? 'ok' : status === 'failed' || status === 'dead' ? 'danger' : status === 'pending' || status === 'queued' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      aria-label={`${label} ${text.length > 24 ? 'value' : text}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? 'Copied' : label}
    </Button>
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
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
