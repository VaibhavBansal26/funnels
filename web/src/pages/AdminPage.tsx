import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, NavLink, useParams } from 'react-router';
import { api, ApiError, downloadFile } from '../api/client';
import { useMutate } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../components/ui';
import { SupportSessionDialog } from '../components/SupportAccess';
import { useToast } from '../components/Toasts';

const TABS = ['workspaces', 'queues', 'flags', 'announcements', 'audit', 'privacy', 'admins'] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = { workspaces: 'Workspaces', queues: 'Queues', flags: 'Feature flags', announcements: 'Announcements', audit: 'Audit', privacy: 'Personal data', admins: 'Administrators' };

interface WsRow { id: string; name: string; createdAt: string; plan: string; planStatus: string; suspended: boolean; suspendedReason: string | null; ownerEmail: string | null; members: number; funnels: number }
interface WsDetail { id: string; name: string; planName: string; planStatus: string; suspended: boolean; suspendedReason: string | null; usage: Record<string, number>; limits: Record<string, number>; members: { id: string; email: string; twoFactorEnabled: boolean }[]; recentAudit: { id: string; action: string; actorId: string; createdAt: string }[] }
interface Flag { key: string; description: string; defaultEnabled: boolean; rolloutPercent: number; overrides: number; builtIn: boolean }

const adminGet = <T,>(path: string, query?: Record<string, string | number | undefined>) => api.get<T>(`/api/admin${path}`, query);

function Reason({ title, confirm, danger, extra, onClose, onSubmit, busy, error }: { title: string; confirm: string; danger?: boolean; extra?: React.ReactNode; onClose: () => void; onSubmit: (reason: string) => void; busy: boolean; error: unknown }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || reason.trim().length < 5} onClick={() => onSubmit(reason.trim())}>{confirm}</button></>}>
      <ErrorBanner error={error} />
      {extra}
      <TextField label="Reason (recorded in the audit log)" value={reason} onChange={setReason} data-autofocus />
    </Modal>
  );
}

function WorkspaceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { startSupport, session } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'ws', id], queryFn: () => adminGet<WsDetail>(`/workspaces/${id}`) });
  const [dialog, setDialog] = useState<'suspend' | 'impersonate' | 'delete' | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const done = () => { setDialog(null); void q.refetch(); };
  const suspend = useMutate((reason: string) => api.post(`/api/admin/workspaces/${id}/suspend`, { reason }), [['admin', 'workspaces']]);
  const unsuspend = useMutate(() => api.post(`/api/admin/workspaces/${id}/unsuspend`), [['admin', 'workspaces']]);
  const impersonate = useMutate((v: { reason: string; allowWrites: boolean }) => api.post<{ token: string }>(`/api/admin/workspaces/${id}/impersonate`, { reason: v.reason, allow_writes: v.allowWrites }));
  const w = q.data;
  return (
    <Modal wide title={w ? w.name : 'Workspace'} onClose={onClose}>
      <ErrorBanner error={q.error ?? unsuspend.error} />
      {q.isLoading ? <Loading rows={3} /> : null}
      {w ? (
        <div className="stack">
          <p className="small muted mono">{w.id}</p>
          <p>Plan <strong>{w.planName}</strong> ({w.planStatus}). {w.suspended ? <span className="badge warn">Suspended: {w.suspendedReason}</span> : <span className="badge ok">Active</span>}</p>
          <table className="table"><caption className="sr-only">Usage</caption><thead><tr><th scope="col">Resource</th><th scope="col" className="num">Used</th><th scope="col" className="num">Limit</th></tr></thead>
            <tbody>{Object.keys(w.usage).map((k) => <tr key={k}><td>{k}</td><td className="num">{w.usage[k]}</td><td className="num">{w.limits[k]}</td></tr>)}</tbody></table>
          <h3>Members</h3>
          <ul>{w.members.map((m) => <li key={m.id}>{m.email} {m.twoFactorEnabled ? <span className="badge ok">2FA</span> : null}</li>)}</ul>
          <h3>Recent activity</h3>
          <ul className="small">{w.recentAudit.map((a) => <li key={a.id}><code>{a.action}</code> by <span className="mono">{a.actorId}</span> {fmtDate(a.createdAt)}</li>)}</ul>
          <div className="row">
            {w.suspended ? <button type="button" className="btn" disabled={unsuspend.isPending} onClick={() => unsuspend.mutate(undefined, { onSuccess: done })}>Unsuspend</button> : <button type="button" className="btn danger" onClick={() => setDialog('suspend')}>Suspend</button>}
            {!w.suspended ? <button type="button" className="btn" onClick={() => setDialog('impersonate')}>Act as owner</button> : null}
            <button type="button" className="btn" onClick={() => void downloadFile(`/api/admin/workspaces/${id}/export`, `workspace-${id}.ndjson`).catch((e) => toast.push(e instanceof Error ? e.message : 'Export failed', 'error'))}>Export data</button>
            {w.suspended ? <button type="button" className="btn danger" onClick={() => setDialog('delete')}>Delete permanently</button> : null}
          </div>
        </div>
      ) : null}
      {dialog === 'suspend' ? <Reason title="Suspend workspace" confirm="Suspend" danger busy={suspend.isPending} error={suspend.error} onClose={() => setDialog(null)} onSubmit={(reason) => suspend.mutate(reason, { onSuccess: done })} extra={<p>Members are signed out, its pages stop being served (the edge cache is purged), public forms, checkout and API keys stop working. Nothing is deleted.</p>} /> : null}
      {dialog === 'impersonate' ? <SupportSessionDialog canWrite={session?.platformRole === 'superadmin'} busy={impersonate.isPending} error={impersonate.error} onClose={() => setDialog(null)} onSubmit={(reason, allowWrites) => impersonate.mutate({ reason, allowWrites }, { onSuccess: (r) => { void startSupport(r.token); onClose(); } })} /> : null}
      {dialog === 'delete' && w ? (
        <ConfirmDelete name={w.name} id={id} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onClose(); }} confirmName={confirmName} setConfirmName={setConfirmName} />
      ) : null}
    </Modal>
  );
}

