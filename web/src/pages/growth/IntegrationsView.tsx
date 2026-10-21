import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { growthKeys, idProblem, PROVIDER_FORMAT, useDeliveries, useIntegrations, type Integration, type Provider } from '../../api/growth';
import { useMutate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, Empty, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../../components/ui';
import { Badge } from '../../ui';

const TONE = { sent: 'ok', queued: 'warn', failed: 'warn', dead: 'danger', skipped: 'neutral' } as const;
const refresh = [growthKeys.integrations as unknown as string[]];

function LogDialog({ i, onClose }: { i: Integration; onClose: () => void }) {
  const q = useDeliveries(i.id);
  const toast = useToast();
  const retry = useMutate((id: string) => api.post(`/api/integrations/deliveries/${id}/retry`), [growthKeys.deliveries(i.id) as unknown as string[]]);
  return (
    <Modal wide title={`Delivery log: ${i.name}`} onClose={onClose}>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="Nothing sent yet">Conversions appear here when a visitor opts in or buys.</Empty> : null}
      {q.data?.data.length ? (
        <div className="table-wrap card flush">
          <table className="table"><caption className="sr-only">Deliveries, newest first</caption>
            <thead><tr><th scope="col">Status</th><th scope="col">Event</th><th scope="col">When</th><th scope="col" className="num">Tries</th><th scope="col">Detail</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{q.data.data.map((d) => (
              <tr key={d.id}>
                <td><Badge tone={TONE[d.status]}>{d.status}</Badge>{d.isTest ? <> <Badge tone="info">test</Badge></> : null}</td>
                <td><strong>{d.eventName}</strong><div className="mono small muted">{d.eventId}</div></td>
                <td className="small">{fmtDate(d.createdAt)}</td><td className="num">{d.attempts}</td>
                <td className="small" style={{ maxWidth: 320 }}>{d.error ? <span className="text-danger">{d.error}</span> : d.httpStatus ? `HTTP ${d.httpStatus}` : ''}</td>
                <td>{(d.status === 'dead' || d.status === 'failed') && !d.isTest ? <button type="button" className="btn sm" disabled={retry.isPending} onClick={() => retry.mutate(d.id, { onSuccess: () => toast.push('Queued again', 'ok'), onError: (e) => toast.push(errorMessage(e), 'error') })}>Send again</button> : null}</td>
              </tr>))}</tbody>
          </table>
        </div>
      ) : null}
      <p className="muted small" style={{ marginTop: 12 }}>The log keeps the status and the network&apos;s answer. It never holds the access token or a raw email address or phone number.</p>
    </Modal>
  );
}

export function IntegrationForm({ edit, onClose }: { edit?: Integration; onClose: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<Provider>(edit?.provider ?? 'meta');
  const [name, setName] = useState(edit?.name ?? '');
  const [pixelId, setPixelId] = useState(edit?.pixelId ?? '');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState(edit?.testEventCode ?? '');
  const fmt = PROVIDER_FORMAT[provider];
  const idErr = pixelId ? idProblem(fmt.idKind, pixelId) : undefined;
  const secretErr = secret && (secret.trim().length < 8 || /\s/.test(secret.trim())) ? 'The token looks wrong: at least 8 characters, no spaces' : undefined;
  const codeErr = code && !/^[A-Za-z0-9_-]{1,40}$/.test(code) ? 'Letters, digits, - and _ only' : undefined;
  const save = useMutate(() => edit
    ? api.patch(`/api/integrations/${edit.id}`, { name: name.trim(), ...(secret ? { secret: secret.trim() } : {}), testEventCode: code.trim() || null })
    : api.post('/api/integrations', { provider, name: name.trim(), pixelId: pixelId.trim(), secret: secret.trim(), ...(code.trim() ? { testEventCode: code.trim() } : {}) }), refresh);
  const ok = name.trim() && (edit || (pixelId && !idErr && secret && !secretErr)) && !secretErr && !codeErr;
  return (
    <Modal title={edit ? `Edit ${edit.name}` : 'Connect an ad network'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!ok || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.push(edit ? 'Saved' : 'Connected. Send a test event to check it.', 'ok'); onClose(); } })}>{save.isPending ? 'Saving…' : edit ? 'Save' : 'Connect'}</button></>}>
      <form className="stack" noValidate onSubmit={(e) => e.preventDefault()}>
        <ErrorBanner error={save.error} />
        {!edit ? <div className="field"><label htmlFor="int-provider">Network</label><select id="int-provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>{(Object.keys(PROVIDER_FORMAT) as Provider[]).map((p) => <option key={p} value={p}>{PROVIDER_FORMAT[p].label}</option>)}</select></div> : null}
        <TextField label="Name" value={name} placeholder="Main pixel" onChange={setName} data-autofocus />
        {!edit ? <TextField label={fmt.idLabel} value={pixelId} error={idErr} autoComplete="off" spellCheck={false} onChange={setPixelId} /> : <p className="small">{fmt.idLabel}: <span className="mono">{edit.pixelId}</span></p>}
        <TextField label={edit ? `${fmt.secretLabel} (leave empty to keep ${edit.secretHint})` : fmt.secretLabel} type="password" value={secret} error={secretErr} autoComplete="new-password" spellCheck={false} hint="Stored encrypted. It is never shown again." onChange={setSecret} />
        {fmt.testCode ? <TextField label="Test event code" value={code} error={codeErr} hint="From the network's Events Manager > Test events. Needed for Send test event." onChange={setCode} /> : <p className="muted small">GA4 test events use the Measurement Protocol validation endpoint, which needs no code.</p>}
      </form>
    </Modal>
  );
}

