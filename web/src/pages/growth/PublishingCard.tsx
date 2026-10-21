import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorMessage } from '../../api/client';
import { growthKeys, useDeployment, useDeployments, usePublishSettings, usePublishingConnection, type DeploymentSummary, type PublishSettings } from '../../api/growth';
import { keys, useMutate } from '../../api/hooks';
import type { FunnelDetail } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, CopyButton, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../../components/ui';
import { Badge } from '../../ui';

const TONE: Record<DeploymentSummary['status'], 'ok' | 'danger' | 'warn' | 'neutral' | 'info'> = { succeeded: 'ok', failed: 'danger', queued: 'warn', building: 'info', uploading: 'info', deploying: 'info', superseded: 'neutral', rolled_back: 'neutral' };
const LABEL: Record<DeploymentSummary['status'], string> = { succeeded: 'Live', failed: 'Failed', queued: 'Queued', building: 'Building', uploading: 'Uploading', deploying: 'Deploying', superseded: 'No change', rolled_back: 'Replaced by rollback' };
const REASON: Record<DeploymentSummary['reason'], string> = { publish: 'Published', save: 'Saved change', redeploy: 'Redeploy', rollback: 'Rollback', unpublish: 'Unpublished' };

export const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;
export const validProjectName = (v: string) => (v === '' ? undefined : PROJECT_NAME.test(v) ? undefined : 'Use 2 to 58 lowercase letters, digits and hyphens, not starting or ending with a hyphen');

export function DeploymentStatus({ s }: { s: DeploymentSummary['status'] }) {
  return <Badge tone={TONE[s]}>{LABEL[s]}</Badge>;
}

