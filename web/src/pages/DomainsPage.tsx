import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import { keys, useDomains, useMutate } from '../api/hooks';
import type { Domain, VerifyResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, CopyButton, Empty, ErrorBanner, fmtDate, Loading, Modal, StatusBadge, TextField } from '../components/ui';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function validateHostname(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!h) return 'Enter a hostname';
  if (/^[a-z]+:\/\//.test(h) || h.includes('/')) return 'Enter only the hostname, without http:// or a path';
  if (h.includes(':')) return 'Do not include a port';
  return HOST_RE.test(h) ? null : 'Enter a valid hostname such as offers.example.com';
}

export function DnsInstructions({ d }: { d: Domain }) {
  return (
    <div className="dns-box" aria-label={`DNS records for ${d.hostname}`}>
      <p className="small" style={{ marginTop: 0 }}>Add both records at your DNS provider, then press <strong>Verify</strong>. DNS changes can take a few minutes to spread.</p>
      {[d.dns.cname, d.dns.txt].map((r) => (
        <dl key={r.type}>
          <dt>Type</dt><dd><strong>{r.type}</strong></dd><dd />
          <dt>Name</dt><dd className="mono">{r.name}</dd><dd><CopyButton text={r.name} label="Copy name" /></dd>
          <dt>Value</dt><dd className="mono">{r.value}</dd><dd><CopyButton text={r.value} label="Copy value" /></dd>
        </dl>
      ))}
    </div>
  );
}

function DomainCard({ d, canManage }: { d: Domain; canManage: boolean }) {
  const toast = useToast();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [deleting, setDeleting] = useState(false);
  const verify = useMutate(() => api.post<VerifyResult>(`/api/domains/${d.id}/verify`), [keys.domains]);
  const del = useMutate(() => api.delete(`/api/domains/${d.id}`), [keys.domains, keys.funnels]);
  const checks = result?.checks;
  return (
    <article className="card stack" aria-label={d.hostname}>
      <div className="row between">
        <div><h3 style={{ margin: 0 }}>{d.hostname}</h3><span className="muted small">{d.funnelCount} funnel{d.funnelCount === 1 ? '' : 's'} · added {fmtDate(d.createdAt)}{d.lastCheckedAt ? ` · last checked ${fmtDate(d.lastCheckedAt)}` : ''}</span></div>
        <StatusBadge status={d.status} />
      </div>
      {d.failureReason && d.status !== 'active' ? <div className="alert warn">{d.failureReason}</div> : null}
      {d.status !== 'active' ? <DnsInstructions d={d} /> : <p className="small muted">Active since {d.verifiedAt ? fmtDate(d.verifiedAt) : '—'}. Funnels set to live on this domain are served at https://{d.hostname}.</p>}
      {result?.error ? <div className="alert error" role="alert">{result.error}</div> : null}
      {checks ? (
        <ul className="small" aria-label="Verification result" style={{ margin: 0 }}>
          <li>{checks.txt.ok ? '✓' : '✗'} TXT ownership record {checks.txt.ok ? 'found' : 'not found'}</li>
          <li>{checks.cname.ok ? '✓' : '✗'} CNAME {checks.cname.ok ? 'points to our servers' : checks.cname.found.length ? `points to ${checks.cname.found.join(', ')}` : 'not found'}</li>
        </ul>
      ) : null}
      {canManage ? (
        <div className="row">
          <button type="button" className="btn primary" disabled={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: (r) => { setResult(r); toast.push(r.domain.status === 'active' ? `${d.hostname} is verified` : 'Not verified yet', r.domain.status === 'active' ? 'ok' : 'info'); }, onError: (e) => toast.push(errorMessage(e), 'error') })}>{verify.isPending ? 'Checking DNS…' : d.status === 'active' ? 'Re-verify' : 'Verify'}</button>
          <button type="button" className="btn danger right" onClick={() => setDeleting(true)}>Delete</button>
        </div>
      ) : null}
      {deleting ? (
        <ConfirmDialog danger title={`Delete ${d.hostname}?`} confirmLabel="Delete domain" busy={del.isPending}
          message={d.funnelCount ? `${d.funnelCount} funnel(s) using this domain will go back to test mode and stop being served.` : 'This cannot be undone.'}
          onCancel={() => setDeleting(false)} onConfirm={() => del.mutate(undefined, { onSuccess: () => { toast.push('Domain deleted', 'ok'); setDeleting(false); }, onError: (e) => { toast.push(errorMessage(e), 'error'); setDeleting(false); } })} />
      ) : null}
    </article>
  );
}

export function DomainsPage() {
  const q = useDomains();
  const { can } = useAuth();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutate((hostname: string) => api.post<Domain>('/api/domains', { hostname }), [keys.domains]);
  return (
    <div className="stack">
      <div className="row between"><h1>Domains</h1>{can('domains:manage') ? <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add domain</button> : null}</div>
      <p className="muted">A domain of your own is optional: a funnel can also go live on the free built-in address or a free Cloudflare Pages address (funnel Settings, Go live). Only domains whose DNS is verified can be attached to a funnel.</p>
      {!can('domains:manage') ? <div className="alert">You need the domains:manage permission to change domains. You can see their status here.</div> : null}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No domains yet">Add a domain such as offers.example.com to serve funnels on your own address.</Empty></div> : null}
      {q.data?.data.map((d) => <DomainCard key={d.id} d={d} canManage={can('domains:manage')} />)}
      {adding ? (
        <Modal title="Add domain" onClose={() => { setAdding(false); setHost(''); setError(null); }}
          footer={<><button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button><button type="button" className="btn primary" disabled={create.isPending} onClick={() => {
            const e = validateHostname(host);
            setError(e);
            if (e) return;
            create.mutate(host.trim(), { onSuccess: () => { toast.push('Domain added. Follow the DNS instructions to verify it.', 'ok'); setAdding(false); setHost(''); }, onError: (err) => setError(errorMessage(err)) });
          }}>Add domain</button></>}>
          <TextField label="Hostname" value={host} error={error ?? undefined} hint="For example offers.example.com" onChange={setHost} data-autofocus />
        </Modal>
      ) : null}
    </div>
  );
}
