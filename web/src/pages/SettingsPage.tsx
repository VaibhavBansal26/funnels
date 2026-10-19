import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../api/client';
import { keys, useMembers, useMutate } from '../api/hooks';
import type { Member, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { isEmail } from '../auth/validate';
import { CopyButton, ErrorBanner, fmtDate, Loading, Modal, TextField, ConfirmDialog } from '../components/ui';
import { useToast } from '../components/Toasts';

function WorkspaceCard() {
  const { session, can, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(session?.workspace.name ?? '');
  const [scripts, setScripts] = useState(session?.workspace.allowCustomScripts ?? false);
  useEffect(() => { setName(session?.workspace.name ?? ''); setScripts(session?.workspace.allowCustomScripts ?? false); }, [session]);
  const save = useMutate(() => api.patch('/api/workspace', { name: name.trim(), allowCustomScripts: scripts }));
  const owner = can('owner');
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: async () => { await refresh(); toast.push('Workspace saved', 'ok'); } }); }}>
      <h2>Workspace</h2>
      <ErrorBanner error={save.error} />
      <TextField label="Workspace name" value={name} onChange={setName} disabled={!owner} error={owner && !name.trim() ? 'Enter a name' : undefined} />
      <label className="check"><input type="checkbox" checked={scripts} disabled={!owner} onChange={(e) => setScripts(e.target.checked)} />Allow custom scripts</label>
      <p className="muted small">When on, header/footer tracking codes are published, and custom HTML blocks saved by the owner may contain scripts. When off, scripts and event handlers are always stripped.</p>
      {owner ? <button className="btn primary" type="submit" disabled={save.isPending || !name.trim()}>Save</button> : <p className="muted small">Only the owner can change workspace settings.</p>}
    </form>
  );
}

function Members() {
  const { session, can } = useAuth();
  const q = useMembers();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'member' as 'admin' | 'member' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const create = useMutate((b: typeof form) => api.post<{ temporaryPassword: string }>('/api/members', b), [keys.members]);
  const role = useMutate((v: { id: string; role: 'admin' | 'member' }) => api.patch(`/api/members/${v.id}`, { role: v.role }), [keys.members]);
  const remove = useMutate((id: string) => api.delete(`/api/members/${id}`), [keys.members]);
  const owner = can('owner');
  return (
    <section className="card stack" aria-label="Members">
      <div className="row between"><h2 style={{ margin: 0 }}>Members</h2>{owner ? <button type="button" className="btn primary" onClick={() => setInviting(true)}>Add member</button> : null}</div>
      <ErrorBanner error={q.error ?? role.error ?? remove.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      <div className="table-wrap">
        <table className="table"><caption className="sr-only">Workspace members</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {q.data?.data.map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.id === session?.user.id ? <span className="muted small"> (you)</span> : null}</td><td>{m.email}</td>
                <td>{owner && m.role !== 'owner' ? (
                  <select className="input" aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => role.mutate({ id: m.id, role: e.target.value as 'admin' | 'member' })}><option value="admin">admin</option><option value="member">member</option></select>
                ) : <span className="badge">{m.role}</span>}</td>
                <td className="small muted">{fmtDate(m.createdAt)}</td>
                <td>{owner && m.role !== 'owner' ? <button type="button" className="btn sm danger" onClick={() => setRemoving(m)}>Remove</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inviting ? (
        <Modal title="Add member" onClose={() => setInviting(false)}
          footer={<><button type="button" className="btn" onClick={() => setInviting(false)}>Cancel</button><button type="button" className="btn primary" disabled={create.isPending} onClick={() => {
            const e: Record<string, string> = {};
            if (!form.name.trim()) e.name = 'Enter a name';
            if (!isEmail(form.email)) e.email = 'Enter a valid email address';
            setErrors(e);
            if (Object.keys(e).length) return;
            create.mutate({ ...form, email: form.email.trim() }, { onSuccess: (r) => { setInviting(false); setTemp({ email: form.email.trim(), password: r.temporaryPassword }); setForm({ email: '', name: '', role: 'member' }); }, onError: (err) => setErrors({ email: errorMessage(err) }) });
          }}>Create member</button></>}>
          <TextField label="Name" value={form.name} error={errors.name} onChange={(name) => setForm({ ...form, name })} data-autofocus />
          <TextField label="Email" type="email" value={form.email} error={errors.email} onChange={(email) => setForm({ ...form, email })} />
          <div className="field"><label htmlFor="m-role">Role</label><select id="m-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'member' })}><option value="member">Member: build funnels, view analytics</option><option value="admin">Admin: also domains, webhooks, delete</option></select></div>
        </Modal>
      ) : null}
      {temp ? (
        <Modal title="Temporary password" onClose={() => setTemp(null)} footer={<button type="button" className="btn primary" onClick={() => setTemp(null)}>Done</button>}>
          <p>Share this with <strong>{temp.email}</strong> so they can sign in. It is shown only once.</p>
          <div className="dns-box row between"><code>{temp.password}</code><CopyButton text={temp.password} label="Copy password" /></div>
        </Modal>
      ) : null}
      {removing ? <ConfirmDialog danger title="Remove member?" confirmLabel="Remove" busy={remove.isPending} message={`${removing.name} will lose access to this workspace immediately.`} onCancel={() => setRemoving(null)} onConfirm={() => remove.mutate(removing.id, { onSuccess: () => { toast.push('Member removed', 'ok'); setRemoving(null); }, onError: () => setRemoving(null) })} /> : null}
    </section>
  );
}

function AiUsage() {
  const q = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api.get<{ provider: string; dailyCap: number; usedToday: number }>('/api/ai/status') });
  return (
    <section className="card" aria-label="AI usage">
      <h2>AI assistant</h2>
      {q.isLoading ? <Loading rows={1} /> : null}
      <ErrorBanner error={q.error} />
      {q.data ? (
        <>
          <p>Provider: <strong>{q.data.provider === 'anthropic' ? 'Anthropic model' : 'Built-in offline writer'}</strong></p>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={q.data.dailyCap} aria-valuenow={q.data.usedToday} aria-label="AI requests used today"><span style={{ width: `${q.data.dailyCap ? Math.min(100, (q.data.usedToday / q.data.dailyCap) * 100) : 100}%` }} /></div>
          <p className="muted small">{q.data.usedToday} of {q.data.dailyCap} requests used today (UTC day).</p>
        </>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  const { session } = useAuth();
  const role: Role | undefined = session?.user.role;
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <h1>Settings</h1>
      <p className="muted">Signed in as {session?.user.email} ({role}).</p>
      <WorkspaceCard />
      <Members />
      <AiUsage />
    </div>
  );
}
