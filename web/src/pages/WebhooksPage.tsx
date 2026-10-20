import { useState } from 'react';
import { api, errorMessage } from '../api/client';
import { keys, useDeliveries, useMutate, useWebhooks } from '../api/hooks';
import type { Webhook } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, CopyButton, Empty, ErrorBanner, fmtDate, Loading, Modal, StatusBadge, TextField } from '../components/ui';

const EVENTS = [['funnel.optin', 'New opt-in (lead)'], ['funnel.purchase', 'New purchase (order)'], ['funnel.refund', 'Order refunded'], ['funnel.dispute', 'Payment dispute (chargeback) opened, updated or closed']] as const;

export function validateWebhook(v: { url: string; events: string[] }): Partial<Record<'url' | 'events', string>> {
  const e: Partial<Record<'url' | 'events', string>> = {};
  try {
    const u = new URL(v.url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') e.url = 'Use an http:// or https:// URL';
  } catch {
    e.url = 'Enter a full URL such as https://example.com/hooks/funnels';
  }
  if (!v.events.length) e.events = 'Select at least one event';
  return e;
}

function DeliveryLog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const q = useDeliveries(hook.id);
  const toast = useToast();
  const retry = useMutate((id: string) => api.post(`/api/webhooks/deliveries/${id}/retry`), [[...keys.webhooks, hook.id, 'deliveries']]);
  return (
    <Modal side title="Delivery log" onClose={onClose}>
      <p className="small muted mono" style={{ wordBreak: 'break-all' }}>{hook.url}</p>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="No deliveries yet">Events appear here after the first lead or sale. Use “Send test event” to try it.</Empty> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack">
        {q.data?.data.map((d) => (
          <li key={d.id} className="card">
            <div className="row between"><strong>{d.event}</strong><StatusBadge status={d.status} /></div>
            <div className="small muted">{fmtDate(d.createdAt)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.responseStatus ? ` · HTTP ${d.responseStatus}` : ''}</div>
            {d.error ? <div className="small" style={{ color: 'var(--danger)' }}>{d.error}</div> : null}
            {d.status === 'dead' || d.status === 'failed' ? <button type="button" className="btn sm" disabled={retry.isPending} style={{ marginTop: 6 }} onClick={() => retry.mutate(d.id, { onSuccess: () => toast.push('Delivery queued again', 'ok') })}>Retry now</button> : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function WebhooksPage() {
  const { can } = useAuth();
  const q = useWebhooks();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ url: '', events: ['funnel.optin', 'funnel.purchase'] as string[] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const create = useMutate((b: typeof form) => api.post<Webhook>('/api/webhooks', b), [keys.webhooks]);
  const toggle = useMutate((w: Webhook) => api.patch(`/api/webhooks/${w.id}`, { active: !w.active }), [keys.webhooks]);
  const del = useMutate((id: string) => api.delete(`/api/webhooks/${id}`), [keys.webhooks]);
  const test = useMutate((id: string) => api.post(`/api/webhooks/${id}/test`), [keys.webhooks]);
  const rotate = useMutate((id: string) => api.post<Webhook>(`/api/webhooks/${id}/rotate-secret`), [keys.webhooks]);

  if (!can('webhooks:manage')) return <div className="stack"><h1>Webhooks</h1><div className="alert">You need the webhooks:manage permission to manage webhooks.</div></div>;

  return (
    <div className="stack">
      <div className="row between"><h1>Webhooks</h1><button type="button" className="btn primary" onClick={() => setCreating(true)}>Add webhook</button></div>
      <p className="muted">Receive a signed HTTP POST when a visitor opts in or buys. Requests carry an <code>X-Funnels-Signature</code> header (HMAC-SHA256 of <code>timestamp.body</code>) and are retried with exponential backoff.</p>
      <ErrorBanner error={q.error ?? test.error ?? toggle.error ?? rotate.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No webhooks yet">Send leads and sales to your CRM, spreadsheet or automation tool.</Empty></div> : null}
      {q.data?.data.map((w) => (
        <article key={w.id} className="card stack" aria-label={w.url}>
          <div className="row between"><div className="grow"><strong className="mono" style={{ wordBreak: 'break-all' }}>{w.url}</strong><div className="small muted">{w.events.join(', ')} · secret {w.secretPreview}</div></div><span className={`badge ${w.active ? 'ok' : ''}`}>{w.active ? 'active' : 'paused'}</span></div>
          <div className="row">
            <button type="button" className="btn sm" onClick={() => setLog(w)}>Delivery log</button>
            <button type="button" className="btn sm" onClick={() => test.mutate(w.id, { onSuccess: () => toast.push('Test event queued', 'ok') })}>Send test event</button>
            <button type="button" className="btn sm" onClick={() => toggle.mutate(w)}>{w.active ? 'Pause' : 'Resume'}</button>
            <button type="button" className="btn sm" onClick={() => rotate.mutate(w.id, { onSuccess: (r) => setSecret(r.secret ?? null) })}>Rotate secret</button>
            <button type="button" className="btn sm danger right" onClick={() => setDeleting(w)}>Delete</button>
          </div>
        </article>
      ))}

      {creating ? (
        <Modal title="Add webhook" onClose={() => setCreating(false)}
          footer={<><button type="button" className="btn" onClick={() => setCreating(false)}>Cancel</button><button type="button" className="btn primary" disabled={create.isPending} onClick={() => {
            const e = validateWebhook(form);
            setErrors(e as Record<string, string>);
            if (Object.keys(e).length) return;
            create.mutate({ url: form.url.trim(), events: form.events }, { onSuccess: (w) => { setCreating(false); setSecret(w.secret ?? null); setForm({ url: '', events: ['funnel.optin', 'funnel.purchase'] }); }, onError: (err) => setErrors({ url: errorMessage(err) }) });
          }}>Create webhook</button></>}>
          <TextField label="Endpoint URL" value={form.url} error={errors.url} hint="Must be a public http(s) address. Private and local addresses are blocked." onChange={(url) => setForm({ ...form, url })} data-autofocus />
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="label">Events</legend>
            {EVENTS.map(([k, l]) => <label key={k} className="check"><input type="checkbox" checked={form.events.includes(k)} onChange={() => setForm({ ...form, events: form.events.includes(k) ? form.events.filter((x) => x !== k) : [...form.events, k] })} />{l} <code>{k}</code></label>)}
            {errors.events ? <span className="error small" role="alert">{errors.events}</span> : null}
          </fieldset>
        </Modal>
      ) : null}
      {secret ? (
        <Modal title="Signing secret" onClose={() => setSecret(null)} footer={<button type="button" className="btn primary" onClick={() => setSecret(null)}>I have saved it</button>}>
          <p>Copy this secret now. It is only shown once; use it to verify the <code>X-Funnels-Signature</code> header.</p>
          <div className="dns-box row between"><code style={{ wordBreak: 'break-all' }}>{secret}</code><CopyButton text={secret} label="Copy secret" /></div>
        </Modal>
      ) : null}
      {log ? <DeliveryLog hook={log} onClose={() => setLog(null)} /> : null}
      {deleting ? <ConfirmDialog danger title="Delete webhook?" confirmLabel="Delete" busy={del.isPending} message={`${deleting.url} will stop receiving events and its delivery log is removed.`} onCancel={() => setDeleting(null)} onConfirm={() => del.mutate(deleting.id, { onSuccess: () => { toast.push('Webhook deleted', 'ok'); setDeleting(null); }, onError: () => setDeleting(null) })} /> : null}
    </div>
  );
}
