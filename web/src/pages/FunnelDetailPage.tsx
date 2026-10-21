import { ArrowLeft, ChevronDown, Pencil } from 'lucide-react';
import { Link, NavLink, Navigate, useNavigate, useParams } from 'react-router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui';
import { useFunnel } from '../api/hooks';
import { ApiError } from '../api/client';
import { ErrorBanner, Loading, StatusBadge } from '../components/ui';
import { ProductAnalytics } from '../components/ProductAnalytics';
import { AnalyticsTab } from './AnalyticsTab';
import { LeadsTab, OrdersTab } from './LeadsOrdersTabs';
import { SettingsTab } from './SettingsTab';
import { PerformanceView } from './growth/AdsReports';
import { StepsTab } from './StepsTab';

const TABS = ['steps', 'analytics', 'products', 'ads', 'leads', 'orders', 'settings'] as const;
type Tab = (typeof TABS)[number];
/** Rarely needed sections live behind "More" (the one that is open stays visible as a tab). */
const SECONDARY: Tab[] = ['products', 'ads'];
const label = (t: string) => t[0]!.toUpperCase() + t.slice(1);

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
          <span className="row"><StatusBadge status={f.status} />{f.address ? <span className="muted small">{f.address.url.replace(/^https?:\/\//, '')}</span> : <span className="muted small">No address yet</span>}</span>
        </div>
        <div className="row">
          {f.status === 'test' ? <Link className="btn" to={`/funnels/${f.id}/settings#go-live`}>Go live</Link> : null}
          {f.steps[0] ? <Link className="btn primary" to={`/funnels/${f.id}/builder/${f.steps[0].id}`}><Pencil className="size-4" aria-hidden="true" /> Open builder</Link> : null}
        </div>
      </div>
      <nav className="tabs" aria-label="Funnel sections">
        {TABS.filter((t) => !SECONDARY.includes(t) || t === tab).map((t) => <NavLink key={t} to={`/funnels/${id}/${t}`}>{label(t)}</NavLink>)}
        {SECONDARY.some((t) => t !== tab) ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="More sections">More <ChevronDown className="inline size-3.5" aria-hidden="true" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {SECONDARY.filter((t) => t !== tab).map((t) => <DropdownMenuItem key={t} onSelect={() => nav(`/funnels/${id}/${t}`)}>{label(t)}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </nav>
      {tab === 'steps' ? <StepsTab funnel={f} /> : null}
      {tab === 'analytics' ? <AnalyticsTab funnel={f} /> : null}
      {tab === 'products' ? <ProductAnalytics funnelId={f.id} /> : null}
      {tab === 'leads' ? <LeadsTab funnelId={f.id} /> : null}
      {tab === 'orders' ? <OrdersTab funnelId={f.id} /> : null}
      {tab === 'ads' ? <PerformanceView funnelId={f.id} /> : null}
      {tab === 'settings' ? <SettingsTab funnel={f} /> : null}
    </div>
  );
}