function ConfirmDelete({ name, id, onClose, onDone, confirmName, setConfirmName }: { name: string; id: string; onClose: () => void; onDone: () => void; confirmName: string; setConfirmName: (s: string) => void }) {
  const [reason, setReason] = useState('');
  const run = useMutate(() => api.deleteWith(`/api/admin/workspaces/${id}`, { confirmName, reason: reason.trim() }), [['admin', 'workspaces']]);
  return (
    <Modal title="Delete workspace permanently" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn danger" disabled={run.isPending || confirmName !== name || reason.trim().length < 5} onClick={() => run.mutate(undefined, { onSuccess: onDone })}>Delete everything</button></>}>
      <ErrorBanner error={run.error} />
      <p>This removes the workspace, its members, funnels, pages, leads, orders and analytics. It cannot be undone. Type <strong>{name}</strong> to confirm.</p>
      <TextField label="Workspace name" value={confirmName} onChange={setConfirmName} />
      <TextField label="Reason (recorded in the audit log)" value={reason} onChange={setReason} />
    </Modal>
  );
}

function Workspaces() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const stats = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => adminGet<Record<string, number>>('/stats') });
  const q = useInfiniteQuery({
    queryKey: ['admin', 'workspaces', search, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminGet<{ data: WsRow[]; nextCursor: string | null }>('/workspaces', { search: search.trim() || undefined, status, cursor: pageParam, limit: 25 }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="stack">
      {stats.data ? <p className="muted">{stats.data.workspaces} workspaces ({stats.data.suspended} suspended), {stats.data.users} users, {stats.data.liveFunnels} live funnels, {stats.data.paidWorkspaces} on a paid plan, {stats.data.deadJobs} dead jobs.</p> : null}
      <div className="filters">
        <TextField label="Search" hint="Name, workspace id or member email" value={search} onChange={setSearch} />
        <div className="field"><label htmlFor="ws-status">Status</label><select id="ws-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="all">All</option><option value="active">Active</option><option value="suspended">Suspended</option></select></div>
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={4} /> : null}
      <div className="table-wrap"><table className="table"><caption className="sr-only">Workspaces</caption>
        <thead><tr><th scope="col">Workspace</th><th scope="col">Owner</th><th scope="col">Plan</th><th scope="col" className="num">Members</th><th scope="col" className="num">Funnels</th><th scope="col">Status</th></tr></thead>
        <tbody>{rows.map((w) => (
          <tr key={w.id}><td><button type="button" className="btn ghost" onClick={() => setOpen(w.id)}>{w.name}</button></td><td>{w.ownerEmail}</td><td>{w.plan}</td><td className="num">{w.members}</td><td className="num">{w.funnels}</td><td>{w.suspended ? <span className="badge warn">Suspended</span> : <span className="badge ok">Active</span>}</td></tr>
        ))}</tbody></table></div>
      {q.hasNextPage ? <button type="button" className="btn" onClick={() => void q.fetchNextPage()}>Load more</button> : null}
      {open ? <WorkspaceDetail id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

interface QueueOverview { jobs: { status: string; type: string; count: number; oldestAgeSeconds: number | null }[]; outbox: { unpublished: number; oldestAgeSeconds: number | null }; webhookDeliveries: Record<string, number>; bus: { kind: string; consumers: { topic: string; group: string; lag: number | null; deadLetters: number }[] }; eventBuffer: { depth: number } }

function Queues() {
  const q = useQuery({ queryKey: ['admin', 'queues'], queryFn: () => adminGet<QueueOverview>('/queues'), refetchInterval: 10_000 });
  const dead = useQuery({ queryKey: ['admin', 'dead-jobs'], queryFn: () => adminGet<{ data: { id: string; type: string; lastError: string | null; attempts: number; updatedAt: string }[] }>('/queues/dead-jobs') });
  const retry = useMutate((id: string) => api.post(`/api/admin/queues/jobs/${id}/retry`), [['admin']]);
  const discard = useMutate((id: string) => api.delete(`/api/admin/queues/jobs/${id}`), [['admin']]);
  const o = q.data;
  return (
    <div className="stack">
      <ErrorBanner error={q.error ?? dead.error ?? retry.error ?? discard.error} />
      {q.isLoading ? <Loading rows={3} /> : null}
      {o ? (
        <>
          <p>Outbox: <strong>{o.outbox.unpublished}</strong> unpublished{o.outbox.oldestAgeSeconds !== null ? ` (oldest ${o.outbox.oldestAgeSeconds}s)` : ''}. Event buffer depth {o.eventBuffer.depth}. Bus: {o.bus.kind}.</p>
          <table className="table"><caption className="sr-only">Jobs</caption><thead><tr><th scope="col">Job type</th><th scope="col">Status</th><th scope="col" className="num">Count</th><th scope="col" className="num">Oldest (s)</th></tr></thead>
            <tbody>{o.jobs.map((j) => <tr key={`${j.status}${j.type}`}><td><code>{j.type}</code></td><td>{j.status}</td><td className="num">{j.count}</td><td className="num">{j.oldestAgeSeconds ?? ''}</td></tr>)}{o.jobs.length === 0 ? <tr><td colSpan={4} className="muted">No queued, running or dead jobs.</td></tr> : null}</tbody></table>
          {o.bus.consumers.length ? <table className="table"><caption className="sr-only">Bus consumers</caption><thead><tr><th scope="col">Topic</th><th scope="col">Group</th><th scope="col" className="num">Lag</th><th scope="col" className="num">Dead letters</th></tr></thead><tbody>{o.bus.consumers.map((c) => <tr key={c.topic}><td><code>{c.topic}</code></td><td>{c.group}</td><td className="num">{c.lag ?? '?'}</td><td className="num">{c.deadLetters}</td></tr>)}</tbody></table> : null}
        </>
      ) : null}
      <h3>Dead jobs</h3>
      {dead.data && dead.data.data.length === 0 ? <p className="muted">None.</p> : null}
      <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{dead.data?.data.map((j) => (
        <li key={j.id} className="card row between"><span><code>{j.type}</code> <span className="mono small">{j.id}</span><br /><span className="small muted">{j.lastError ?? 'no error recorded'} ({j.attempts} attempts)</span></span>
          <span className="row"><button type="button" className="btn sm" onClick={() => retry.mutate(j.id)}>Retry</button><button type="button" className="btn sm danger" onClick={() => discard.mutate(j.id)}>Discard</button></span></li>
      ))}</ul>
    </div>
  );
}

function Flags() {
  const q = useQuery({ queryKey: ['admin', 'flags'], queryFn: () => adminGet<{ data: Flag[] }>('/flags') });
  const save = useMutate((v: { key: string; defaultEnabled?: boolean; rolloutPercent?: number; description?: string }) => api.put(`/api/admin/flags/${v.key}`, { defaultEnabled: v.defaultEnabled, rolloutPercent: v.rolloutPercent, description: v.description }), [['admin', 'flags']]);
  const [key, setKey] = useState('');
  const [wsId, setWsId] = useState('');
  const [flagKey, setFlagKey] = useState('');
  const override = useMutate((enabled: boolean | null) => api.put(`/api/admin/flags/${flagKey}/workspaces/${wsId.trim()}`, { enabled }), [['admin', 'flags']]);
  return (
    <div className="stack">
      <ErrorBanner error={q.error ?? save.error ?? override.error} />
      {q.isLoading ? <Loading rows={2} /> : null}
      <table className="table"><caption className="sr-only">Feature flags</caption><thead><tr><th scope="col">Flag</th><th scope="col">Default</th><th scope="col" className="num">Rollout %</th><th scope="col" className="num">Overrides</th></tr></thead>
        <tbody>{q.data?.data.map((f) => (
          <tr key={f.key}><td><code>{f.key}</code><br /><span className="small muted">{f.description}</span></td>
            <td><label className="check"><input type="checkbox" aria-label={`${f.key} on by default`} checked={f.defaultEnabled} onChange={(e) => save.mutate({ key: f.key, defaultEnabled: e.target.checked })} />on</label></td>
            <td className="num"><input className="input" style={{ width: 70 }} type="number" min={0} max={100} aria-label={`${f.key} rollout percent`} defaultValue={f.rolloutPercent} onBlur={(e) => { const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value)))); if (v !== f.rolloutPercent) save.mutate({ key: f.key, rolloutPercent: v }); }} /></td>
            <td className="num">{f.overrides}</td></tr>
        ))}</tbody></table>
      <div className="card stack">
        <h3>Override for one workspace</h3>
        <div className="row">
          <div className="field"><label htmlFor="ov-flag">Flag</label><select id="ov-flag" className="input" value={flagKey} onChange={(e) => setFlagKey(e.target.value)}><option value="">Choose</option>{q.data?.data.map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}</select></div>
          <TextField label="Workspace id" value={wsId} onChange={setWsId} />
        </div>
        <div className="row"><button type="button" className="btn" disabled={!flagKey || !wsId.trim()} onClick={() => override.mutate(true)}>Force on</button><button type="button" className="btn" disabled={!flagKey || !wsId.trim()} onClick={() => override.mutate(false)}>Force off</button><button type="button" className="btn" disabled={!flagKey || !wsId.trim()} onClick={() => override.mutate(null)}>Remove override</button></div>
      </div>
      <div className="card row"><TextField label="New flag key" hint="lowercase, digits, dot, dash, underscore" value={key} onChange={setKey} /><button type="button" className="btn primary" disabled={!/^[a-z][a-z0-9_.-]{1,62}$/.test(key)} onClick={() => save.mutate({ key, rolloutPercent: 0 }, { onSuccess: () => setKey('') })}>Create flag</button></div>
    </div>
  );
}

