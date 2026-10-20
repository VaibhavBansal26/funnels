import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AuditRow } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner, fmtDate, Loading, TextField } from '../components/ui';

export function AuditPage() {
  const { can } = useAuth();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    enabled: can('audit:read'),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<{ data: AuditRow[]; nextCursor: string | null }>('/api/audit', { limit: 50, action: action.trim() || undefined, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (!can('audit:read')) return <div className="stack"><h1>Audit log</h1><div className="alert">You need the audit:read permission to view the audit log.</div></div>;
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="stack">
      <h1>Audit log</h1>
      <p className="muted">Who did what, newest first. Passwords and tokens are never recorded.</p>
      <TextField label="Filter by action" hint="For example role.created or auth.login" value={action} onChange={setAction} />
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={4} /> : null}
      <div className="table-wrap"><table className="table"><caption className="sr-only">Audit log</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Target</th><th scope="col">Details</th><th scope="col">IP</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td className="small">{fmtDate(r.createdAt)}</td><td><code>{r.action}</code></td><td className="small mono">{r.actorId}</td><td className="small mono">{r.target ?? ''}</td><td className="small">{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ''}</td><td className="small">{r.ip ?? ''}</td></tr>
          ))}
        </tbody></table></div>
      {q.hasNextPage ? <button type="button" className="btn" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</button> : rows.length ? <p className="muted small">End of the log.</p> : null}
    </div>
  );
}
