import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorMessage } from '../../api/client';
import { useMutate } from '../../api/hooks';
import type { SessionInfo } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { CopyButton, ErrorBanner, fmtDate, Loading, Modal, TextField } from '../../components/ui';

function PasswordForm() {
  const toast = useToast();
  const [v, setV] = useState({ currentPassword: '', newPassword: '' });
  const [error, setError] = useState<string | null>(null);
  const change = useMutate((b: typeof v) => api.post<{ otherSessionsEnded: number }>('/api/auth/password', b), [['sessions']]);
  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      if (v.newPassword.length < 8) return setError('The new password must be at least 8 characters');
      change.mutate(v, { onSuccess: (r) => { setV({ currentPassword: '', newPassword: '' }); toast.push(r.otherSessionsEnded ? `Password changed; ${r.otherSessionsEnded} other session(s) signed out` : 'Password changed', 'ok'); }, onError: (err) => setError(errorMessage(err)) });
    }}>
      <h3>Password</h3>
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      <TextField label="Current password" type="password" autoComplete="current-password" value={v.currentPassword} onChange={(currentPassword) => setV({ ...v, currentPassword })} />
      <TextField label="New password" type="password" autoComplete="new-password" hint="At least 8 characters. Your other sessions are signed out." value={v.newPassword} onChange={(newPassword) => setV({ ...v, newPassword })} />
      <div><button className="btn primary" type="submit" disabled={change.isPending || !v.currentPassword || !v.newPassword}>Change password</button></div>
    </form>
  );
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  return (
    <Modal title="Save your recovery codes" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>I saved them</button>}>
      <p>Each code signs you in once if you lose your authenticator. They are shown only now: store them somewhere safe (a password manager).</p>
      <ul className="dns-box mono" aria-label="Recovery codes" style={{ columns: 2, listStyle: 'none', margin: 0 }}>{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <CopyButton text={codes.join('\n')} label="Copy all codes" />
    </Modal>
  );
}

function TwoFactor() {
  const { session, refresh } = useAuth();
  const toast = useToast();
  const enabled = session?.user.twoFactorEnabled ?? false;
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [off, setOff] = useState<'disable' | 'recovery' | null>(null);
  const [confirm, setConfirm] = useState({ password: '', code: '' });
  const [error, setError] = useState<string | null>(null);
  const start = useMutate(() => api.post<{ secret: string; otpauthUri: string }>('/api/auth/2fa/setup'));
  const enable = useMutate((c: string) => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code: c }));
  const disable = useMutate(() => api.post('/api/auth/2fa/disable', confirm));
  const regen = useMutate(() => api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery-codes', confirm));
  return (
    <div className="stack">
      <h3>Two-factor authentication</h3>
      {enabled ? (
        <>
          <p>Two-factor authentication is <strong>on</strong>: signing in needs a code from your authenticator app.</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => { setOff('recovery'); setConfirm({ password: '', code: '' }); setError(null); }}>New recovery codes</button>
            <button type="button" className="btn danger" onClick={() => { setOff('disable'); setConfirm({ password: '', code: '' }); setError(null); }}>Turn off</button>
          </div>
        </>
      ) : setup ? (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          enable.mutate(code.trim(), { onSuccess: async (r) => { setSetup(null); setCode(''); setCodes(r.recoveryCodes); await refresh(); toast.push('Two-factor authentication is on', 'ok'); }, onError: (err) => setError(errorMessage(err)) });
        }}>
          <p>Add this account to an authenticator app (Google Authenticator, 1Password, Authy...): scan nothing, just choose "enter a setup key" and paste the key, or open the link on your phone.</p>
          <div className="dns-box row between"><code aria-label="Setup key">{setup.secret}</code><CopyButton text={setup.secret} label="Copy setup key" /></div>
          <a className="small" href={setup.otpauthUri}>Open in an authenticator app</a>
          {error ? <div className="alert error" role="alert">{error}</div> : null}
          <TextField label="Code from the app" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={setCode} />
          <div className="row"><button className="btn primary" type="submit" disabled={enable.isPending || code.trim().length < 6}>Turn on</button><button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button></div>
        </form>
      ) : (
        <>
          <p className="muted">Protect your account with a code from an authenticator app in addition to your password.</p>
          <ErrorBanner error={start.error} />
          <div><button type="button" className="btn primary" disabled={start.isPending} onClick={() => start.mutate(undefined, { onSuccess: setSetup })}>Set up two-factor authentication</button></div>
        </>
      )}
      {codes ? <RecoveryCodes codes={codes} onClose={() => setCodes(null)} /> : null}
      {off ? (
        <Modal title={off === 'disable' ? 'Turn off two-factor authentication' : 'New recovery codes'} onClose={() => setOff(null)}
          footer={<><button type="button" className="btn" onClick={() => setOff(null)}>Cancel</button><button type="button" className={off === 'disable' ? 'btn danger' : 'btn primary'} disabled={disable.isPending || regen.isPending || !confirm.password || !confirm.code}
            onClick={() => {
              setError(null);
              if (off === 'disable') disable.mutate(undefined, { onSuccess: async () => { setOff(null); await refresh(); toast.push('Two-factor authentication is off', 'ok'); }, onError: (err) => setError(errorMessage(err)) });
              else regen.mutate(undefined, { onSuccess: (r) => { setOff(null); setCodes(r.recoveryCodes); }, onError: (err) => setError(errorMessage(err)) });
            }}>{off === 'disable' ? 'Turn off' : 'Create new codes'}</button></>}>
          <p>Confirm with your password and a current code (or a recovery code).{off === 'recovery' ? ' The old recovery codes stop working.' : ' Your other sessions are signed out.'}</p>
          {error ? <div className="alert error" role="alert">{error}</div> : null}
          <TextField label="Password" type="password" autoComplete="current-password" value={confirm.password} onChange={(password) => setConfirm({ ...confirm, password })} data-autofocus />
          <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" value={confirm.code} onChange={(c) => setConfirm({ ...confirm, code: c })} />
        </Modal>
      ) : null}
    </div>
  );
}

function Sessions() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ data: SessionInfo[] }>('/api/auth/sessions') });
  const end = useMutate((id: string) => api.delete(`/api/auth/sessions/${id}`), [['sessions']]);
  const others = useMutate(() => api.post<{ revoked: number }>('/api/auth/sessions/revoke-others'), [['sessions']]);
  return (
    <div className="stack">
      <div className="row between"><h3 style={{ margin: 0 }}>Active sessions</h3>
        <button type="button" className="btn sm" disabled={others.isPending || (q.data?.data.length ?? 0) < 2} onClick={() => others.mutate(undefined, { onSuccess: (r) => toast.push(`${r.revoked} session(s) signed out`, 'ok') })}>Sign out all other sessions</button></div>
      <ErrorBanner error={q.error ?? end.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading rows={2} /> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack" aria-label="Sessions">
        {q.data?.data.map((s) => (
          <li key={s.id} className="card row between">
            <span><strong>{s.current ? 'This session' : (s.userAgent ?? 'Unknown device').slice(0, 60)}</strong><br /><span className="muted small">{s.ip ?? 'unknown address'} · last used {fmtDate(s.lastUsedAt)} · started {fmtDate(s.createdAt)}</span></span>
            {s.current ? <span className="badge">current</span> : <button type="button" className="btn sm danger" disabled={end.isPending} onClick={() => end.mutate(s.id)}>Sign out</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SecurityCard() {
  return (
    <section className="card stack" aria-label="Security">
      <h2>Security</h2>
      <PasswordForm />
      <TwoFactor />
      <Sessions />
    </section>
  );
}