interface Ann { id: string; title: string; body: string; level: string; startsAt: string; endsAt: string | null }

function Announcements() {
  const q = useQuery({ queryKey: ['admin', 'announcements'], queryFn: () => adminGet<{ data: Ann[] }>('/announcements') });
  const [f, setF] = useState({ title: '', body: '', level: 'info' });
  const create = useMutate(() => api.post('/api/admin/announcements', f), [['admin', 'announcements'], ['announcements']]);
  const remove = useMutate((id: string) => api.delete(`/api/admin/announcements/${id}`), [['admin', 'announcements'], ['announcements']]);
  return (
    <div className="stack">
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: () => setF({ title: '', body: '', level: 'info' }) }); }}>
        <h3>New announcement</h3>
        <ErrorBanner error={create.error ?? q.error ?? remove.error} />
        <TextField label="Title" value={f.title} onChange={(v) => setF({ ...f, title: v })} />
        <TextField label="Message" value={f.body} onChange={(v) => setF({ ...f, body: v })} />
        <div className="field"><label htmlFor="ann-level">Level</label><select id="ann-level" className="input" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical (cannot be dismissed)</option></select></div>
        <button type="submit" className="btn primary" disabled={create.isPending || !f.title.trim() || !f.body.trim()}>Publish now</button>
      </form>
      <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{q.data?.data.map((a) => (
        <li key={a.id} className="card row between"><span><strong>{a.title}</strong> <span className="badge">{a.level}</span><br /><span className="small">{a.body}</span><br /><span className="small muted">{fmtDate(a.startsAt)}{a.endsAt ? ` to ${fmtDate(a.endsAt)}` : ''}</span></span><button type="button" className="btn sm danger" onClick={() => remove.mutate(a.id)}>Delete</button></li>
      ))}</ul>
    </div>
  );
}

