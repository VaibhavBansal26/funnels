import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { useMutate } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, Loading, TextField } from '../components/ui';
import { Link } from 'react-router';
import { SecurityCard } from './settings/SecurityCard';
import { TeamSection } from './settings/TeamSection';
import { ApiAccess } from './settings/ApiAccess';
import { useToast } from '../components/Toasts';

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
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <h1>Settings</h1>
      <p className="muted">Signed in as {session?.user.email} ({session?.user.roleName}).{can('audit:read') ? <> <Link to="/audit">Audit log</Link></> : null}</p>
      <WorkspaceCard />
      <SecurityCard />
      {can('members:read') ? <TeamSection /> : null}
      <ApiAccess />
      {can('ai:use') ? <AiUsage /> : null}
    </div>
  );
}
