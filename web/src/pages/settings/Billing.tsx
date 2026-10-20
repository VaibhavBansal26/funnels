import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useMutate } from '../../api/hooks';
import type { BillingOverview } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner, fmtDate, Loading } from '../../components/ui';

const key = ['billing'] as const;
const LABELS = { funnels: 'Funnels', domains: 'Domains', members: 'Members (with pending invitations)', apiKeys: 'API keys' } as const;

export function Billing() {
  const { can } = useAuth();
  const manage = can('billing:manage');
  const q = useQuery({ queryKey: key, queryFn: () => api.get<BillingOverview>('/api/billing') });
  const [busy, setBusy] = useState<string | null>(null);
  const go = useMutate((path: string) => api.post<{ url: string }>(path).then((r) => { window.location.assign(r.url); return r; }), [key]);
  const run = (path: string, body?: unknown) => { setBusy(path); go.mutate(path, { onSettled: () => setBusy(null) }); void body; };
  const subscribe = useMutate((plan: string) => api.post<{ url: string }>('/api/billing/subscribe', { plan }).then((r) => { window.location.assign(r.url); return r; }));
  const o = q.data;
  const connect = o?.stripe.connect;
  return (
    <section className="card stack" aria-label="Billing">
      <h2>Plan and payments</h2>
      {q.isLoading ? <Loading rows={2} /> : null}
      <ErrorBanner error={q.error ?? go.error ?? subscribe.error} />
      {o ? (
        <>
          <p>Plan: <strong>{o.planName}</strong>{o.status === 'past_due' ? <> <span className="badge warn">Payment past due</span></> : null}{o.periodEnd ? <span className="muted small"> (renews or ends {fmtDate(o.periodEnd)})</span> : null}. Funnels keeps {o.applicationFeePercent}% of checkouts made with your connected Stripe account.</p>
          {!o.enforced ? <p className="muted small">Plan limits are not enforced on this installation.</p> : null}
          <table className="table"><caption className="sr-only">Usage against plan limits</caption>
            <thead><tr><th scope="col">Resource</th><th scope="col" className="num">Used</th><th scope="col" className="num">Limit</th></tr></thead>
            <tbody>{(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((k) => <tr key={k}><td>{LABELS[k]}</td><td className="num">{o.usage[k]}</td><td className="num">{o.limits[k]}</td></tr>)}</tbody>
          </table>
          {manage && o.stripe.configured ? (
            <div className="row">
              {o.plans.filter((p) => p.purchasable && p.id !== o.plan).map((p) => <button key={p.id} type="button" className="btn primary" disabled={subscribe.isPending} onClick={() => subscribe.mutate(p.id)}>Upgrade to {p.name}</button>)}
              {o.subscription.hasCustomer ? <button type="button" className="btn" disabled={busy !== null} onClick={() => run('/api/billing/portal')}>Manage subscription</button> : null}
            </div>
          ) : null}
          <h3>Accepting payments</h3>
          {!o.stripe.configured ? <p className="muted small">Payments run in test mode (no real money) because Stripe is not configured on this installation.</p> : !connect ? <p className="muted">Connect your Stripe account to take payments in your funnels.</p> : (
            <p>Stripe account <code>{connect.accountId}</code>: {connect.chargesEnabled ? <span className="badge ok">Ready to take payments</span> : <span className="badge warn">Onboarding not finished</span>}{connect.chargesEnabled && !connect.payoutsEnabled ? <span className="muted small"> (payouts not enabled yet)</span> : null}</p>
          )}
          {manage && o.stripe.configured ? (
            <div className="row">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => run('/api/billing/connect/start')}>{connect ? (connect.chargesEnabled ? 'Open Stripe settings' : 'Continue onboarding') : 'Connect Stripe'}</button>
              {connect ? <button type="button" className="btn danger" disabled={busy !== null} onClick={() => { setBusy('d'); void api.post('/api/billing/connect/disconnect').then(() => q.refetch()).finally(() => setBusy(null)); }}>Disconnect</button> : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