function PlatformAudit() {
  const [action, setAction] = useState('admin.*');
  const [workspace, setWorkspace] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', action, workspace],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminGet<{ data: { id: string; workspaceId: string | null; actorId: string; action: string; target: string | null; detail: Record<string, unknown>; createdAt: string }[]; nextCursor: string | null }>('/audit', { action: action.trim() || undefined, workspace: workspace.trim() || undefined, cursor: pageParam, limit: 50 }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="stack">
      <div className="filters"><TextField label="Action" hint="Exact, or a prefix ending in *" value={action} onChange={setAction} /><TextField label="Workspace id" value={workspace} onChange={setWorkspace} /></div>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading rows={4} /> : null}
      <div className="table-wrap"><table className="table"><caption className="sr-only">Platform audit log</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Workspace</th><th scope="col">Details</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td className="small">{fmtDate(r.createdAt)}</td><td><code>{r.action}</code></td><td className="small mono">{r.actorId}</td><td className="small mono">{r.workspaceId ?? ''}</td><td className="small">{Object.keys(r.detail).length ? JSON.stringify(r.detail) : ''}</td></tr>)}</tbody></table></div>
      {q.hasNextPage ? <button type="button" className="btn" onClick={() => void q.fetchNextPage()}>Load more</button> : null}
    </div>
  );
}

