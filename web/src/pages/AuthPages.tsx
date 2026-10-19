import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { validateLogin, validateRegister, type Errors } from '../auth/validate';
import { TextField } from '../components/ui';

function Frame({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card card stack">
        <div className="row"><svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2563eb" /><path d="M7 8h18l-7 8.5V24l-4-2.5v-5z" fill="#fff" /></svg><strong>Funnels</strong></div>
        <h1>{title}</h1>
        {children}
        <p className="muted small" style={{ margin: 0 }}>{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, session } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [v, setV] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/funnels';
  if (session) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateLogin(v);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await login(v.email.trim(), v.password);
      nav(from, { replace: true });
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Sign in" footer={<>No account? <Link to="/register">Create one</Link></>}>
      <form onSubmit={submit} noValidate>
        {formError ? <div className="alert error" role="alert">{formError}</div> : null}
        <TextField label="Email" type="email" autoComplete="email" value={v.email} error={errors.email} onChange={(email) => setV({ ...v, email })} />
        <TextField label="Password" type="password" autoComplete="current-password" value={v.password} error={errors.password} onChange={(password) => setV({ ...v, password })} />
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
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
