import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { keys, useFunnel, usePage } from '../api/hooks';
import { ErrorBanner, Loading } from '../components/ui';
import { BuilderApp } from '../builder/BuilderApp';
import { Button } from '../ui';

/** Route wrapper: loads the funnel and the page document, then mounts the editor once (it is keyed on step and saved version). */
export function BuilderPage() {
  const { id = '', stepId = '' } = useParams();
  const funnel = useFunnel(id);
  const page = usePage(id, stepId);
  const [nonce, setNonce] = useState(0);
  const qc = useQueryClient();
  const reload = useCallback(() => {
    void qc.invalidateQueries({ queryKey: keys.funnel(id) });
    qc.removeQueries({ queryKey: ['page', stepId] });
    void page.refetch().then(() => setNonce((n) => n + 1));
  }, [qc, id, stepId, page]);
  if (funnel.isLoading || page.isLoading) return <div className="grid h-dvh place-items-center p-8"><div className="w-full max-w-md"><Loading rows={4} /></div></div>;
  const error = funnel.error ?? page.error;
  if (error) return <div className="p-6"><ErrorBanner error={error} onRetry={() => { void funnel.refetch(); void page.refetch(); }} /><Link to="/funnels"><Button>Back to funnels</Button></Link></div>;
  const step = funnel.data!.steps.find((s) => s.id === stepId);
  if (!step) return <div className="p-6"><ErrorBanner error={new ApiError(404, 'NOT_FOUND', 'Step not found')} /><Link to={`/funnels/${id}/steps`}><Button>Back to steps</Button></Link></div>;
  return <BuilderApp key={`${stepId}:${page.data!.version}:${nonce}`} funnel={funnel.data!} step={step} page={page.data!} reload={reload} />;
}
