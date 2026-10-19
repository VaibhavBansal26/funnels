import { useState } from 'react';
import type { PageDocument } from '@blocks';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useBackups, useMutate } from '../api/hooks';
import { PreviewFrame } from '../components/PreviewFrame';
import { Empty, ErrorBanner, fmtDate, Loading, Modal } from '../components/ui';

/** Version history: the last 10 backups of the step, with a preview and one-click restore (which itself backs up the current version). */
export function HistoryDrawer({ funnelId, stepId, stepName, dirty, onClose, onRestored }: { funnelId: string; stepId: string; stepName: string; dirty: boolean; onClose: () => void; onRestored: () => void }) {
  const list = useBackups(funnelId, stepId);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['backup', selected], enabled: !!selected, queryFn: () => api.get<{ doc: PageDocument }>(`/api/funnels/${funnelId}/steps/${stepId}/backups/${selected}`) });
  const restore = useMutate((id: string) => api.post(`/api/funnels/${funnelId}/steps/${stepId}/backups/${id}/restore`), [['backups', stepId]]);
  return (
    <Modal side title="Version history" onClose={onClose}>
      <p className="muted small">Each save keeps the version it replaced. The newest 10 are kept.</p>
      {dirty ? <div className="alert warn" role="status">You have unsaved changes. Restoring replaces them.</div> : null}
      <ErrorBanner error={list.error ?? restore.error} onRetry={() => void list.refetch()} />
      {list.isLoading ? <Loading rows={2} /> : null}
      {list.data && list.data.data.length === 0 ? <Empty title="No versions yet">Versions appear after you save.</Empty> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
        {list.data?.data.map((b, i) => (
          <li key={b.id} className="card">
            <div className="row between"><strong>{b.label}</strong><span className="muted small">{fmtDate(b.createdAt)}</span></div>
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn sm" aria-expanded={selected === b.id} onClick={() => setSelected(selected === b.id ? null : b.id)}>{selected === b.id ? 'Hide preview' : 'Preview'}</button>
              <button type="button" className="btn sm primary" disabled={restore.isPending} onClick={() => restore.mutate(b.id, { onSuccess: onRestored })}>Restore{i === 0 ? ' latest' : ''}</button>
            </div>
            {selected === b.id ? (detail.isLoading ? <Loading rows={1} /> : detail.data ? <div style={{ marginTop: 8 }}><PreviewFrame doc={detail.data.doc} title={`${stepName} (${b.label})`} device="mobile" height={320} /></div> : <ErrorBanner error={detail.error} />) : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
