import { ExternalLink, Globe, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { goLiveKey, useAddresses, type AddressOption, type AddressOptions, type PublishState } from '../api/golive';
import { growthKeys } from '../api/growth';
import { keys, useMutate } from '../api/hooks';
import type { FunnelDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../ui';
import { useToast } from './Toasts';
import { CopyButton, ErrorBanner, LearnMore, Loading, TextField } from './ui';

export const STATE: Record<PublishState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  draft: { label: 'Test mode', tone: 'neutral' },
  publishing: { label: 'Publishing…', tone: 'info' },
  live: { label: 'Live', tone: 'ok' },
  failed: { label: 'Publishing failed', tone: 'danger' },
  paused: { label: 'Paused', tone: 'warn' },
};

/** One sentence that explains test mode against live; the same words everywhere. */
export const TEST_VS_LIVE = 'In test mode only people with your preview link can open the funnel and nothing is counted; once it is live, anyone with the address can open it and visits, leads and orders are recorded.';

const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
export const optionKey = (o: AddressOption) => `${o.kind}:${o.domainId ?? ''}`;
/** A Cloudflare address that is unavailable only because no Cloudflare account is connected yet. */
export const needsCloudflare = (o: AddressOption) => (o.kind === 'pages' || o.kind === 'workers') && !o.available && !!o.reason && /Connect a Cloudflare/.test(o.reason);

/**
 * All the state and actions of going live, shared by the Go live card (funnel Settings) and the builder's Publish dialog so the business logic exists once:
 * the address options, the chosen address, the final URL and the go-live, take-offline, retry and settings calls.
 */
export function useGoLive(funnel: { id: string }) {
  const q = useAddresses(funnel.id);
  const [choice, setChoice] = useState<string | null>(null);
  const refresh = [goLiveKey(funnel.id) as unknown as string[], keys.funnel(funnel.id) as unknown as string[], keys.funnels as unknown as string[], growthKeys.publish(funnel.id) as unknown as string[], growthKeys.deployments(funnel.id) as unknown as string[]];
  const live = useMutate((o: AddressOption) => api.post(`/api/funnels/${funnel.id}/go-live`, { address: { kind: o.kind, ...(o.domainId ? { domainId: o.domainId } : {}) } }), refresh);
  const offline = useMutate(() => api.patch(`/api/funnels/${funnel.id}`, { status: 'test' }), refresh);
  const retry = useMutate(() => api.post(`/api/funnels/${funnel.id}/publishing/redeploy`), refresh);
  const tweak = useMutate((body: Record<string, unknown>) => api.patch(`/api/funnels/${funnel.id}`, body), refresh);
  const data = q.data;
  useEffect(() => {
    if (!data || choice) return;
    // Nothing configured yet: the free built-in address comes first in the list and is the default.
    const sel = data.options.find((o) => o.selected) ?? data.options.find((o) => o.available);
    if (sel) setChoice(optionKey(sel));
  }, [data, choice]);
  const selected = data?.options.find((o) => o.selected);
  const picked = data?.options.find((o) => optionKey(o) === choice) ?? selected ?? null;
  const state = data?.state ?? 'draft';
  const finalUrl = (state === 'draft' ? picked?.url : selected?.url ?? picked?.url) ?? null;
  return { q, data, state, choice, setChoice, selected, picked, finalUrl, live, offline, retry, tweak };
}
export type GoLive = ReturnType<typeof useGoLive>;

/** The radio list of addresses with the real final URL of each, what is missing and the notes on the free Cloudflare options. */
export function AddressChoices({ data, choice, onChoice, disabled, settingsNewTab, legend = 'Address' }: { data: AddressOptions; choice: string | null; onChoice: (key: string) => void; disabled?: boolean; settingsNewTab?: boolean; legend?: string }) {
  const noOptions = data.options.every((o) => !o.available);
  const link = settingsNewTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label">{legend}</legend>
      {data.options.map((o) => (
        <label key={optionKey(o)} className="check card flush" style={{ padding: 12, alignItems: 'flex-start' }}>
          <input type="radio" name="address" checked={choice === optionKey(o)} disabled={!o.available || disabled} onChange={() => onChoice(optionKey(o))} />
          <span className="min-w-0">
            <span className={o.available ? undefined : 'opacity-70'}>
              <strong>{o.label}</strong>{o.kind === 'workers' ? <> <Badge tone="warn">Experimental</Badge></> : null}{o.selected ? <> <Badge tone="primary">In use</Badge></> : null}
              <br />
              {o.url ? <span className="mono small break-all">{o.url}</span> : <span className="muted small">{o.kind === 'pages' ? 'Created when you go live (name.pages.dev)' : o.kind === 'workers' ? 'Created when you go live (name.account.workers.dev)' : '—'}</span>}
            </span>
            {o.kind === 'pages' && needsCloudflare(o) ? <><br /><span className="small"><strong>Connect Cloudflare first.</strong> Open <Link to="/settings" {...link}>Settings, Publishing card</Link> and add an API token with the <strong>Cloudflare Pages: Edit</strong> permission.</span></> : null}
            {!o.available && o.reason && !(o.kind === 'pages' && needsCloudflare(o)) ? <><br /><span className="small text-warn">{o.reason}</span></> : null}
          </span>
        </label>
      ))}
      <LearnMore label="About these addresses">
        <p className="m-0"><strong className="font-medium text-fg">Built-in:</strong> free, no account and no DNS needed; a custom domain looks more professional.</p>
        <p className="m-0"><strong className="font-medium text-fg">Cloudflare Pages:</strong> free, served by Cloudflare. Connecting takes about two minutes: your Cloudflare Account id and an API token, in Settings. Cloudflare allows 100 Pages projects per account (one per funnel) and the first publish takes about a minute.</p>
        <p className="m-0"><strong className="font-medium text-fg">Cloudflare Workers (experimental):</strong> not yet checked against real Cloudflare. Needs a workers.dev subdomain on your account and the token permission Workers Scripts: Edit.</p>
        <p className="m-0"><strong className="font-medium text-fg">Your own domain:</strong> add and verify it on the Domains page.</p>
      </LearnMore>
      {noOptions ? <p className="small muted">No address is ready yet. <Link to="/settings" {...link}>Connect Cloudflare</Link> (free) or <Link to="/domains" {...link}>add a domain</Link>.</p> : null}
    </fieldset>
  );
}

