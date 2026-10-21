import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useMutate } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Loading, TextField } from '../components/ui';
import { Link } from 'react-router';
import { SecurityCard } from './settings/SecurityCard';
import { TeamSection } from './settings/TeamSection';
import { ApiAccess } from './settings/ApiAccess';
import { Billing } from './settings/Billing';
import { Payments } from './settings/Payments';
import { useToast } from '../components/Toasts';
import { ConnectionCard } from './growth/ConnectionCard';
import { WorkspaceTracking } from './growth/TrackingCards';
import { GoogleReviewsCard } from './settings/GoogleReviews';

function WorkspaceCard() {
  const { session, can, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(session?.workspace.name ?? '');
  const [scripts, setScripts] = useState(session?.workspace.allowCustomScripts ?? false);
  useEffect(() => { setName(session?.workspace.name ?? ''); setScripts(session?.workspace.allowCustomScripts ?? false); }, [session]);
  const save = useMutate(() => api.patch('/api/workspace', { name: name.trim(), allowCustomScripts: scripts }));
  const owner = can('workspace:manage');
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: async () => { await refresh(); toast.push('Workspace saved', 'ok'); } }); }}>
      <h2>Workspace</h2>
      <ErrorBanner error={save.error} />
      <TextField label="Workspace name" value={name} onChange={setName} disabled={!owner} error={owner && !name.trim() ? 'Enter a name' : undefined} />
      <label className="check"><input type="checkbox" checked={scripts} disabled={!owner} onChange={(e) => setScripts(e.target.checked)} />Allow custom scripts</label>
      <p className="muted small">When on, header/footer tracking codes are published, and custom HTML blocks saved by the owner may contain scripts. When off, scripts and event handlers are always stripped.</p>
      {owner ? <button className="btn primary" type="submit" disabled={save.isPending || !name.trim()}>Save</button> : <p className="muted small">You need the workspace:manage permission to change workspace settings.</p>}
    </form>
  );
}

function AiUsage() {
  const q = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.get<{ provider: string; dailyCap: number; usedToday: number }>('/api/ai/status') });
  return (
    <section className="card" aria-label="AI usage">
      <h2>AI assistant</h2>
      {q.isLoading ? <Loading rows={1} /> : null}
      <ErrorBanner error={q.error} />
      {q.data ? (
        <>
          <p>Provider: <strong>{q.data.provider === 'anthropic' ? 'Anthropic model' : 'Built-in offline writer'}</strong></p>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={q.data.dailyCap} aria-valuenow={q.data.usedToday} aria-label="AI requests used today"><span style={{ width: `${q.data.dailyCap ? Math.min(100, (q.data.usedToday / q.data.dailyCap) * 100) : 100}%` }} /></div>
          <p className="muted small">{q.data.usedToday} of {q.data.dailyCap} requests used today (UTC day).</p>
        </>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  const { session, can } = useAuth();
  const sections: { id: string; label: string; show: boolean; node: ReactNode }[] = [
    { id: 'workspace', label: 'Workspace', show: true, node: <WorkspaceCard /> },
    { id: 'security', label: 'Security', show: true, node: <SecurityCard /> },
    { id: 'team', label: 'Team and roles', show: can('members:read'), node: <TeamSection /> },
    { id: 'billing', label: 'Plan', show: can('billing:read'), node: <Billing /> },
    { id: 'payments', label: 'Payments', show: can('products:read'), node: <Payments /> },
    { id: 'publishing', label: 'Publishing', show: can('publishing:manage'), node: <ConnectionCard /> },
    { id: 'tracking', label: 'Tracking', show: can('funnels:read'), node: <WorkspaceTracking /> },
    { id: 'reviews', label: 'Google reviews', show: can('integrations:manage'), node: <GoogleReviewsCard /> },
    { id: 'api', label: 'API access', show: true, node: <ApiAccess /> },
    { id: 'ai', label: 'AI assistant', show: can('ai:use'), node: <AiUsage /> },
  ].filter((x) => x.show);
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1>Settings</h1>
        <p className="mt-1.5 mb-0 text-muted">Signed in as {session?.user.email} ({session?.user.roleName}).{can('audit:read') ? <> <Link to="/audit">Audit log</Link></> : null}</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-24 m-0 flex list-none flex-col gap-0.5 p-0">
            {sections.map((x) => <li key={x.id}><a href={`#${x.id}`} className="block rounded-lg px-3 py-1.5 text-sm text-muted no-underline transition-colors hover:bg-surface-2 hover:text-fg">{x.label}</a></li>)}
          </ul>
        </nav>
        <div className="flex max-w-4xl flex-col gap-8">
          {sections.map((x) => <div key={x.id} id={x.id} className="scroll-mt-24">{x.node}</div>)}
        </div>
      </div>
    </div>
  );
}
