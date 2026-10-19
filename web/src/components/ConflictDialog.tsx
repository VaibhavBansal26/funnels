import { useState } from 'react';
import type { PathConflict } from '../api/types';
import { Modal } from './ui';

export const PATH_RE = /^\/([a-zA-Z0-9-]|%[0-9A-Fa-f]{2})*([^/.]\/?)?$/;

/** Returns an error message per conflicting path when a chosen replacement is empty, invalid or chosen twice. */
export function validateResolutions(items: { path: string; resolved_path: string }[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const i of items) {
    const key = i.resolved_path.toLowerCase().replace(/(.)\/$/, '$1');
    if (!PATH_RE.test(i.resolved_path) || /[\s?#\\]/.test(i.resolved_path)) errors[i.path] = 'Use a path like /offer-1002: letters, digits and "-" only';
    else if (seen.has(key)) errors[i.path] = `Already used for ${seen.get(key)}`;
    seen.set(key, i.path);
  }
  return errors;
}

/** Shown when connecting a funnel to a domain whose other funnels already use some of its paths. */
export function ConflictDialog({ conflicts, busy, onConfirm, onCancel }: { conflicts: PathConflict[]; busy?: boolean; onConfirm: (resolutions: { path: string; resolved_path: string }[]) => void; onCancel: () => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(conflicts.map((c) => [c.path, c.resolved_path])));
  const items = conflicts.map((c) => ({ path: c.path, resolved_path: values[c.path] ?? '' }));
  const errors = validateResolutions(items);
  const invalid = Object.keys(errors).length > 0;
  return (
    <Modal
      title="Some paths are already taken on this domain"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" disabled={invalid || busy} onClick={() => onConfirm(items)}>Rename paths and connect</button>
        </>
      }
    >
      <p>Other funnels on this domain use the paths below. Choose new paths for this funnel's steps, then connect.</p>
      <table className="table">
        <thead><tr><th scope="col">Current path</th><th scope="col">Used by</th><th scope="col">New path</th></tr></thead>
        <tbody>
          {conflicts.map((c, i) => (
            <tr key={c.path}>
              <td><code>{c.path}</code></td>
              <td className="small">{c.conflictsWith ? `${c.conflictsWith.funnelName} → ${c.conflictsWith.stepName}` : '—'}</td>
              <td>
                <label className="sr-only" htmlFor={`resolve-${i}`}>New path for {c.path}</label>
                <input id={`resolve-${i}`} className="input" value={values[c.path] ?? ''} aria-invalid={errors[c.path] ? true : undefined} aria-describedby={errors[c.path] ? `resolve-${i}-err` : undefined} onChange={(e) => setValues({ ...values, [c.path]: e.target.value })} />
                {errors[c.path] ? <span id={`resolve-${i}-err`} className="error small" role="alert">{errors[c.path]}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