function LogDialog({ funnelId, id, onClose }: { funnelId: string; id: string; onClose: () => void }) {
  const q = useDeployment(funnelId, id);
  return (
    <Modal wide title="Deployment log" onClose={onClose}>
      {q.isLoading ? <Loading rows={2} /> : null}
      <ErrorBanner error={q.error} />
      {q.data ? (
        <div className="stack">
          <p className="small">Version <span className="mono">{q.data.versionId ?? '—'}</span> · {REASON[q.data.reason]} · <DeploymentStatus s={q.data.status} /> {q.data.cloudflareDeploymentId ? <span className="muted">Cloudflare deployment <span className="mono">{q.data.cloudflareDeploymentId.slice(0, 8)}</span></span> : null}</p>
          {q.data.error ? <div className="alert error" role="alert">{q.data.error}</div> : null}
          <ol className="m-0 list-none space-y-1 p-0 font-mono text-xs" aria-label="Log lines">
            {q.data.log.length === 0 ? <li className="muted">Nothing logged yet.</li> : null}
            {q.data.log.map((l, i) => <li key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warn' : ''}><span className="muted">{new Date(l.t).toLocaleTimeString()}</span> {l.msg}</li>)}
          </ol>
        </div>
      ) : null}
    </Modal>
  );
}

function History({ funnelId, canManage, onRollback }: { funnelId: string; canManage: boolean; onRollback: (d: DeploymentSummary) => void }) {
  const q = useDeployments(funnelId, true);
  const [log, setLog] = useState<string | null>(null);
  return (
    <section aria-label="Deployment history" className="stack">
      <h3 style={{ margin: 0 }}>Deployment history</h3>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <p className="muted small">Nothing has been deployed yet.</p> : null}
      {q.data && q.data.data.length ? (
        <div className="table-wrap card flush">
          <table className="table">
            <caption className="sr-only">Deployments, newest first</caption>
            <thead><tr><th scope="col">Status</th><th scope="col">Version</th><th scope="col">What</th><th scope="col">When</th><th scope="col" className="num">Size</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {q.data.data.map((d) => (
                <tr key={d.id}>
                  <td><DeploymentStatus s={d.status} /> {d.active ? <Badge tone="primary">Current</Badge> : null}</td>
                  <td className="mono small" title="Version id: a hash of the files, headers and redirects">{d.versionId ?? '—'}</td>
                  <td className="small">{REASON[d.reason]}{d.error ? <div className="text-danger" style={{ maxWidth: 340 }}>{d.error.slice(0, 140)}</div> : null}</td>
                  <td className="small">{fmtDate(d.finishedAt ?? d.createdAt)}</td>
                  <td className="num small">{d.fileCount ? `${d.fileCount} files · ${kb(d.bytes)}` : '—'}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn sm" onClick={() => setLog(d.id)}>Log</button>
                    {canManage && d.canRollback ? <button type="button" className="btn sm" onClick={() => onRollback(d)}>Roll back</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {log ? <LogDialog funnelId={funnelId} id={log} onClose={() => setLog(null)} /> : null}
    </section>
  );
}

/** Settings > Publishing of a funnel: where it is served from, the Pages project, its domain, and the deployment history. */
export function PublishingCard({ funnel }: { funnel: FunnelDetail }) {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('publishing:manage');
  const q = usePublishSettings(funnel.id);
  const conn = usePublishingConnection(canManage);
  const [name, setName] = useState('');
  const [adopt, setAdopt] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'rollback'; d: DeploymentSummary } | { kind: 'unpublish' } | { kind: 'origin' }>(null);
  const [mode, setMode] = useState<'pause' | 'delete'>('pause');
  const refresh = [growthKeys.publish(funnel.id) as unknown as string[], growthKeys.deployments(funnel.id) as unknown as string[], keys.funnel(funnel.id) as unknown as string[]];
  const choose = useMutate((body: Record<string, unknown>) => api.put<PublishSettings>(`/api/funnels/${funnel.id}/publishing`, body), refresh);
  const redeploy = useMutate(() => api.post(`/api/funnels/${funnel.id}/publishing/redeploy`), refresh);
  const unpublish = useMutate((m: 'pause' | 'delete') => api.post(`/api/funnels/${funnel.id}/publishing/unpublish`, { mode: m }), refresh);
  const rollback = useMutate((id: string) => api.post(`/api/funnels/${funnel.id}/publishing/rollback/${id}`), refresh);
  const domain = useMutate(() => api.post(`/api/funnels/${funnel.id}/publishing/domain/refresh`), refresh);
  const s = q.data;
  const nameError = validProjectName(name);
  const needsConfirm = choose.error instanceof ApiError && choose.error.code === 'PROJECT_EXISTS';
  const fail = (e: unknown) => toast.push(errorMessage(e), 'error');

  if (q.isLoading) return <section className="card"><h2>Publishing</h2><Loading rows={2} /></section>;
  if (!s) return <section className="card"><h2>Publishing</h2><ErrorBanner error={q.error} onRetry={() => void q.refetch()} /></section>;
  const onPages = s.target !== 'origin';
  const workers = s.target === 'cloudflare-workers-assets';
  const canChoosePages = conn.data?.connected || conn.data?.platform.available;

  return (
    <section className="card stack" aria-label="Publishing">
      <div className="row between">
        <div><h2 style={{ margin: 0 }}>Publishing</h2><span className="muted small">Where visitors get this funnel from.</span></div>
        <Badge tone={onPages ? 'primary' : 'neutral'}>{workers ? 'Cloudflare Workers (experimental)' : onPages ? 'Cloudflare Pages' : 'This server'}</Badge>
      </div>
      <ErrorBanner error={q.error} />

      {!onPages ? (
        <>
          <p className="small">The funnel is served by this app{funnel.domain ? <> at <strong>{funnel.domain.hostname}</strong></> : null}. Publish it to <strong>Cloudflare Pages</strong> to serve static copies from Cloudflare&apos;s network: pages keep loading while this server is down, and forms, checkout and tracking still talk to this app.</p>
          {!canManage ? <p className="muted small">Changing where a funnel is published needs the publishing:manage permission.</p> : null}
          {canManage && conn.data && !canChoosePages ? <div className="alert">Connect your Cloudflare account first in <Link to="/settings">Settings &gt; Publishing</Link>.</div> : null}
          {canManage && canChoosePages ? (
            <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); if (nameError) return; choose.mutate({ target: 'cloudflare-pages', ...(conn.data?.connected ? { owner: 'workspace' as const } : { owner: 'platform' as const }), ...(name && conn.data?.connected ? { projectName: name } : {}), ...(adopt ? { adopt: true } : {}) }, { onSuccess: () => { toast.push('Publishing to Cloudflare Pages. The first deployment is on its way.', 'ok'); setAdopt(false); }, onError: () => undefined }); }}>
              {conn.data?.connected ? <TextField label="Pages project name" value={name} error={nameError} hint="Optional. Leave empty for an automatic name (fn-xxxxxxxx). The site will be at <name>.pages.dev." placeholder="my-offer" onChange={(v) => setName(v.toLowerCase())} /> : <p className="small muted">This installation hosts the Pages project for you.</p>}
              <ErrorBanner error={choose.error && !needsConfirm ? choose.error : null} />
              {needsConfirm ? (
                <div className="alert warn" role="alert">
                  <strong>{errorMessage(choose.error)}</strong>
                  <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />Yes, this funnel may overwrite the existing project&apos;s content</label>
                </div>
              ) : null}
              {s.funnelStatus !== 'live' ? <p className="small muted">The funnel is in test mode: the project is created now and the first deployment happens when you go live (Go live card above) on its free address or a verified domain.</p> : null}
              <div className="row"><button className="btn primary" type="submit" disabled={choose.isPending || !!nameError || (needsConfirm && !adopt)}>{choose.isPending ? 'Connecting…' : 'Publish with Cloudflare Pages'}</button></div>
            </form>
          ) : null}
        </>
      ) : (
        <>
          {s.project ? (
            <div className="stack">
              <dl className="grid small" style={{ gridTemplateColumns: 'minmax(120px, 160px) 1fr', gap: '6px 12px', margin: 0 }}>
                <dt className="muted">Pages project</dt><dd className="mono">{s.project.name}{s.owner === 'platform' ? <span className="muted"> (hosted for you)</span> : null}</dd>
                <dt className="muted">Cloudflare URL</dt><dd>{s.project.url ? <a href={s.project.url} target="_blank" rel="noopener noreferrer" className="mono inline-flex items-center gap-1">{s.project.host} <ExternalLink className="size-3" aria-hidden="true" /></a> : '—'}</dd>
                <dt className="muted">Live version</dt><dd className="mono">{s.active?.versionId ?? 'nothing deployed yet'}{s.active?.finishedAt ? <span className="muted"> · {fmtDate(s.active.finishedAt)}</span> : null}</dd>
                <dt className="muted">Custom domain</dt>
                <dd>
                  {s.customDomain ? <span className="row"><span className="mono">{s.customDomain.hostname}</span> <Badge tone={s.customDomain.status === 'active' ? 'ok' : s.customDomain.status === 'failed' ? 'danger' : 'warn'}>{s.customDomain.status ?? 'pending'}</Badge></span> : <span className="muted">{s.domain ? 'attached after the first successful deployment' : 'none: connect a domain in the General settings'}</span>}
                </dd>
              </dl>
              {s.customDomain && s.customDomain.status !== 'active' && s.customDomain.dns.value ? (
                <div className="dns-box" aria-label="DNS record for the custom domain">
                  <p className="small" style={{ marginTop: 0 }}>Point your domain at the Pages project, then press <strong>Check domain</strong>. DNS changes can take a few minutes.</p>
                  <dl>
                    <dt>Type</dt><dd><strong>CNAME</strong></dd><dd />
                    <dt>Name</dt><dd className="mono">{s.customDomain.dns.name}</dd><dd><CopyButton text={s.customDomain.dns.name} label="Copy name" /></dd>
                    <dt>Value</dt><dd className="mono">{s.customDomain.dns.value}</dd><dd><CopyButton text={s.customDomain.dns.value} label="Copy value" /></dd>
                  </dl>
                  {s.customDomain.error ? <p className="small text-danger" style={{ marginBottom: 0 }}>{s.customDomain.error}</p> : null}
                </div>
              ) : null}
            </div>
          ) : <p className="muted small">The Pages project was deleted. Choose a target again to create a new one.</p>}

          {s.constraints.needsLiveDomain ? <div className="alert warn" role="status">Nothing is deployed until the funnel is <strong>live on a verified domain</strong> (General settings).</div> : null}
          {s.constraints.domainShared ? <div className="alert error" role="alert">This domain also serves other live funnels. A Pages project serves one funnel per domain, so deployment is refused until they use their own domains.</div> : null}
          {s.hold ? <div className="alert warn" role="status">{s.paused ? 'This site is unpublished.' : 'A rollback is in place.'} Saving does not deploy while the funnel is live. Press <strong>Redeploy</strong> to publish the current state.</div> : null}
          {s.paused && !s.hold ? <div className="alert" role="status">The site shows a paused page because the funnel is not live. It is published again when the funnel goes live.</div> : null}
          {s.latest?.status === 'failed' && s.latest.error ? <div className="alert error" role="alert"><strong>The latest deployment failed.</strong> {s.latest.error}</div> : null}
          {s.inFlight && s.latest ? <div className="alert" role="status" aria-live="polite">Deploying: <DeploymentStatus s={s.latest.status} />. This page updates by itself.</div> : null}

          {canManage ? (
            <div className="row">
              <button type="button" className="btn primary" disabled={redeploy.isPending || s.inFlight || !s.project} onClick={() => redeploy.mutate(undefined, { onSuccess: () => toast.push('Deployment queued', 'ok'), onError: fail })}>Redeploy</button>
              <button type="button" className="btn" disabled={domain.isPending || !s.project} onClick={() => domain.mutate(undefined, { onSuccess: () => toast.push('Domain status updated', 'ok'), onError: fail })}>Check domain</button>
              <button type="button" className="btn" disabled={!s.project} onClick={() => setConfirm({ kind: 'unpublish' })}>Unpublish…</button>
              <button type="button" className="btn ghost right" onClick={() => setConfirm({ kind: 'origin' })}>Serve from this server instead</button>
            </div>
          ) : <p className="muted small">Deploying and rolling back need the publishing:manage permission.</p>}
          {s.project ? <History funnelId={funnel.id} canManage={canManage} onRollback={(d) => setConfirm({ kind: 'rollback', d })} /> : null}
        </>
      )}

      {confirm?.kind === 'rollback' ? (
        <ConfirmDialog title="Roll back to this version?" confirmLabel="Roll back" busy={rollback.isPending}
          message={<>Version <span className="mono">{confirm.d.versionId}</span> becomes the live site on Cloudflare. Your funnel here is not changed, and <strong>saving will not deploy</strong> until you press Redeploy.</>}
          onCancel={() => setConfirm(null)} onConfirm={() => rollback.mutate(confirm.d.id, { onSuccess: () => { toast.push('Rolled back', 'ok'); setConfirm(null); }, onError: (e) => { fail(e); setConfirm(null); } })} />
      ) : null}
      {confirm?.kind === 'unpublish' ? (
        <Modal title="Unpublish from Cloudflare Pages" onClose={() => setConfirm(null)}
          footer={<><button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className={`btn ${mode === 'delete' ? 'danger' : 'primary'}`} disabled={unpublish.isPending} onClick={() => unpublish.mutate(mode, { onSuccess: () => { toast.push(mode === 'delete' ? 'Project deleted' : 'Site paused', 'ok'); setConfirm(null); }, onError: (e) => { fail(e); setConfirm(null); } })}>{mode === 'delete' ? 'Delete the project' : 'Pause the site'}</button></>}>
          <div className="stack">
            <label className="check"><input type="radio" name="unpub" checked={mode === 'pause'} onChange={() => setMode('pause')} /><span><strong>Replace with a paused page</strong><br /><span className="muted small">Every address shows a &quot;not available&quot; page and is not indexed. The custom domain is removed from the project. Redeploy brings the funnel back.</span></span></label>
            <label className="check"><input type="radio" name="unpub" checked={mode === 'delete'} onChange={() => setMode('delete')} /><span><strong>Delete the Pages project</strong><br /><span className="muted small">Removes the project and all its deployments from Cloudflare (only when this app created it; otherwise the site is paused). Cannot be undone.</span></span></label>
          </div>
        </Modal>
      ) : null}
      {confirm?.kind === 'origin' ? (
        <Modal title="Serve from this server instead" onClose={() => setConfirm(null)}
          footer={<><button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="btn primary" disabled={choose.isPending} onClick={() => choose.mutate({ target: 'origin', leave: mode === 'delete' ? 'delete' : 'pause' }, { onSuccess: () => { toast.push('Now served from this server', 'ok'); setConfirm(null); }, onError: (e) => { fail(e); setConfirm(null); } })}>Switch</button></>}>
          <div className="stack">
            <p>Point your domain&apos;s DNS back at this server (<span className="mono">CNAME</span> to the address on the Domains page). What should happen to the site on Cloudflare?</p>
            <label className="check"><input type="radio" name="leave" checked={mode === 'pause'} onChange={() => setMode('pause')} />Replace it with a paused page</label>
            <label className="check"><input type="radio" name="leave" checked={mode === 'delete'} onChange={() => setMode('delete')} />Delete the Pages project (if this app created it)</label>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
