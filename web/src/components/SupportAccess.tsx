import { useState } from 'react';
import { ErrorBanner, Modal, TextField } from './ui';

export interface Impersonation { by: string; expiresAt: string | null; readOnly?: boolean; allowWrites?: boolean }

/** Must match WRITE_REASON_MIN on the server (services/admin.ts). */
export const WRITE_REASON_MIN = 20;

/**
 * The banner shown for the whole support session. Read-only is the default and looks like a notice; a write-enabled session is a red alert, because the person
 * on the other side of it can change the customer's data.
 */
export function SupportBanner({ imp, email, onEnd }: { imp: Impersonation; email: string | undefined; onEnd: () => void }) {
  const writes = imp.allowWrites === true;
  const ends = imp.expiresAt ? ` Ends ${new Date(imp.expiresAt).toLocaleTimeString()}.` : '';
  return (
    <div className={`alert${writes ? ' error' : ''}`} role="status" data-support-mode={writes ? 'read_write' : 'read_only'} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', ...(writes ? { borderWidth: 2, fontWeight: 600 } : {}) }}>
      {writes ? (
        <span><strong>Support access with WRITE permission.</strong> You are acting as {email} ({imp.by}) and every change you make is recorded in their audit log.{ends} Credentials, billing, members and API keys are still off limits.</span>
      ) : (
        <span><strong>Support access (read-only).</strong> You are viewing as {email} ({imp.by}); nothing can be changed.{ends}</span>
      )}
      <button type="button" className="btn sm" onClick={onEnd}>End session</button>
    </div>
  );
}

/** Reason (and, for superadmins, the explicit opt-in to writes) for opening a support session. */
export function SupportSessionDialog({ canWrite, busy, error, onClose, onSubmit }: { canWrite: boolean; busy: boolean; error: unknown; onClose: () => void; onSubmit: (reason: string, allowWrites: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [writes, setWrites] = useState(false);
  const min = writes ? WRITE_REASON_MIN : 5;
  return (
    <Modal title="Act as the owner" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className={`btn ${writes ? 'danger' : 'primary'}`} disabled={busy || reason.trim().length < min} onClick={() => onSubmit(reason.trim(), writes)}>Start support session</button></>}>
      <ErrorBanner error={error} />
      <p>{writes ? 'A short session in which you can change the customer\'s data.' : 'A read-only session as the workspace owner: you can look, nothing can be changed.'} It is recorded in the workspace's own audit log. Credentials, billing, members and API keys stay off limits.</p>
      <div className="field"><label className="check"><input type="checkbox" checked={writes} disabled={!canWrite} onChange={(e) => setWrites(e.target.checked)} /> Allow changes (writes)</label>{!canWrite ? <p className="muted small">Only a superadmin can open a session that may change data.</p> : null}</div>
      <TextField label="Reason (recorded in the audit log)" hint={writes ? `At least ${WRITE_REASON_MIN} characters: say what will be changed and why.` : undefined} value={reason} onChange={setReason} data-autofocus />
    </Modal>
  );
}