function Card({ i, canManage }: { i: Integration; canManage: boolean }) {
  const toast = useToast();
  const [log, setLog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string | null; httpStatus: number | null } | null>(null);
  const patch = useMutate((body: Record<string, unknown>) => api.patch(`/api/integrations/${i.id}`, body), refresh);
  const send = useMutate(() => api.post<{ ok: boolean; message: string | null; httpStatus: number | null }>(`/api/integrations/${i.id}/test`), refresh);
  const del = useMutate(() => api.delete(`/api/integrations/${i.id}`), refresh);
  return (
    <article className="card stack" aria-label={i.name}>
      <div className="row between">
        <div><h3 style={{ margin: 0 }}>{i.name}</h3><span className="muted small">{i.providerLabel} · <span className="mono">{i.pixelId}</span> · token {i.secretHint}</span></div>
        <Badge tone={!i.enabled ? 'neutral' : i.lastStatus === 'error' ? 'danger' : i.lastStatus === 'ok' ? 'ok' : 'warn'}>{!i.enabled ? 'Off' : i.lastStatus === 'error' ? 'Last delivery failed' : i.lastStatus === 'ok' ? 'Working' : 'Not used yet'}</Badge>
      </div>
      {i.lastError ? <div className="alert error" role="alert">{i.lastError}</div> : null}
      {test ? <div className={`alert ${test.ok ? 'ok' : 'error'}`} role="status">{test.ok ? `Test event accepted (HTTP ${test.httpStatus}). Check the network's test tool.` : `Test event failed: ${test.message}`}</div> : null}
      {canManage ? (
        <>
          <div className="row">
            <label className="check"><input type="checkbox" checked={i.enabled} onChange={(e) => patch.mutate({ enabled: e.target.checked })} />Enabled</label>
            <label className="check"><input type="checkbox" checked={i.sendLead} onChange={(e) => patch.mutate({ sendLead: e.target.checked })} />Send Lead</label>
            <label className="check"><input type="checkbox" checked={i.sendPurchase} onChange={(e) => patch.mutate({ sendPurchase: e.target.checked })} />Send Purchase</label>
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={send.isPending} onClick={() => send.mutate(undefined, { onSuccess: setTest, onError: (e) => setTest({ ok: false, message: errorMessage(e), httpStatus: null }) })}>{send.isPending ? 'Sending…' : 'Send test event'}</button>
            <button type="button" className="btn" onClick={() => setLog(true)}>Delivery log</button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="btn danger right" onClick={() => setDeleting(true)}>Remove</button>
          </div>
        </>
      ) : null}
      {log ? <LogDialog i={i} onClose={() => setLog(false)} /> : null}
      {editing ? <IntegrationForm edit={i} onClose={() => setEditing(false)} /> : null}
      {deleting ? <ConfirmDialog danger title={`Remove ${i.name}?`} confirmLabel="Remove" busy={del.isPending} message="Conversions stop being sent and its delivery log is deleted." onCancel={() => setDeleting(false)} onConfirm={() => del.mutate(undefined, { onSuccess: () => { toast.push('Removed', 'ok'); setDeleting(false); }, onError: (e) => { toast.push(errorMessage(e), 'error'); setDeleting(false); } })} /> : null}
    </article>
  );
}

export function IntegrationsView() {
  const { can } = useAuth();
  const q = useIntegrations();
  const [adding, setAdding] = useState(false);
  const canManage = can('integrations:manage');
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted" style={{ margin: 0, maxWidth: 680 }}>Send leads and purchases to Meta, Google Analytics 4 and TikTok from the server, so they are counted even when browsers block pixels. Events are hashed, deduplicated with the browser pixel, and respect the visitor&apos;s cookie choice.</p>
        {canManage ? <button type="button" className="btn primary" onClick={() => setAdding(true)}>Connect a network</button> : null}
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No networks connected">Connect Meta, GA4 or TikTok to send conversions from the server.</Empty></div> : null}
      {q.data?.data.map((i) => <Card key={i.id} i={i} canManage={canManage} />)}
      {adding ? <IntegrationForm onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