function Privacy() {
  const [email, setEmail] = useState('');
  const [confirm, setConfirm] = useState(false);
  const exp = useMutate(() => api.post<Record<string, unknown>>('/api/admin/gdpr/export', { email: email.trim() }));
  const erase = useMutate(() => api.post<{ erased: Record<string, number>; member: unknown }>('/api/admin/gdpr/erase', { email: email.trim() }));
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <div className="stack">
      <p className="muted">Everything held about one email address across all workspaces: leads, orders and checkout sessions. Erasing deletes leads and anonymises orders (amounts stay for the books). Data held by Stripe or by customers' own systems is not touched.</p>
      <TextField label="Email address" value={email} onChange={(v) => { setEmail(v); exp.reset(); erase.reset(); }} />
      <ErrorBanner error={exp.error ?? erase.error} />
      <div className="row"><button type="button" className="btn" disabled={!valid || exp.isPending} onClick={() => exp.mutate(undefined)}>Look up</button><button type="button" className="btn danger" disabled={!valid} onClick={() => setConfirm(true)}>Erase</button></div>
      {exp.data ? <pre className="card small" aria-label="Data held" style={{ overflow: 'auto', maxHeight: 360 }}>{JSON.stringify(exp.data, null, 2)}</pre> : null}
      {erase.data ? <div className="alert ok" role="status">Erased: {Object.entries(erase.data.erased).map(([k, v]) => `${v} ${k}`).join(', ')}.{erase.data.member ? ' This address belongs to a workspace member; the account was not removed.' : ''}</div> : null}
      {confirm ? <ConfirmDialog danger title="Erase this person's data?" confirmLabel="Erase" busy={erase.isPending} message={`Leads for ${email.trim()} are deleted and its orders are anonymised in every workspace. This cannot be undone.`} onCancel={() => setConfirm(false)} onConfirm={() => erase.mutate(undefined, { onSettled: () => setConfirm(false) })} /> : null}
    </div>
  );
}

