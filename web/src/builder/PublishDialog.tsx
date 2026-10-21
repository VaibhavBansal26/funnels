// The builder's Publish dialog: saves the page, shows where the funnel can live (the same choices as the Go live card in funnel Settings, shared code in components/GoLive.tsx),
// goes live in one step, follows the publishing, and for a live funnel offers "Update live page" and "Take offline".
import { Rocket } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import { usePublishSettings } from '../api/growth';
import type { FunnelDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AddressChoices, FinalUrl, needsCloudflare, STATE, TEST_VS_LIVE, useGoLive } from '../components/GoLive';
import { ErrorBanner, LearnMore, Loading } from '../components/ui';
import { Badge, Button, Dialog, useToast } from '../ui';
import type { SaveState } from './panels/TopBar';

export function PublishDialog({ onClose, funnel, dirty, save, saveState, onPreview }: { onClose: () => void; funnel: FunnelDetail; dirty: boolean; save: (backup: boolean) => Promise<boolean>; saveState: SaveState; onPreview: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const g = useGoLive(funnel);
  const settings = usePublishSettings(funnel.id);
  const { q, data, state, picked, selected, finalUrl, live, offline, retry } = g;
  // Unsaved changes are saved first, when the dialog opens: what you publish is what you see in the editor.
  const [sync, setSync] = useState<'saving' | 'saved' | 'failed'>(dirty ? 'saving' : 'saved');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ error: unknown; retry: () => void } | null>(null);
  const started = useRef(false);
  // The dialog is mounted only while open, so Radix has no trigger to give the focus back to: remember the opener and refocus it on close.
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => () => { const el = opener.current; setTimeout(() => { if (el instanceof HTMLElement && el.isConnected) el.focus(); }, 0); }, []);
  const runSave = () => {
    setSync('saving');
    void save(true).then((ok) => setSync(ok ? 'saved' : 'failed'));
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (dirty) runSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Connect Cloudflare first" opens Settings in another tab: when the author comes back, look again (window focus refetching is off app-wide).
  const waitingForCloudflare = !!data?.options.some(needsCloudflare);
  const refetch = q.refetch;
  useEffect(() => {
    if (!waitingForCloudflare) return;
    const on = () => void refetch();
    window.addEventListener('focus', on);
    return () => window.removeEventListener('focus', on);
  }, [waitingForCloudflare, refetch]);

  const canPublish = can('funnels:write');
  const canDeploy = can('publishing:manage');
  const isLive = state === 'live';
  const title = isLive ? 'Publish changes' : 'Publish';
  const saveFailed = sync === 'failed';
  const ready = sync === 'saved' && !busy;
  const cloudflare = selected?.kind === 'pages' || selected?.kind === 'workers';
  const failure = settings.data?.lastError ?? settings.data?.latest?.error ?? null;

  const goLive = () => {
    if (!picked) return;
    setProblem(null);
    setDone(null);
    live.mutate(picked, {
      onSuccess: () => { setDone(picked.kind === 'pages' || picked.kind === 'workers' ? 'Publishing to Cloudflare. This can take about a minute.' : 'Your funnel is live.'); },
      onError: (e) => setProblem({ error: e, retry: goLive }),
    });
  };
  const update = async () => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    const ok = await save(true);
    if (!ok) { setSync('failed'); setBusy(false); return; }
    try {
      if (cloudflare && canDeploy) await retry.mutateAsync(undefined);
      setDone(cloudflare ? 'Saved. The live page is being updated on Cloudflare.' : 'Saved. The live page is updated.');
      toast.push('Live page updated', 'ok');
    } catch (e) {
      setProblem({ error: e, retry: () => void update() });
    } finally {
      setBusy(false);
    }
  };
  const redo = () => { setProblem(null); retry.mutate(undefined, { onSuccess: () => setDone('Deployment queued.'), onError: (e) => setProblem({ error: e, retry: redo }) }); };
  const takeOffline = () => { setProblem(null); setDone(null); offline.mutate(undefined, { onSuccess: () => { setDone('The funnel is offline again (test mode).'); toast.push('The funnel is offline again (test mode)', 'ok'); }, onError: (e) => setProblem({ error: e, retry: takeOffline }) }); };

  const pending = live.isPending || offline.isPending || retry.isPending || busy;
  const primary = !canPublish ? null : state === 'draft' ? (
    <Button variant="primary" disabled={!ready || !picked || !picked.available || pending} onClick={goLive}><Rocket aria-hidden="true" /> {live.isPending ? 'Going live…' : 'Go live'}</Button>
  ) : state === 'live' ? (
    <Button variant="primary" disabled={!ready || pending} onClick={() => void update()}>{busy ? 'Updating…' : 'Update live page'}</Button>
  ) : state === 'publishing' ? (
    <Button variant="primary" disabled>Publishing…</Button>
  ) : canDeploy ? (
    <Button variant="primary" disabled={!ready || pending} onClick={redo}>{state === 'failed' ? 'Retry' : 'Redeploy'}</Button>
  ) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="md" title={title}
      description={state === 'draft' ? 'Test mode is private to you; live is public.' : state === 'live' ? 'Update the live page with your latest changes, or take the funnel offline.' : state === 'publishing' ? 'The funnel is being published. This updates by itself.' : state === 'failed' ? 'The funnel is set live, but nothing is online yet.' : 'The funnel is paused: its address shows a paused page.'}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        {canPublish && state !== 'draft' ? <Button disabled={pending} onClick={takeOffline}>Take offline</Button> : null}
        {primary}
      </>}>
      <div className="flex flex-col gap-4 text-sm" aria-busy={q.isLoading || sync === 'saving' || pending}>
        <div className="row between">
          <p role="status" className={saveFailed ? 'small text-warn' : 'small muted'} style={{ margin: 0 }}>
            {sync === 'saving' ? (dirty ? 'You have unsaved changes: saving them first…' : 'Saving…') : saveFailed ? 'Your changes are not saved.' : 'Everything is saved.'}
          </p>
          {data ? <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge> : null}
        </div>

        {saveFailed ? (
          <div className="alert error" role="alert">
            <div className="row between"><span>{saveState.kind === 'error' ? saveState.message : 'The page could not be saved.'} Nothing was published.</span><Button size="sm" onClick={runSave}>Retry save</Button></div>
          </div>
        ) : null}

        {q.isLoading ? <Loading rows={3} /> : null}
        {!q.isLoading && !data ? <ErrorBanner error={q.error ?? new Error('The addresses could not be loaded')} onRetry={() => void q.refetch()} /> : null}

        {data && state === 'draft' ? (
          <>
            {state === 'draft' ? <LearnMore label="Test vs live"><p className="m-0">{TEST_VS_LIVE}</p></LearnMore> : null}
        <AddressChoices data={data} choice={g.choice} onChoice={g.setChoice} disabled={pending} settingsNewTab legend="Where should visitors find it?" />
            <p className="muted small">The address name, search engine setting and custom domains are in the funnel&apos;s Settings tab.</p>
          </>
        ) : null}

        {data && state !== 'draft' && selected ? (
          <p className="small" style={{ margin: 0 }}>Served on <strong>{selected.label}</strong>.</p>
        ) : null}
        {state === 'publishing' ? <div className="alert" role="status" aria-live="polite">Publishing to Cloudflare. This updates by itself when the address is reachable.</div> : null}
        {state === 'failed' ? (
          <div className="alert error" role="alert"><strong>Publishing failed.</strong> {failure ?? 'Cloudflare did not finish the deployment.'} Press Retry, or take the funnel offline.</div>
        ) : null}
        {state === 'paused' ? <div className="alert warn" role="status">The site shows a paused page. Redeploy to bring it back.</div> : null}
        {problem ? (
          <div className="alert error" role="alert">
            <div className="row between">
              <span>{errorMessage(problem.error)}{problem.error instanceof ApiError && problem.error.code && problem.error.code !== 'HTTP_ERROR' ? <span className="text-xs opacity-80"> ({problem.error.code})</span> : null}</span>
              <Button size="sm" disabled={pending} onClick={problem.retry}>Retry</Button>
            </div>
          </div>
        ) : null}
        {done && !problem ? <p role="status" aria-live="polite" className="alert ok" style={{ margin: 0 }}>{done}</p> : null}

        {finalUrl && state !== 'paused' && state !== 'failed' ? <FinalUrl url={finalUrl} state={state} /> : null}
        {!canPublish && data ? <p className="muted small">Going live needs permission to edit funnels.</p> : null}

        <div className="row"><Button size="sm" onClick={onPreview}>Open preview</Button><span className="small muted">The preview shows the saved page and counts no visit.</span></div>
      </div>
    </Dialog>
  );
}
