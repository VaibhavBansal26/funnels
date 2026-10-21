import { Check, ChevronDown, Copy, Inbox } from 'lucide-react';
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

/** One short line stays visible; the longer explanation sits behind a native disclosure (keyboard and screen-reader friendly, no JS). */
export function LearnMore({ children, label = 'Learn more', className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <details className={`group text-[0.8125rem] text-muted ${className ?? ''}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-primary [&::-webkit-details-marker]:hidden">{label}<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
      <div className="mt-2 flex flex-col gap-2 leading-relaxed">{children}</div>
    </details>
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayOffset = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));

/**
 * Date range filter used by every report: three presets as one segmented control, and the two date pickers behind "Custom range"
 * (opened automatically when the range is not a preset), so the filter bar is one quiet row instead of five controls.
 */
export function RangePicker({ range, setRange, tz, note = 'Days are bucketed in' }: { range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void; tz: string; note?: string }) {
  const [custom, setCustom] = useState(false);
  const today = isoDay(new Date());
  const preset = [7, 30, 90].find((n) => range.to === today && range.from === dayOffset(n - 1));
  const open = custom || preset === undefined;
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Date range">
      <div role="group" aria-label="Preset ranges" className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
        {[7, 30, 90].map((n) => (
          <button key={n} type="button" aria-pressed={preset === n} onClick={() => { setCustom(false); setRange({ from: dayOffset(n - 1), to: today }); }} className={`min-h-9 rounded-md px-3 text-sm font-medium transition-colors max-sm:min-h-11 ${preset === n ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>Last {n} days</button>
        ))}
        <button type="button" aria-pressed={open} aria-expanded={open} onClick={() => setCustom(!open)} className={`min-h-9 rounded-md px-3 text-sm font-medium transition-colors max-sm:min-h-11 ${open ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>Custom range</button>
      </div>
      {open ? (
        <>
          <div className="field !mb-0"><label htmlFor="range-from">From</label><input id="range-from" type="date" className="input" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
          <div className="field !mb-0"><label htmlFor="range-to">To</label><input id="range-to" type="date" className="input" value={range.to} min={range.from} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
          <span className="pb-2.5 text-[0.8125rem] text-muted">{note} {tz}</span>
        </>
      ) : null}
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
