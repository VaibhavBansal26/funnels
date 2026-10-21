import { Navigate, NavLink, useParams } from 'react-router';
import { useAuth } from '../../auth/AuthContext';
import { AttributionView, PerformanceView } from './AdsReports';
import { IntegrationsView } from './IntegrationsView';
import { SpendView } from './SpendView';

const TABS = [
  { id: 'performance', label: 'Performance' },
  { id: 'attribution', label: 'Attribution' },
  { id: 'spend', label: 'Ad spend' },
  { id: 'integrations', label: 'Integrations', gate: 'integrations:manage' as const },
];

export function AdsPage() {
  const { tab } = useParams();
  const { can } = useAuth();
  const tabs = TABS.filter((t) => !t.gate || can(t.gate));
  if (!tab || !tabs.some((t) => t.id === tab)) return <Navigate to="/ads/performance" replace />;
  return (
    <div className="stack">
      <h1>Ads</h1>
      <nav className="tabs" aria-label="Ads sections">{tabs.map((t) => <NavLink key={t.id} to={`/ads/${t.id}`}>{t.label}</NavLink>)}</nav>
      {tab === 'performance' ? <PerformanceView /> : null}
      {tab === 'attribution' ? <AttributionView /> : null}
      {tab === 'spend' ? <SpendView /> : null}
      {tab === 'integrations' ? <IntegrationsView /> : null}
    </div>
  );
}
