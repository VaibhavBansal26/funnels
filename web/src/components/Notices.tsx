import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMutate } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';

interface Announcement { id: string; title: string; body: string; level: 'info' | 'warning' | 'critical'; dismissible: boolean }
const key = ['announcements'] as const;

/** Banners above every page: announcements from the platform, the support-access notice, and the suspension notice. */
export function Notices() {
  const { session, endSupport } = useAuth();
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ data: Announcement[] }>('/api/announcements'), refetchInterval: 5 * 60_000 });
  const dismiss = useMutate((id: string) => api.post(`/api/announcements/${id}/dismiss`), [key]);
  const imp = session?.impersonation;
  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {imp ? (
        <div className="alert" role="status" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <span><strong>Support access.</strong> You are acting as {session?.user.email} ({imp.by}).{imp.expiresAt ? ` Ends ${new Date(imp.expiresAt).toLocaleTimeString()}.` : ''} Credentials, billing, members and API keys are off limits.</span>
          <button type="button" className="btn sm" onClick={() => void endSupport()}>End session</button>
        </div>
      ) : null}
      {session?.workspace.suspended ? (
        <div className="alert error" role="alert"><strong>This account is suspended.</strong> {session.workspace.suspendedReason ? `Reason: ${session.workspace.suspendedReason}. ` : ''}Your pages are offline and changes are blocked. Contact support.</div>
      ) : null}
      {(q.data?.data ?? []).map((a) => (
        <div key={a.id} className={`alert ${a.level === 'info' ? '' : a.level === 'warning' ? 'warn' : 'error'}`} role={a.level === 'critical' ? 'alert' : 'status'} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
          <span><strong>{a.title}.</strong> {a.body}</span>
          {a.dismissible ? <button type="button" className="btn sm" aria-label={`Dismiss ${a.title}`} onClick={() => dismiss.mutate(a.id)}>Dismiss</button> : null}
        </div>
      ))}
    </div>
  );
}