function Admins() {
  const q = useQuery({ queryKey: ['admin', 'admins'], queryFn: () => adminGet<{ data: { userId: string; email: string; source: string; role: string; twoFactorEnabled: boolean }[]; requireTwoFactor: boolean }>('/admins') });
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'support' | 'superadmin'>('support');
  const add = useMutate(() => api.post('/api/admin/admins', { email: email.trim(), role }), [['admin', 'admins']]);
  const remove = useMutate((id: string) => api.delete(`/api/admin/admins/${id}`), [['admin', 'admins']]);
  return (
    <div className="stack">
      <ErrorBanner error={q.error ?? add.error ?? remove.error} />
      {q.data?.requireTwoFactor ? <p className="muted small">Two-factor authentication is required for administrators on this installation.</p> : <p className="muted small">Two-factor authentication is not required here (it always is in production).</p>}
      <table className="table"><caption className="sr-only">Administrators</caption><thead><tr><th scope="col">Email</th><th scope="col">Source</th><th scope="col">Role</th><th scope="col">2FA</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{q.data?.data.map((a) => <tr key={a.userId}><td>{a.email}</td><td>{a.source === 'bootstrap' ? 'PLATFORM_ADMIN_EMAILS' : 'Added here'}</td><td>{a.role === 'superadmin' ? <span className="badge primary">Superadmin</span> : <span className="badge">Support (read-only access)</span>}</td><td>{a.twoFactorEnabled ? <span className="badge ok">On</span> : <span className="badge warn">Off</span>}</td><td>{a.source === 'admin' ? <button type="button" className="btn sm danger" onClick={() => remove.mutate(a.userId)}>Remove</button> : null}</td></tr>)}</tbody></table>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => setEmail('') }); }}>
        <TextField label="Make an existing user an administrator" hint="Their email address" value={email} onChange={setEmail} />
        <div className="field"><label htmlFor="admin-role">Role</label><select id="admin-role" className="input" value={role} onChange={(e) => setRole(e.target.value as 'support' | 'superadmin')}><option value="support">Support (read-only support sessions)</option><option value="superadmin" disabled={session?.platformRole !== 'superadmin'}>Superadmin (may open write-enabled sessions)</option></select></div>
        <button type="submit" className="btn primary" disabled={add.isPending || !email.trim()}>Add</button>
      </form>
    </div>
  );
}

export function AdminPage() {
  const { session, loading } = useAuth();
  const { tab: raw } = useParams();
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'workspaces';
  const probe = useQuery({ queryKey: ['admin', 'probe'], enabled: !!session?.platformAdmin, queryFn: () => adminGet<unknown>('/stats'), retry: false });
  if (loading) return <Loading />;
  if (!session?.platformAdmin) return <div className="stack"><h1>Admin</h1><div className="alert">This area is for platform administrators.</div></div>;
  if (probe.error instanceof ApiError && probe.error.code === 'ADMIN_2FA_REQUIRED') {
    return <div className="stack"><h1>Admin</h1><div className="alert warn" role="alert">Two-factor authentication is required for administrators. <Link to="/settings">Turn it on in Settings</Link>, then come back.</div></div>;
  }
  return (
    <div className="stack">
      <h1>Admin</h1>
      <nav className="tabs" aria-label="Admin sections">{TABS.map((t) => <NavLink key={t} to={`/admin/${t}`}>{LABEL[t]}</NavLink>)}</nav>
      {tab === 'workspaces' ? <Workspaces /> : null}
      {tab === 'queues' ? <Queues /> : null}
      {tab === 'flags' ? <Flags /> : null}
      {tab === 'announcements' ? <Announcements /> : null}
      {tab === 'audit' ? <PlatformAudit /> : null}
      {tab === 'privacy' ? <Privacy /> : null}
      {tab === 'admins' ? <Admins /> : null}
    </div>
  );
}
