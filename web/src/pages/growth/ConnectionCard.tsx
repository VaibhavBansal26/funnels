import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { growthKeys, usePublishingConnection } from '../../api/growth';
import { useMutate } from '../../api/hooks';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, ErrorBanner, fmtDate, Loading, TextField } from '../../components/ui';
import { Badge } from '../../ui';

export const ACCOUNT_ID = /^[a-fA-F0-9]{32}$/;
export const accountProblem = (v: string) => (v.trim() === '' || ACCOUNT_ID.test(v.trim()) ? undefined : 'The account id is 32 hexadecimal characters (Cloudflare dashboard > Workers & Pages, right-hand column)');
export const tokenProblem = (v: string) => (v === '' ? undefined : v.trim().length < 20 ? 'The API token looks too short' : /\s/.test(v.trim()) ? 'The token has no spaces' : undefined);

/** Settings > Publishing: the workspace's Cloudflare account for publishing funnels to Pages. */
export function ConnectionCard() {
  const q = usePublishingConnection();
  const toast = useToast();
  const [accountId, setAccountId] = useState('');
  const [token, setToken] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const refresh = [growthKeys.connection as unknown as string[]];
  const connect = useMutate(() => api.put('/api/publishing/connection', { accountId: accountId.trim(), token: token.trim() }), refresh);
  const verify = useMutate(() => api.post<{ ok: boolean; error: string | null }>('/api/publishing/connection/verify'), refresh);
  const disconnect = useMutate((force: boolean) => api.delete(`/api/publishing/connection${force ? '?force=true' : ''}`), refresh);
  const a = accountProblem(accountId);
  const t = tokenProblem(token);
  const c = q.data;
  return (
    <section className="card stack" aria-label="Publishing">
      <div className="row between"><div><h2 style={{ margin: 0 }}>Publishing</h2><span className="muted small">Publish funnels to Cloudflare Pages with your own Cloudflare account.</span></div>{c ? <Badge tone={c.connected ? (c.status === 'invalid' ? 'danger' : 'ok') : 'neutral'}>{c.connected ? (c.status === 'invalid' ? 'Token rejected' : 'Connected') : 'Not connected'}</Badge> : null}</div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={1} /> : null}
      {c?.connected ? (
        <div className="stack">
          <dl className="grid small" style={{ gridTemplateColumns: 'minmax(120px, 160px) 1fr', gap: '6px 12px', margin: 0 }}>
            <dt className="muted">Account id</dt><dd className="mono">{c.accountId}</dd>
            <dt className="muted">API token</dt><dd className="mono">{c.tokenHint}</dd>
            <dt className="muted">Last checked</dt><dd>{c.verifiedAt ? fmtDate(c.verifiedAt) : '—'}</dd>
          </dl>
          {c.lastError ? <div className="alert error" role="alert">{c.lastError}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: (r) => toast.push(r.ok ? 'The token works' : 'The token was rejected', r.ok ? 'ok' : 'error'), onError: (e) => toast.push(errorMessage(e), 'error') })}>{verify.isPending ? 'Checking…' : 'Verify token'}</button>
            <button type="button" className="btn danger" onClick={() => setDisconnecting(true)}>Disconnect</button>
          </div>
        </div>
      ) : null}
      {c && !c.connected ? (
        <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); if (!a && !t && accountId && token) connect.mutate(undefined, { onSuccess: () => { setToken(''); setAccountId(''); toast.push('Cloudflare connected', 'ok'); } }); }}>
          <ol className="small stack" style={{ margin: 0, paddingLeft: 18 }}>
            <li><strong>Account id:</strong> in the Cloudflare dashboard open <strong>Workers &amp; Pages</strong> in the left sidebar; the <strong>Account ID</strong> (32 letters and digits) is in the right-hand column.</li>
            <li><strong>API token:</strong> profile icon &gt; <strong>My Profile</strong> &gt; <strong>API Tokens</strong> &gt; <strong>Create Token</strong> &gt; <strong>Create Custom Token</strong>. Permissions: <strong>Account | Cloudflare Pages | Edit</strong> and <strong>Account | Account Settings | Read</strong> (for the experimental Workers option also <strong>Account | Workers Scripts | Edit</strong>). Account resources: include your account only.</li>
            <li>Paste both below. The app checks them with a read-only request, stores the token encrypted, and shows only its last four characters afterwards. Never share the token anywhere else. Step-by-step guide: docs/CLOUDFLARE-SETUP.md.</li>
          </ol>
          <ErrorBanner error={connect.error} />
          <TextField label="Account id" value={accountId} error={a} placeholder="0123456789abcdef0123456789abcdef" autoComplete="off" spellCheck={false} onChange={setAccountId} />
          <TextField label="API token" type="password" value={token} error={t} autoComplete="off" spellCheck={false} onChange={setToken} />
          <div className="row"><button className="btn primary" type="submit" disabled={connect.isPending || !accountId || !token || !!a || !!t}>{connect.isPending ? 'Checking with Cloudflare…' : 'Connect'}</button></div>
        </form>
      ) : null}
      {c?.platform.available ? <p className="muted small">This installation can also host Pages projects for you ({c.platform.projectsUsed} in use): choose it when you publish a funnel if you do not connect an account.</p> : null}
      <p className="muted small">Going live on a pages.dev address has been run on a real Cloudflare account; custom domains and the Workers address have not. After connecting, publish a small funnel and check the result, or run <span className="mono">scripts/cf-pages-smoke.ts</span> (docs/CLOUDFLARE-SETUP.md).</p>
      {disconnecting ? (
        <ConfirmDialog danger title="Disconnect Cloudflare?" confirmLabel="Disconnect" busy={disconnect.isPending}
          message="The token is deleted. Funnels published to Cloudflare Pages through this connection go back to being served by this server in this app; the sites stay online on Cloudflare until you delete them there."
          onCancel={() => setDisconnecting(false)} onConfirm={() => disconnect.mutate(true, { onSuccess: () => { toast.push('Disconnected', 'ok'); setDisconnecting(false); }, onError: (e) => { toast.push(errorMessage(e), 'error'); setDisconnecting(false); } })} />
      ) : null}
    </section>
  );
}
