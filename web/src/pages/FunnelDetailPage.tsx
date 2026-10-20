import { ArrowLeft, Pencil } from 'lucide-react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router';
import { useFunnel } from '../api/hooks';
import { ApiError } from '../api/client';
import { ErrorBanner, Loading, StatusBadge } from '../components/ui';
import { AnalyticsTab } from './AnalyticsTab';
import { LeadsTab, OrdersTab } from './LeadsOrdersTabs';
import { SettingsTab } from './SettingsTab';
import { StepsTab } from './StepsTab';

const TABS = ['steps', 'analytics', 'leads', 'orders', 'settings'] as const;
type Tab = (typeof TABS)[number];

export function FunnelDetailPage() {
  const { id = '', tab } = useParams();
  const nav = useNavigate();
  const q = useFunnel(id);
  if (!tab) return <Navigate to={`/funnels/${id}/steps`} replace />;
  if (!TABS.includes(tab as Tab)) return <Navigate to={`/funnels/${id}/steps`} replace />;
  if (q.isLoading) return <Loading />;
  if (q.error) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="stack">
        <ErrorBanner error={q.error} onRetry={missing ? undefined : () => void q.refetch()} />
        <div><button type="button" className="btn" onClick={() => nav('/funnels')}>Back to funnels</button></div>
      </div>
    );
  }
  const f = q.data!;
  return (
    <div className="stack">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/funnels" className="small mb-1 inline-flex items-center gap-1 text-muted no-underline hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden="true" /> My Funnels</Link>
          <h1 className="!mb-1">{f.name}</h1>
          <span className="row"><StatusBadge status={f.status} />{f.domain ? <span className="muted small">{f.domain.hostname}{f.basePath}</span> : <span className="muted small">No domain connected</span>}</span>
        </div>
        {f.steps[0] ? <Link className="btn primary" to={`/funnels/${f.id}/builder/${f.steps[0].id}`}><Pencil className="size-4" aria-hidden="true" /> Open builder</Link> : null}
      </div>
      <nav className="tabs" aria-label="Funnel sections">
        {TABS.map((t) => <NavLink key={t} to={`/funnels/${id}/${t}`}>{t[0]!.toUpperCase() + t.slice(1)}</NavLink>)}
      </nav>
      {tab === 'steps' ? <StepsTab funnel={f} /> : null}
      {tab === 'analytics' ? <AnalyticsTab funnel={f} /> : null}
      {tab === 'leads' ? <LeadsTab funnelId={f.id} /> : null}
      {tab === 'orders' ? <OrdersTab funnelId={f.id} /> : null}
      {tab === 'settings' ? <SettingsTab funnel={f} /> : null}
    </div>
  );
}
