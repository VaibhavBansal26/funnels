import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { keys, useMembers, useMutate } from '../../api/hooks';
import type { Invitation, InvitationResult, Member, PermissionInfo, RoleInfo } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { isEmail } from '../../auth/validate';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, CopyButton, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../../components/ui';

const rolesKey = ['roles'] as const;
const invKey = ['invitations'] as const;

function useRoles() {
  return useQuery({ queryKey: rolesKey, queryFn: () => api.get<{ data: RoleInfo[] }>('/api/roles') });
}

/** Roles the signed-in user may hand out: those whose permissions they hold themselves (the server enforces the same rule). */
function useAssignable(): RoleInfo[] {
  const { session } = useAuth();
  const roles = useRoles();
  const mine = new Set(session?.user.permissions ?? []);
  return (roles.data?.data ?? []).filter((r) => r.permissions.every((p) => mine.has(p)));
}

function RoleEditor({ role, onClose }: { role: RoleInfo | null; onClose: () => void }) {
  const toast = useToast();
  const { session } = useAuth();
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ data: PermissionInfo[] }>('/api/permissions') });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [picked, setPicked] = useState(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);
  const readOnly = !!role?.system;
  const mine = new Set(session?.user.permissions ?? []);
  const save = useMutate(() => (role ? api.patch(`/api/roles/${role.id}`, { name, description, permissions: [...picked] }) : api.post('/api/roles', { name, description, permissions: [...picked] })), [rolesKey, keys.members]);
  const groups = new Map<string, PermissionInfo[]>();
  for (const p of perms.data?.data ?? []) (groups.get(p.id.split(':')[0]!) ?? groups.set(p.id.split(':')[0]!, []).get(p.id.split(':')[0]!)!).push(p);
  return (
    <Modal wide title={readOnly ? `${role!.name} (built-in role)` : role ? `Edit ${role.name}` : 'New role'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>{readOnly ? null : <button type="button" className="btn primary" disabled={save.isPending || !name.trim()} onClick={() => save.mutate(undefined, { onSuccess: () => { toast.push('Role saved', 'ok'); onClose(); }, onError: (e) => setError(errorMessage(e)) })}>Save role</button>}</>}>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {readOnly ? <p className="muted">{role!.description}</p> : null}
      {readOnly ? null : (<><TextField label="Name" value={name} onChange={setName} data-autofocus /><TextField label="Description" value={description} onChange={setDescription} /></>)}
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="small muted">Permissions{readOnly ? '' : ' (you can only grant permissions you hold)'}</legend>
        {[...groups.entries()].map(([group, list]) => (
          <div key={group}><strong className="small">{group}</strong>
            {list.map((p) => {
              const can = readOnly || picked.has(p.id) || mine.has(p.id);
              return (
                <label key={p.id} className="check" title={can ? undefined : 'You do not hold this permission'}>
                  <input type="checkbox" checked={readOnly ? role!.permissions.includes(p.id) : picked.has(p.id)} disabled={readOnly || !mine.has(p.id)}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />
                  <code>{p.id}</code> <span className="muted small">{p.description}</span>
                </label>
              );
            })}
          </div>
        ))}
      </fieldset>
    </Modal>
  );
}

function Roles() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useRoles();
  const [editing, setEditing] = useState<RoleInfo | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoleInfo | null>(null);
  const del = useMutate((id: string) => api.delete(`/api/roles/${id}`), [rolesKey]);
  const manage = can('roles:manage');
  return (
    <section className="card stack" aria-label="Roles">
      <div className="row between"><h2 style={{ margin: 0 }}>Roles</h2>{manage ? <button type="button" className="btn primary" onClick={() => setEditing('new')}>New role</button> : null}</div>
      <ErrorBanner error={q.error ?? del.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      <div className="table-wrap"><table className="table"><caption className="sr-only">Roles and their permissions</caption>
        <thead><tr><th scope="col">Role</th><th scope="col">Permissions</th><th scope="col">Members</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {q.data?.data.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.name}</strong>{r.system ? <span className="badge" style={{ marginLeft: 6 }}>built-in</span> : null}<div className="muted small">{r.description}</div></td>
              <td className="small">{r.permissions.length}</td><td>{r.members}</td>
              <td className="row"><button type="button" className="btn sm" onClick={() => setEditing(r)}>{r.system || !manage ? 'View' : 'Edit'}</button>{manage && !r.system ? <button type="button" className="btn sm danger" onClick={() => setDeleting(r)}>Delete</button> : null}</td>
            </tr>
          ))}
        </tbody></table></div>
      {editing ? <RoleEditor role={editing === 'new' ? null : manage ? editing : { ...editing, system: true }} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ConfirmDialog danger title="Delete role?" confirmLabel="Delete" busy={del.isPending} message={`The role "${deleting.name}" will be removed. Roles that members still use cannot be deleted.`} onCancel={() => setDeleting(null)} onConfirm={() => del.mutate(deleting.id, { onSuccess: () => { toast.push('Role deleted', 'ok'); setDeleting(null); }, onError: () => setDeleting(null) })} /> : null}
    </section>
  );
}

