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
  const portal = useMutate((path: string) => api.post<{ url: string }>(path).then((r) => { window.location.assign(r.url); return r; }), [key]);
  const subscribe = useMutate((plan: string) => api.post<{ url: string }>('/api/billing/subscribe', { plan }).then((r) => { window.location.assign(r.url); return r; }));
  const o = q.data;
  return (
    <section className="card stack" aria-label="Billing">
      <h2>Plan</h2>
      {q.isLoading ? <Loading rows={2} /> : null}
      <ErrorBanner error={q.error ?? portal.error ?? subscribe.error} />
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
              {o.subscription.hasCustomer ? <button type="button" className="btn" disabled={portal.isPending} onClick={() => portal.mutate('/api/billing/portal')}>Manage subscription</button> : null}
            </div>
          ) : null}
          <p className="muted small">Connecting Stripe and the checkout settings are in <a href="#payments">Payments</a> below.</p>
        </>
      ) : null}
    </section>
  );
}