/** The final address with Copy and, once live, Open. */
export function FinalUrl({ url, state }: { url: string; state: PublishState }) {
  return (
    <div className="dns-box" role="group" aria-label="Final address">
      <p className="small" style={{ marginTop: 0 }}>{state === 'draft' ? 'The funnel will be reachable at' : state === 'publishing' ? 'It will be reachable at' : 'Your funnel is live at'}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="mono break-all" data-testid="final-url">{url}</span>
        <CopyButton text={url} label="Copy link" />
        {state === 'live' ? <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" aria-hidden="true" /> Open</a> : null}
      </div>
    </div>
  );
}

/** Name of the built-in address and the search-engine switch. */
export function BuiltinSettings({ data, tweak }: { data: AddressOptions; tweak: GoLive['tweak'] }) {
  const toast = useToast();
  const [slug, setSlug] = useState<string | null>(null);
  const b = data.builtin;
  if (!b) return null;
  return (
    <div className="stack" aria-label="Built-in address settings">
      <TextField label="Address name" value={slug ?? b.funnelSlug} hint={`The last part of ${b.base.replace(b.funnelSlug, '<name>')}. Changing it moves the address.`} error={slug !== null && !SLUG.test(slug) ? 'Use 1 to 40 lower-case letters, digits and single hyphens' : undefined} onChange={(v) => setSlug(v.toLowerCase())} />
      <div className="row">
        <button type="button" className="btn sm" disabled={slug === null || slug === b.funnelSlug || !SLUG.test(slug) || tweak.isPending} onClick={() => tweak.mutate({ public_slug: slug }, { onSuccess: () => { setSlug(null); toast.push('Address name changed', 'ok'); }, onError: () => undefined })}>Save name</button>
        <label className="check"><input type="checkbox" checked={b.allowIndexing} disabled={tweak.isPending} onChange={(e) => tweak.mutate({ allow_indexing: e.target.checked }, { onError: () => undefined })} />Let search engines index this address</label>
      </div>
      <LearnMore label="About search engines"><p className="m-0">Built-in addresses are hidden from search engines by default. They are free and need no DNS; a custom domain looks more professional. Renaming the funnel does not change the address name; changing it moves the address and the old one stops working.</p></LearnMore>
    </div>
  );
}

/** The one place to publish a funnel: pick where it lives, see the final URL, go live, copy, open. */
export function GoLivePanel({ funnel, onDone }: { funnel: FunnelDetail; onDone?: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const g = useGoLive(funnel);
  const { q, data, state, picked, finalUrl, live, offline, retry, tweak } = g;

  if (q.isLoading) return <Loading rows={2} />;
  if (!data) return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />;
  const canPublish = can('funnels:write');
  const fail = (e: unknown) => toast.push(errorMessage(e), 'error');

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
          <strong>Test vs live.</strong> Test mode is private to you; live is public.
          <LearnMore className="mt-1"><p className="m-0">{TEST_VS_LIVE} You can take it offline again at any time.</p></LearnMore>
        </div>
      ) : null}

      <AddressChoices data={data} choice={g.choice} onChoice={g.setChoice} disabled={state === 'publishing'} />

      {picked?.kind === 'builtin' && data.builtin ? <BuiltinSettings data={data} tweak={tweak} /> : null}

      {state === 'failed' ? (
        <div className="alert error" role="alert"><strong>Publishing failed.</strong> The funnel is set live but Cloudflare did not finish the deployment. See the log under Publishing below, then try again.</div>
      ) : null}
      {state === 'paused' ? <div className="alert warn" role="status">The site shows a paused page. Redeploy it from Publishing below to bring it back.</div> : null}
      {state === 'publishing' ? <div className="alert" role="status" aria-live="polite">Publishing to Cloudflare. This page updates by itself when the address is reachable.</div> : null}
      <ErrorBanner error={live.error ?? offline.error ?? retry.error ?? tweak.error} />

      {finalUrl && (state === 'live' || state === 'draft' || state === 'publishing') ? <FinalUrl url={finalUrl} state={state} /> : null}

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
