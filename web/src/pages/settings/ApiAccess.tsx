import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useMutate } from '../../api/hooks';
import type { ApiKeyInfo } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, CopyButton, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../../components/ui';
import { IdentityPepper } from './IdentityPepper';

const keysKey = ['api-keys'] as const;
const SCOPES = [
  { id: 'analytics:read', label: 'Read: funnels, steps, time series' },
  { id: 'analytics:export', label: 'Export: events, leads and funnel structure (keys, no personal data)' },
] as const;

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const { can } = useAuth();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'live' | 'test'>('live');
  const [scopes, setScopes] = useState<string[]>(['analytics:read']);
  const [expires, setExpires] = useState('');
  const [ips, setIps] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutate(() =>
    api.post<{ key: string }>('/api/v1/api-keys', {
      name: name.trim(), mode, scopes,
      expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
      ipAllowlist: ips.split(/[\s,]+/).filter(Boolean),
    }), [keysKey]);
  return (
    <Modal title="New API key" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={create.isPending || !name.trim() || !scopes.length}
        onClick={() => create.mutate(undefined, { onSuccess: (r) => onCreated(r.key), onError: (e) => setError(errorMessage(e)) })}>Create key</button></>}>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <TextField label="Name" hint="Where it is used, for example Intelligence service" value={name} onChange={setName} data-autofocus />
      <div className="field"><label htmlFor="key-mode">Funnels it can see</label>
        <select id="key-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'test')}><option value="live">Live funnels</option><option value="test">Test funnels</option></select></div>
      <fieldset style={{ border: 0, padding: 0 }}><legend className="small muted">Scopes</legend>
        {SCOPES.map((s) => (
          <label key={s.id} className="check"><input type="checkbox" checked={scopes.includes(s.id)} disabled={!can(s.id)} onChange={(e) => setScopes((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))} />{s.label}{can(s.id) ? '' : ' (you do not hold this permission)'}</label>
        ))}
      </fieldset>
      <TextField label="Expires on (optional)" type="date" value={expires} onChange={setExpires} />
      <TextField label="Allowed IP addresses (optional)" hint="Addresses or CIDR ranges separated by spaces or commas; empty means any address" value={ips} onChange={setIps} />
    </Modal>
  );
}

export function ApiAccess() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('api_keys:manage');
  const q = useQuery({ queryKey: keysKey, enabled: manage, queryFn: () => api.get<{ data: ApiKeyInfo[] }>('/api/v1/api-keys') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const revoke = useMutate((id: string) => api.delete(`/api/v1/api-keys/${id}`), [keysKey]);
  const identity = can('analytics_identity:manage');
  if (!manage && !identity) return null;
  return (
    <section className="card stack" aria-label="API access">
      <h2>API access</h2>
      <p className="muted small">API keys let other systems read analytics (<code>/api/v1/analytics</code>, see docs/ANALYTICS-API.md). A key is shown once, when created.</p>
      {manage ? (
        <div className="stack">
          <div className="row between"><h3 style={{ margin: 0 }}>API keys</h3><button type="button" className="btn primary" onClick={() => setCreating(true)}>New API key</button></div>
          <ErrorBanner error={q.error ?? revoke.error} onRetry={() => void q.refetch()} />
          {q.isLoading ? <Loading rows={2} /> : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack" aria-label="API keys">
            {q.data?.data.filter((k) => !k.revokedAt).map((k) => (
              <li key={k.id} className="card row between">
                <span><strong>{k.name}</strong> <span className="badge">{k.mode}</span> <code>{k.prefix}…</code><br /><span className="muted small">{k.scopes.join(', ')} · {k.lastUsedAt ? `used ${fmtDate(k.lastUsedAt)}` : 'never used'}{k.expiresAt ? ` · expires ${fmtDate(k.expiresAt)}` : ''}{k.ipAllowlist.length ? ` · ${k.ipAllowlist.length} allowed address(es)` : ''}</span></span>
                <button type="button" className="btn sm danger" onClick={() => setRevoking(k)}>Revoke</button>
              </li>
            ))}
          </ul>
          {q.data && !q.data.data.some((k) => !k.revokedAt) ? <p className="muted">No active keys.</p> : null}
        </div>
      ) : null}
      {identity ? <IdentityPepper /> : null}
      {creating ? <CreateKey onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); }} /> : null}
      {secret ? (
        <Modal title="Copy your API key now" onClose={() => setSecret(null)} footer={<button type="button" className="btn primary" onClick={() => setSecret(null)}>I copied it</button>}>
          <p>This is the only time the key is shown. Store it in the secret manager of the system that will use it.</p>
          <div className="dns-box row between"><code aria-label="API key" style={{ wordBreak: 'break-all' }}>{secret}</code><CopyButton text={secret} label="Copy key" /></div>
        </Modal>
      ) : null}
      {revoking ? <ConfirmDialog danger title="Revoke this key?" confirmLabel="Revoke" busy={revoke.isPending} message={`${revoking.name} stops working immediately.`} onCancel={() => setRevoking(null)} onConfirm={() => revoke.mutate(revoking.id, { onSuccess: () => { toast.push('Key revoked', 'ok'); setRevoking(null); }, onError: () => setRevoking(null) })} /> : null}
    </section>
  );
}
