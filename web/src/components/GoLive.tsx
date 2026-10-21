import { ExternalLink, Globe, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { goLiveKey, useAddresses, type AddressOption, type PublishState } from '../api/golive';
import { growthKeys } from '../api/growth';
import { keys, useMutate } from '../api/hooks';
import type { FunnelDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../ui';
import { useToast } from './Toasts';
import { CopyButton, ErrorBanner, Loading } from './ui';

const STATE: Record<PublishState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  draft: { label: 'Test mode', tone: 'neutral' },
  publishing: { label: 'Publishing…', tone: 'info' },
  live: { label: 'Live', tone: 'ok' },
  failed: { label: 'Publishing failed', tone: 'danger' },
  paused: { label: 'Paused', tone: 'warn' },
};

export const optionKey = (o: AddressOption) => `${o.kind}:${o.domainId ?? ''}`;

/** The one place to publish a funnel: pick where it lives, see the final URL, go live, copy, open. */
export function GoLivePanel({ funnel, onDone }: { funnel: FunnelDetail; onDone?: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const q = useAddresses(funnel.id);
  const [choice, setChoice] = useState<string | null>(null);
  const refresh = [goLiveKey(funnel.id) as unknown as string[], keys.funnel(funnel.id) as unknown as string[], keys.funnels as unknown as string[], growthKeys.publish(funnel.id) as unknown as string[], growthKeys.deployments(funnel.id) as unknown as string[]];
  const live = useMutate((o: AddressOption) => api.post(`/api/funnels/${funnel.id}/go-live`, { address: { kind: o.kind, ...(o.domainId ? { domainId: o.domainId } : {}) } }), refresh);
  const offline = useMutate(() => api.patch(`/api/funnels/${funnel.id}`, { status: 'test' }), refresh);
  const retry = useMutate(() => api.post(`/api/funnels/${funnel.id}/publishing/redeploy`), refresh);

  const data = q.data;
  useEffect(() => {
    if (!data || choice) return;
    const sel = data.options.find((o) => o.selected) ?? data.options.find((o) => o.available);
    if (sel) setChoice(optionKey(sel));
  }, [data, choice]);

  if (q.isLoading) return <Loading rows={2} />;
  if (!data) return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />;
  const state = data.state;
  const selected = data.options.find((o) => o.selected);
  const picked = data.options.find((o) => optionKey(o) === choice) ?? selected ?? null;
  const canPublish = can('funnels:write');
  const fail = (e: unknown) => toast.push(errorMessage(e), 'error');
  const finalUrl = state === 'draft' ? picked?.url : selected?.url ?? picked?.url;
  const noOptions = data.options.every((o) => !o.available);

  return (
    <section className="stack" aria-label="Go live">
      <div className="row between">
        <div>
          <h2 style={{ margin: 0 }}>Go live</h2>
          <span className="muted small">Choose where visitors will find this funnel.</span>
        </div>
        <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
      </div>

      {state === 'draft' ? (
        <div className="alert" role="note">
          <strong>Test vs live.</strong> In test mode only people with your preview link can open the funnel, and nothing is counted. When it is live, anyone with the address can open it and visits, leads and orders are recorded. You can take it offline again at any time.
        </div>
      ) : null}

      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Address</legend>
        {data.options.map((o) => (
          <label key={optionKey(o)} className={`check card flush ${o.available ? '' : 'opacity-60'}`} style={{ padding: 12, alignItems: 'flex-start' }}>
            <input type="radio" name="address" checked={choice === optionKey(o)} disabled={!o.available || state === 'publishing'} onChange={() => setChoice(optionKey(o))} />
            <span className="min-w-0">
              <strong>{o.label}</strong>{o.selected ? <> <Badge tone="primary">In use</Badge></> : null}
              <br />
              {o.url ? <span className="mono small break-all">{o.url}</span> : <span className="muted small">{o.kind === 'pages' ? 'Created when you go live (name.pages.dev)' : o.kind === 'workers' ? 'Created when you go live (name.account.workers.dev)' : '—'}</span>}
              {!o.available && o.reason ? <><br /><span className="small text-warn">{o.reason}</span></> : null}
              {o.kind === 'pages' && o.available ? <><br /><span className="muted small">Free. Served by Cloudflare; Cloudflare allows 100 Pages projects per account (one per funnel). The first publish takes about a minute.</span></> : null}
              {o.kind === 'workers' && o.available ? <><br /><span className="muted small">Experimental: not yet checked against real Cloudflare. Needs a workers.dev subdomain on your Cloudflare account and the token permission Workers Scripts: Edit.</span></> : null}
              {o.kind === 'custom' ? <><br /><span className="muted small">Your own domain.</span></> : null}
            </span>
          </label>
        ))}
        {noOptions ? <p className="small muted">No address is ready yet. <Link to="/settings">Connect Cloudflare</Link> (free) or <Link to="/domains">add a domain</Link>.</p> : null}
      </fieldset>

      {state === 'failed' ? (
        <div className="alert error" role="alert"><strong>Publishing failed.</strong> The funnel is set live but Cloudflare did not finish the deployment. See the log under Publishing below, then try again.</div>
      ) : null}
      {state === 'paused' ? <div className="alert warn" role="status">The site shows a paused page. Redeploy it from Publishing below to bring it back.</div> : null}
      {state === 'publishing' ? <div className="alert" role="status" aria-live="polite">Publishing to Cloudflare. This page updates by itself when the address is reachable.</div> : null}
      <ErrorBanner error={live.error ?? offline.error ?? retry.error} />

      {finalUrl && (state === 'live' || state === 'draft' || state === 'publishing') ? (
        <div className="dns-box" aria-label="Final address">
          <p className="small" style={{ marginTop: 0 }}>{state === 'draft' ? 'The funnel will be reachable at' : state === 'publishing' ? 'It will be reachable at' : 'Your funnel is live at'}</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="mono break-all" data-testid="final-url">{finalUrl}</span>
            <CopyButton text={finalUrl} label="Copy link" />
            {state === 'live' ? <a className="btn sm" href={finalUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" aria-hidden="true" /> Open</a> : null}
          </div>
        </div>
      ) : null}

      {canPublish ? (
        <div className="row">
          {state === 'draft' ? (
            <button type="button" className="btn primary" disabled={!picked || !picked.available || live.isPending} onClick={() => picked && live.mutate(picked, { onSuccess: () => { toast.push(picked.kind === 'pages' ? 'Publishing to Cloudflare Pages…' : 'The funnel is live', 'ok'); onDone?.(); }, onError: (e) => { if (!(e instanceof ApiError)) fail(e); } })}>
              <Rocket className="size-4" aria-hidden="true" /> {live.isPending ? 'Going live…' : 'Go live'}
            </button>
          ) : null}
          {state === 'failed' || state === 'paused' ? <button type="button" className="btn primary" disabled={retry.isPending} onClick={() => retry.mutate(undefined, { onSuccess: () => toast.push('Deployment queued', 'ok'), onError: fail })}>{state === 'failed' ? 'Try again' : 'Redeploy'}</button> : null}
          {state !== 'draft' ? (
            <button type="button" className="btn" disabled={offline.isPending} onClick={() => offline.mutate(undefined, { onSuccess: () => toast.push('The funnel is offline again (test mode)', 'ok'), onError: fail })}>
              <Globe className="size-4" aria-hidden="true" /> Take offline
            </button>
          ) : null}
        </div>
      ) : <p className="muted small">Going live needs permission to edit funnels.</p>}
    </section>
  );
}
