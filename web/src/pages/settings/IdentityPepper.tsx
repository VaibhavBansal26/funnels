import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from '../../api/client';
import { useMutate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toasts';
import { ConfirmDialog, CopyButton, ErrorBanner, fmtDate, Loading, TextField } from '../../components/ui';

export interface PepperInfo {
  pepper: string;
  version: number;
  algorithm: string;
  fingerprint: string;
  rotatedAt: string | null;
}

const pepperKey = ['pepper'] as const;

/** Messages for the two validation codes of PUT /api/v1/analytics/identity-pepper; anything else shows the server's own message. */
export function pepperErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === 'PEPPER_CONFIRM_MISMATCH') return 'The two values do not match. Paste the same pepper again.';
  if (e instanceof ApiError && e.code === 'INVALID_PEPPER') return e.message;
  return errorMessage(e);
}

/**
 * Settings > API access > Identity pepper. Shows the fingerprint (first 8 hex of SHA-256, safe to compare between apps), reveals the secret on request,
 * imports a pepper chosen in another app (typed twice) and rotates. Both writes need `analytics_identity:manage` AND `analytics:export`, exactly like the
 * routes; without them the controls are disabled and say why.
 */
export function IdentityPepper() {
  const { can } = useAuth();
  const toast = useToast();
  const allowed = can('analytics_identity:manage') && can('analytics:export');
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const q = useQuery({ queryKey: pepperKey, enabled: allowed, queryFn: () => api.get<PepperInfo>('/api/v1/analytics/identity-pepper') });
  const rotate = useMutate(() => api.post<PepperInfo>('/api/v1/analytics/identity-pepper/rotate'), [pepperKey]);
  const set = useMutate(() => api.put<PepperInfo>('/api/v1/analytics/identity-pepper', { pepper: value, confirm }), [pepperKey]);
  const info = q.data;
  const importError = set.error ? pepperErrorMessage(set.error) : undefined;
  const isMismatch = set.error instanceof ApiError && set.error.code === 'PEPPER_CONFIRM_MISMATCH';
  return (
    <div className="stack" data-testid="identity-pepper">
      <h3>Identity pepper</h3>
      <p className="muted small">Exports identify people with keys computed from emails and this secret, never with the emails themselves. Two apps that hold the same pepper compute the same keys, so their data can be joined without sharing personal data. Treat it like a password.</p>
      {!allowed ? <p className="muted small" role="note">Managing the pepper needs the permissions analytics_identity:manage and analytics:export. Ask an owner for access.</p> : null}
      <ErrorBanner error={q.error ?? rotate.error} />
      {q.isLoading ? <Loading rows={1} /> : null}
      {info ? (
        <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span>Fingerprint <code aria-label="Pepper fingerprint">{info.fingerprint}</code> <span className="muted small">(first 8 hex of SHA-256; version {info.version})</span></span>
          <CopyButton text={info.fingerprint} label="Copy fingerprint" />
        </div>
      ) : null}
      {shown && info ? (
        <div className="dns-box row between"><code aria-label="Identity pepper" style={{ wordBreak: 'break-all' }}>{info.pepper}</code><CopyButton text={info.pepper} label="Copy pepper" /></div>
      ) : null}
      <div className="row">
        <button type="button" className="btn" disabled={!allowed || !info} onClick={() => setShown((s) => !s)}>{shown ? 'Hide' : 'Show the pepper'}</button>
        <button type="button" className="btn danger" disabled={!allowed} onClick={() => setRotating(true)}>Rotate</button>
      </div>
      {info?.rotatedAt ? <p className="muted small">Last changed {fmtDate(info.rotatedAt)}.</p> : null}

      <form
        className="stack"
        aria-label="Import a pepper"
        onSubmit={(e) => {
          e.preventDefault();
          if (!allowed) return;
          set.mutate(undefined, {
            onSuccess: (r) => { setValue(''); setConfirm(''); setShown(false); toast.push(`Pepper imported (fingerprint ${r.fingerprint})`, 'ok'); },
          });
        }}
      >
        <h4 style={{ margin: 0 }}>Import a pepper</h4>
        <p className="muted small">Use the pepper another app already has, so both derive the same keys. 32 to 256 printable characters with no spaces; a hex value needs 64 characters. Changing it changes every exported key and is recorded in the audit log.</p>
        <TextField label="Pepper" type="password" autoComplete="off" spellCheck={false} value={value} onChange={setValue} disabled={!allowed} error={importError && !isMismatch ? importError : undefined} />
        <TextField label="Type the pepper again" type="password" autoComplete="off" spellCheck={false} value={confirm} onChange={setConfirm} disabled={!allowed} error={isMismatch ? importError : undefined} />
        <div><button type="submit" className="btn primary" disabled={!allowed || set.isPending || !value || !confirm}>{set.isPending ? 'Importing…' : 'Import pepper'}</button></div>
      </form>

      {rotating ? (
        <ConfirmDialog
          danger
          title="Rotate the pepper?"
          confirmLabel="Rotate"
          busy={rotate.isPending}
          message="Rotating creates a new random pepper. Every contact_key and visitor_key in future exports changes, which breaks the join with any other app until the same pepper is set there. This is recorded in the audit log."
          onCancel={() => setRotating(false)}
          onConfirm={() => rotate.mutate(undefined, { onSuccess: () => { setRotating(false); setShown(true); toast.push('Pepper rotated', 'ok'); }, onError: () => setRotating(false) })}
        />
      ) : null}
    </div>
  );
}
