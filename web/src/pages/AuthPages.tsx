import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { isEmail, validateLogin, validateRegister, type Errors } from '../auth/validate';
import { Loading, TextField } from '../components/ui';

function Frame({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card card stack">
        <div className="mb-1 flex items-center gap-2.5 text-lg font-bold tracking-tight">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-fg shadow-sm"><Zap className="size-[18px]" aria-hidden="true" /></span>
          Funnels
        </div>
        <h1>{title}</h1>
        {children}
        <p className="muted small" style={{ margin: 0 }}>{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, verifyTwoFactor, session } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [v, setV] = useState({ email: '', password: '' });
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/funnels';
  const notice = (loc.state as { notice?: string } | null)?.notice;
  if (session) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      if (challenge) {
        if (!code.trim()) {
          setErrors({ code: 'Enter the code from your authenticator app, or a recovery code' });
          return;
        }
        await verifyTwoFactor(challenge, code.trim());
        nav(from, { replace: true });
        return;
      }
      const errs = validateLogin(v);
      setErrors(errs);
      if (Object.keys(errs).length) return;
      const c = await login(v.email.trim(), v.password);
      if (c) {
        setChallenge(c.challengeToken);
        setErrors({});
      } else nav(from, { replace: true });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <Frame title="Two-factor authentication" footer={<button type="button" className="link" onClick={() => { setChallenge(null); setCode(''); setFormError(null); }}>Start over</button>}>
        <form onSubmit={submit} noValidate>
          {formError ? <div className="alert error" role="alert">{formError}</div> : null}
          <TextField label="Authentication code" autoComplete="one-time-code" inputMode="numeric" hint="The 6 digits from your authenticator app, or one of your recovery codes" value={code} error={errors.code} onChange={setCode} data-autofocus />
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Checking…' : 'Verify'}</button>
        </form>
      </Frame>
    );
  }

  return (
    <Frame title="Sign in" footer={<>No account? <Link to="/register">Create one</Link> · <Link to="/forgot-password">Forgot password?</Link></>}>
      <form onSubmit={submit} noValidate>
        {notice ? <div className="alert ok" role="status">{notice}</div> : null}
        {formError ? <div className="alert error" role="alert">{formError}</div> : null}
        <TextField label="Email" type="email" autoComplete="email" value={v.email} error={errors.email} onChange={(email) => setV({ ...v, email })} />
        <TextField label="Password" type="password" autoComplete="current-password" value={v.password} error={errors.password} onChange={(password) => setV({ ...v, password })} />
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Frame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isEmail(email)) return setError('Enter a valid email address');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password/forgot', { email: email.trim() }, { auth: false });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Reset your password" footer={<Link to="/login">Back to sign in</Link>}>
      {sent ? (
        <div className="alert ok" role="status">If an account exists for {email.trim()}, a message with a reset link is on its way. The link works once and expires in an hour.</div>
      ) : (
        <form onSubmit={submit} noValidate>
          {error ? <div className="alert error" role="alert">{error}</div> : null}
          <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} data-autofocus />
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </Frame>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Errors = {};
    if (password.length < 8) errs.password = 'Password must be at least 8 characters';
    if (again !== password) errs.again = 'The passwords do not match';
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/api/auth/password/reset', { token, password }, { auth: false });
      nav('/login', { replace: true, state: { notice: 'Password changed. Sign in with your new password.' } });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!token) return <Frame title="Reset your password" footer={<Link to="/forgot-password">Request a new link</Link>}><div className="alert error" role="alert">This link is incomplete.</div></Frame>;
  return (
    <Frame title="Choose a new password" footer={<Link to="/login">Back to sign in</Link>}>
      <form onSubmit={submit} noValidate>
        {formError ? <div className="alert error" role="alert">{formError} <Link to="/forgot-password">Request a new link</Link></div> : null}
        <TextField label="New password" type="password" autoComplete="new-password" hint="At least 8 characters. Resetting signs you out everywhere." value={password} error={errors.password} onChange={setPassword} data-autofocus />
        <TextField label="Repeat the new password" type="password" autoComplete="new-password" value={again} error={errors.again} onChange={setAgain} />
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Frame>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { adopt } = useAuth();
  const nav = useNavigate();
  const info = useQuery({ queryKey: ['invitation', token], enabled: !!token, retry: false, queryFn: () => api.get<{ email: string; workspaceName: string; roleName: string }>('/api/auth/invitations/lookup', { token }) });
  const [v, setV] = useState({ name: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Errors = {};
    if (!v.name.trim()) errs.name = 'Enter your name';
    if (v.password.length < 8) errs.password = 'Password must be at least 8 characters';
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      adopt(await api.post<AuthResponse>('/api/auth/invitations/accept', { token, name: v.name.trim(), password: v.password }, { auth: false }));
      nav('/funnels', { replace: true });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!token || info.isError) return <Frame title="Invitation" footer={<Link to="/login">Sign in</Link>}><div className="alert error" role="alert">This invitation link is invalid, already used or expired. Ask the person who invited you to send a new one.</div></Frame>;
  if (info.isLoading) return <Frame title="Invitation" footer=""><Loading rows={2} /></Frame>;
  return (
    <Frame title={`Join ${info.data?.workspaceName ?? 'the workspace'}`} footer={<Link to="/login">Already have an account? Sign in</Link>}>
      <p style={{ margin: 0 }}>You were invited as <strong>{info.data?.roleName}</strong> with <strong>{info.data?.email}</strong>.</p>
      <form onSubmit={submit} noValidate>
        {formError ? <div className="alert error" role="alert">{formError}</div> : null}
        <TextField label="Your name" autoComplete="name" value={v.name} error={errors.name} onChange={(name) => setV({ ...v, name })} data-autofocus />
        <TextField label="Choose a password" type="password" autoComplete="new-password" hint="At least 8 characters" value={v.password} error={errors.password} onChange={(password) => setV({ ...v, password })} />
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Joining…' : 'Accept invitation'}</button>
      </form>
    </Frame>
  );
}

export function RegisterPage() {
  const { register, session } = useAuth();
  const nav = useNavigate();
  const [v, setV] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to="/funnels" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateRegister(v);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await register({ name: v.name.trim(), email: v.email.trim(), password: v.password, workspaceName: v.workspaceName.trim() || undefined });
      nav('/funnels', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') setErrors({ email: err.message });
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Create your workspace" footer={<>Already registered? <Link to="/login">Sign in</Link></>}>
      <form onSubmit={submit} noValidate>
        {formError ? <div className="alert error" role="alert">{formError}</div> : null}
        <TextField label="Your name" autoComplete="name" value={v.name} error={errors.name} onChange={(name) => setV({ ...v, name })} />
        <TextField label="Email" type="email" autoComplete="email" value={v.email} error={errors.email} onChange={(email) => setV({ ...v, email })} />
        <TextField label="Password" type="password" autoComplete="new-password" hint="At least 8 characters" value={v.password} error={errors.password} onChange={(password) => setV({ ...v, password })} />
        <TextField label="Workspace name (optional)" value={v.workspaceName} error={errors.workspaceName} onChange={(workspaceName) => setV({ ...v, workspaceName })} />
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </Frame>
  );
}
