import { useState } from 'react';
import { downloadFile } from '../api/client';
import { api } from '../api/client';
import { useMutate, useLeads, useOrders } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import type { Order } from '../api/types';
import { useToast } from '../components/Toasts';
import { Empty, ErrorBanner, fmtDate, fmtMoney, Loading, Modal, Pager, TextField } from '../components/ui';
import { errorMessage } from '../api/client';

function Filters({ state, onChange, onExport, exporting, label }: { state: { search: string; from: string; to: string }; onChange: (s: { search: string; from: string; to: string }) => void; onExport: () => void; exporting: boolean; label: string }) {
  return (
    <div className="filters" role="search" aria-label={`Filter ${label}`}>
      <div className="field"><label htmlFor={`${label}-s`}>Search</label><input id={`${label}-s`} className="input" value={state.search} onChange={(e) => onChange({ ...state, search: e.target.value })} /></div>
      <div className="field"><label htmlFor={`${label}-f`}>From</label><input id={`${label}-f`} type="date" className="input" value={state.from} onChange={(e) => onChange({ ...state, from: e.target.value })} /></div>
      <div className="field"><label htmlFor={`${label}-t`}>To</label><input id={`${label}-t`} type="date" className="input" value={state.to} onChange={(e) => onChange({ ...state, to: e.target.value })} /></div>
      <button type="button" className="btn" disabled={exporting} onClick={onExport}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
    </div>
  );
}

function useExport(path: string, filename: string, query: Record<string, string | undefined>) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async () => {
      setBusy(true);
      try {
        await downloadFile(path, filename, query);
      } catch (e) {
        toast.push(errorMessage(e), 'error');
      } finally {
        setBusy(false);
      }
    },
  };
}

export function LeadsTab({ funnelId }: { funnelId: string }) {
  const [f, setF] = useState({ search: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const query = { funnelId, search: f.search || undefined, from: f.from || undefined, to: f.to || undefined };
  const q = useLeads({ ...query, page, limit: 20 });
  const exp = useExport('/api/leads/export', 'leads.csv', query);
  return (
    <div className="stack">
      <Filters state={f} onChange={(s) => { setF(s); setPage(1); }} onExport={exp.run} exporting={exp.busy} label="leads" />
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No leads yet">Opt-ins from this funnel's forms will appear here.</Empty></div> : null}
      {q.data?.data.length ? (
        <div className="card flush table-wrap">
          <table className="table"><caption className="sr-only">Leads</caption>
            <thead><tr><th scope="col">Email</th><th scope="col">Name</th><th scope="col">Phone</th><th scope="col" className="num">Submissions</th><th scope="col">First seen</th></tr></thead>
            <tbody>{q.data.data.map((l) => <tr key={l.id}><td>{l.email}</td><td>{l.name ?? '—'}</td><td>{l.phone ?? '—'}</td><td className="num">{l.submissions}</td><td className="small muted">{fmtDate(l.createdAt)}</td></tr>)}</tbody>
          </table>
          <Pager p={q.data.pagination} onPage={setPage} />
        </div>
      ) : null}
    </div>
  );
}

export function OrdersTab({ funnelId }: { funnelId: string }) {
  const [f, setF] = useState({ search: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const query = { funnelId, search: f.search || undefined, from: f.from || undefined, to: f.to || undefined };
  const q = useOrders({ ...query, page, limit: 20 });
  const exp = useExport('/api/orders/export', 'orders.csv', query);
  return (
    <div className="stack">
      <Filters state={f} onChange={(s) => { setF(s); setPage(1); }} onExport={exp.run} exporting={exp.busy} label="orders" />
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No orders yet">Test payments made through this funnel's checkout blocks are listed here.</Empty></div> : null}
      {q.data?.data.length ? (
        <div className="card flush table-wrap">
          <table className="table"><caption className="sr-only">Orders</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Product</th><th scope="col">Customer</th><th scope="col">Type</th><th scope="col" className="num">Amount</th><th scope="col">Status</th></tr></thead>
            <tbody>{q.data.data.map((o) => <tr key={o.id}><td className="small muted">{fmtDate(o.createdAt)}</td><td>{o.productName}</td><td>{o.email}</td><td>{o.isBump ? <span className="badge">Bump</span> : o.isUpsell ? <span className="badge primary">Upsell</span> : <span className="badge ok">Offer</span>}</td><td className="num">{fmtMoney(o.amount, o.currency)}</td><td><RefundCell order={o} /></td></tr>)}</tbody>
          </table>
          <Pager p={q.data.pagination} onPage={setPage} />
        </div>
      ) : null}
    </div>
  );
}

function RefundCell({ order }: { order: Order }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const left = order.amountCents - order.refundedCents;
  const refund = useMutate(() => api.post(`/api/orders/${order.id}/refund`, amount.trim() ? { amountCents: Math.round(Number(amount) * 100) } : {}), [['orders']]);
  const cents = amount.trim() ? Math.round(Number(amount) * 100) : left;
  const invalid = !Number.isFinite(cents) || cents <= 0 || cents > left;
  return (
    <>
      {order.status === 'refunded' ? <span className="badge">Refunded</span> : order.status === 'partially_refunded' ? <span className="badge warn">Refunded {fmtMoney(order.refundedCents / 100, order.currency)}</span> : <span className="badge ok">Paid</span>}
      {order.status !== 'refunded' && can('orders:refund') ? <> <button type="button" className="btn small" onClick={() => setOpen(true)}>Refund</button></> : null}
      {open ? (
        <Modal title="Refund order" onClose={() => setOpen(false)}
          footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn danger" disabled={refund.isPending || invalid} onClick={() => refund.mutate(undefined, { onSuccess: () => setOpen(false) })}>Refund {fmtMoney(invalid ? 0 : cents / 100, order.currency)}</button></>}>
          <ErrorBanner error={refund.error} />
          <p>{order.productName} for {order.email}. Up to {fmtMoney(left / 100, order.currency)} can still be refunded.{order.provider === 'stripe' ? ' The money goes back to the customer through Stripe.' : ''}</p>
          <TextField label="Amount (empty refunds everything left)" value={amount} onChange={setAmount} error={amount.trim() && invalid ? 'Enter an amount between 0 and what is left' : undefined} />
        </Modal>
      ) : null}
    </>
  );
}