function Invitations() {
  const { can } = useAuth();
  const toast = useToast();
  const manage = can('members:manage');
  const q = useQuery({ queryKey: invKey, queryFn: () => api.get<{ data: Invitation[] }>('/api/invitations') });
  const resend = useMutate((id: string) => api.post<InvitationResult>(`/api/invitations/${id}/resend`), [invKey]);
  const revoke = useMutate((id: string) => api.delete(`/api/invitations/${id}`), [invKey]);
  const [link, setLink] = useState<string | null>(null);
  const pending = (q.data?.data ?? []).filter((i) => i.status === 'pending' || i.status === 'expired');
  if (!pending.length) return null;
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>Pending invitations</h3>
      <ErrorBanner error={q.error ?? resend.error ?? revoke.error} />
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack" aria-label="Pending invitations">
        {pending.map((i) => (
          <li key={i.id} className="card row between"><span><strong>{i.email}</strong> <span className="badge">{i.roleName}</span><br /><span className="muted small">{i.status === 'expired' ? 'expired' : `expires ${fmtDate(i.expiresAt)}`}</span></span>
            {manage ? <span className="row"><button type="button" className="btn sm" onClick={() => resend.mutate(i.id, { onSuccess: (r) => (r.link ? setLink(r.link) : toast.push('Invitation sent again', 'ok')) })}>Resend</button><button type="button" className="btn sm danger" onClick={() => revoke.mutate(i.id, { onSuccess: () => toast.push('Invitation revoked', 'ok') })}>Revoke</button></span> : null}
          </li>
        ))}
      </ul>
      {link ? <LinkModal link={link} onClose={() => setLink(null)} /> : null}
    </div>
  );
}

function LinkModal({ link, onClose }: { link: string; onClose: () => void }) {
  return (
    <Modal title="Share this invitation link" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <p>No email transport is configured, so the link was not sent. Share it with the invitee yourself. It works once and is shown only now.</p>
      <div className="dns-box row between"><code style={{ wordBreak: 'break-all' }}>{link}</code><CopyButton text={link} label="Copy link" /></div>
    </Modal>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const assignable = useAssignable();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('member');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutate(() => api.post<InvitationResult>('/api/invitations', { email: email.trim(), roleId }), [invKey]);
  if (link) return <LinkModal link={link} onClose={onClose} />;
  return (
    <Modal title="Invite a member" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={invite.isPending} onClick={() => {
        if (!isEmail(email)) return setError('Enter a valid email address');
        setError(null);
        invite.mutate(undefined, { onSuccess: (r) => { if (r.link) setLink(r.link); else { toast.push(`Invitation sent to ${email.trim()}`, 'ok'); onClose(); } }, onError: (e) => setError(errorMessage(e)) });
      }}>Send invitation</button></>}>
      <TextField label="Email" type="email" value={email} error={error ?? undefined} onChange={setEmail} data-autofocus />
      <div className="field"><label htmlFor="inv-role">Role</label>
        <select id="inv-role" className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{assignable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
    </Modal>
  );
}

function Members() {
  const { session, can } = useAuth();
  const toast = useToast();
  const q = useMembers();
  const assignable = useAssignable();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const manage = can('members:manage');
  const role = useMutate((v: { id: string; roleId: string }) => api.patch(`/api/members/${v.id}`, { roleId: v.roleId }), [keys.members, rolesKey]);
  const remove = useMutate((id: string) => api.delete(`/api/members/${id}`), [keys.members, rolesKey]);
  const reset = useMutate((id: string) => api.post(`/api/members/${id}/reset-2fa`), [keys.members]);
  const canTouch = (m: Member) => manage && m.id !== session?.user.id;
  return (
    <section className="card stack" aria-label="Members">
      <div className="row between"><h2 style={{ margin: 0 }}>Members</h2>{manage ? <button type="button" className="btn primary" onClick={() => setInviting(true)}>Invite member</button> : null}</div>
      <ErrorBanner error={q.error ?? role.error ?? remove.error ?? reset.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      <div className="table-wrap"><table className="table"><caption className="sr-only">Workspace members</caption>
        <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">2FA</th><th scope="col">Last sign-in</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {q.data?.data.map((m) => (
            <tr key={m.id}>
              <td>{m.name}{m.id === session?.user.id ? <span className="muted small"> (you)</span> : null}</td><td>{m.email}</td>
              <td>{canTouch(m) ? (
                <select className="input" aria-label={`Role of ${m.name}`} value={m.roleId} onChange={(e) => role.mutate({ id: m.id, roleId: e.target.value })}>
                  {[...assignable, ...(assignable.some((r) => r.id === m.roleId) ? [] : [{ id: m.roleId, name: m.roleName } as RoleInfo])].map((r) => <option key={r.id} value={r.id} disabled={!assignable.some((a) => a.id === r.id)}>{r.name}</option>)}
                </select>) : <span className="badge">{m.roleName}</span>}</td>
              <td>{m.twoFactorEnabled ? <span className="badge ok">on</span> : <span className="muted small">off</span>}</td>
              <td className="small muted">{m.lastLoginAt ? fmtDate(m.lastLoginAt) : 'never'}</td>
              <td className="row">{canTouch(m) && m.twoFactorEnabled ? <button type="button" className="btn sm" onClick={() => reset.mutate(m.id, { onSuccess: () => toast.push(`${m.name}'s two-factor authentication was removed`, 'ok') })}>Reset 2FA</button> : null}
                {canTouch(m) ? <button type="button" className="btn sm danger" onClick={() => setRemoving(m)}>Remove</button> : null}</td>
            </tr>
          ))}
        </tbody></table></div>
      <Invitations />
      {inviting ? <InviteModal onClose={() => setInviting(false)} /> : null}
      {removing ? <ConfirmDialog danger title="Remove member?" confirmLabel="Remove" busy={remove.isPending} message={`${removing.name} will lose access to this workspace immediately and their sessions end.`} onCancel={() => setRemoving(null)} onConfirm={() => remove.mutate(removing.id, { onSuccess: () => { toast.push('Member removed', 'ok'); setRemoving(null); }, onError: () => setRemoving(null) })} /> : null}
    </section>
  );
}

export function TeamSection() {
  return (
    <>
      <Members />
      <Roles />
    </>
  );
}
