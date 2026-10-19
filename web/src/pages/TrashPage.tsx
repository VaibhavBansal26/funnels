import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import { keys, useMutate, useTrash } from '../api/hooks';
import type { FunnelSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FunnelThumb } from '../components/FunnelThumb';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, Empty, ErrorBanner, fmtDate, Loading } from '../components/ui';

export function TrashPage() {
  const q = useTrash();
  const { can } = useAuth();
  const toast = useToast();
  const [purging, setPurging] = useState<FunnelSummary | null>(null);
  const restore = useMutate((id: string) => api.post(`/api/funnels/${id}/restore`), [keys.trash, keys.funnels]);
  const purge = useMutate((id: string) => api.delete(`/api/funnels/${id}/purge`), [keys.trash]);
  return (
    <div className="stack">
      <h1>Trash</h1>
      <p className="muted">Deleted funnels are kept here. Restoring brings the funnel back in test mode; purging removes it and its analytics for good.</p>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="The trash is empty">Funnels you delete will appear here.</Empty></div> : null}
      <div className="stack">
        {q.data?.data.map((f) => (
          <div key={f.id} className="card row">
            <FunnelThumb small thumb={f.thumbnail} />
            <div className="grow"><strong>{f.name}</strong><div className="muted small">Deleted {f.deletedAt ? fmtDate(f.deletedAt) : ''}</div></div>
            <button type="button" className="btn" disabled={restore.isPending} onClick={() => restore.mutate(f.id, { onSuccess: () => toast.push(`Restored "${f.name}"`, 'ok'), onError: (e) => toast.push(errorMessage(e), 'error') })}>Restore</button>
            {can('owner') ? <button type="button" className="btn danger" onClick={() => setPurging(f)}>Delete forever</button> : null}
          </div>
        ))}
      </div>
      {purging ? (
        <ConfirmDialog danger title="Delete forever?" confirmLabel="Delete forever" busy={purge.isPending} message={<>"{purging.name}", its steps, backups, leads' opt-in events and orders will be permanently removed. This cannot be undone.</>} onCancel={() => setPurging(null)}
          onConfirm={() => purge.mutate(purging.id, { onSuccess: () => { toast.push('Funnel purged', 'ok'); setPurging(null); }, onError: (e) => { toast.push(errorMessage(e), 'error'); setPurging(null); } })} />
      ) : null}
    </div>
  );
}
