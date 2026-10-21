import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { keys, useDomains, useMutate, useTags } from '../api/hooks';
import { useAddresses } from '../api/golive';
import type { FunnelDetail, PathConflict } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConflictDialog } from '../components/ConflictDialog';
import { useToast } from '../components/Toasts';
import { FunnelTracking } from './growth/TrackingCards';
import { PublishingCard } from './growth/PublishingCard';
import { GoLivePanel } from '../components/GoLive';
import { ConfirmDialog, ErrorBanner, Field, StatusBadge, TextField } from '../components/ui';

interface Form {
  name: string;
  status: 'live' | 'test';
  domainId: string;
  tags: string[];
  favicon: string;
  header: string;
  footer: string;
}

const fromFunnel = (f: FunnelDetail): Form => ({ name: f.name, status: f.status, domainId: f.domain?.id ?? '', tags: f.tags.map((t) => t.id), favicon: f.favicon ?? '', header: f.headerTrackingCode ?? '', footer: f.footerTrackingCode ?? '' });

export function validateSettings(f: Form): Partial<Record<'name' | 'domainId' | 'favicon', string>> {
  const e: Partial<Record<'name' | 'domainId' | 'favicon', string>> = {};
  if (!f.name.trim()) e.name = 'Give the funnel a name';
  if (f.status === 'live' && !f.domainId) e.domainId = 'Choose a connected domain to publish this funnel';
  if (f.favicon && !/^(https?:\/\/|\/)/i.test(f.favicon)) e.favicon = 'Use an http(s) URL';
  return e;
}

/** Builds the PATCH body from only the fields that changed. `status: test` always detaches the domain on the server. */
export function buildPatch(orig: Form, next: Form, includeCode: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (next.name.trim() !== orig.name) body.name = next.name.trim();
  if (next.status !== orig.status) body.status = next.status;
  if (next.domainId !== orig.domainId) body.domain_id = next.domainId || null;
  if (next.favicon !== orig.favicon) body.favicon = next.favicon || null;
  if ([...next.tags].sort().join() !== [...orig.tags].sort().join()) body.tags = next.tags;
  if (includeCode && next.header !== orig.header) body.header_tracking_code = next.header;
  if (includeCode && next.footer !== orig.footer) body.footer_tracking_code = next.footer;
  return body;
}

export function SettingsTab({ funnel }: { funnel: FunnelDetail }) {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const domains = useDomains();
  const addresses = useAddresses(funnel.id);
  const builtin = addresses.data?.options.find((o) => o.kind === 'builtin' && o.domainId) ?? null;
  const tags = useTags();
  const orig = useMemo(() => fromFunnel(funnel), [funnel]);
  const [f, setF] = useState<Form>(orig);
  const [conflicts, setConflicts] = useState<PathConflict[] | null>(null);
  const [trashing, setTrashing] = useState(false);
  const [newTag, setNewTag] = useState('');
  useEffect(() => setF(orig), [orig]);

  const save = useMutate((body: Record<string, unknown>) => api.patch(`/api/funnels/${funnel.id}`, body), [keys.funnel(funnel.id), keys.funnels, keys.domains]);
  const createTag = useMutate((name: string) => api.post<{ id: string }>('/api/tags', { name }), [keys.tags]);
  const trash = useMutate(() => api.delete(`/api/funnels/${funnel.id}`), [keys.funnels, keys.trash]);
  const dup = useMutate(() => api.post<FunnelDetail>(`/api/funnels/${funnel.id}/duplicate`), [keys.funnels]);
  const errors = validateSettings(f);
  const active = (domains.data?.data ?? []).filter((d) => d.status === 'active');
  const patch = buildPatch(orig, f, can('funnels:tracking'));
  const dirty = Object.keys(patch).length > 0;

  const submit = (extra: Record<string, unknown> = {}) =>
    save.mutate({ ...patch, ...extra }, {
      onSuccess: () => { toast.push('Settings saved', 'ok'); setConflicts(null); },
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'PATH_CONFLICT') setConflicts((e.details as { conflicts: PathConflict[] }).conflicts);
        else setConflicts(null);
      },
    });

  const preview = async () => {
    try {
      const t = await api.post<{ url: string }>(`/api/funnels/${funnel.id}/preview-token`);
      window.open(t.url, '_blank', 'noopener');
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="card" id="go-live"><GoLivePanel funnel={funnel} /></div>
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); if (!Object.keys(errors).length && dirty) submit(); }}>
        <h2>General</h2>
        <ErrorBanner error={save.error && !(save.error instanceof ApiError && save.error.code === 'PATH_CONFLICT') ? save.error : null} />
        <TextField label="Funnel name" value={f.name} error={errors.name} onChange={(name) => setF({ ...f, name })} />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <Field label="Status" hint="Test funnels are only reachable through signed previews. Setting a funnel to test disconnects its domain.">
            {(p) => <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Form['status'] })} {...p}><option value="test">Test</option><option value="live">Live</option></select>}
          </Field>
          <Field label="Domain" error={errors.domainId} hint={domains.data && active.length === 0 ? 'The built-in address needs nothing. To use your own domain, add and verify it on the Domains page.' : 'The built-in address, or a verified domain.'}>
            {(p) => (
              <select className="input" value={f.domainId} onChange={(e) => setF({ ...f, domainId: e.target.value })} {...p}>
                <option value="">None</option>
                {builtin ? <option value={builtin.domainId!}>Built-in address (free)</option> : null}
                {active.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}
                {funnel.domain && !active.some((d) => d.id === funnel.domain!.id) && funnel.domain.id !== builtin?.domainId ? <option value={funnel.domain.id}>{funnel.domain.hostname}</option> : null}
              </select>
            )}
          </Field>
        </div>
        {funnel.domain ? <p className="small">Connected to <strong>{funnel.domain.hostname}</strong> <StatusBadge status={funnel.domain.status} /> {funnel.status === 'live' ? <a href={funnel.address?.url ?? `https://${funnel.domain.hostname}${funnel.basePath}`} target="_blank" rel="noopener noreferrer">Open live page</a> : null}</p> : null}

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
          <legend className="label">Tags</legend>
          <div className="row">
            {tags.data?.data.map((t) => <label key={t.id} className="check"><input type="checkbox" checked={f.tags.includes(t.id)} onChange={() => setF({ ...f, tags: f.tags.includes(t.id) ? f.tags.filter((x) => x !== t.id) : [...f.tags, t.id] })} />{t.name}</label>)}
            {tags.data?.data.length === 0 ? <span className="muted small">No tags yet.</span> : null}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="sr-only" htmlFor="new-tag">New tag name</label>
            <input id="new-tag" className="input" style={{ maxWidth: 220 }} placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
            <button type="button" className="btn sm" disabled={!newTag.trim() || createTag.isPending} onClick={() => createTag.mutate(newTag.trim(), { onSuccess: (t) => { setF((s) => ({ ...s, tags: [...s.tags, t.id] })); setNewTag(''); }, onError: (e) => toast.push(errorMessage(e), 'error') })}>Add tag</button>
          </div>
        </fieldset>

        <TextField label="Favicon URL" value={f.favicon} error={errors.favicon} hint="Shown in the browser tab of published pages." onChange={(favicon) => setF({ ...f, favicon })} />
        {can('funnels:tracking') ? (
          <>
            <Field label="Header tracking code" hint="Injected into every page's <head>. Only served when the workspace allows custom scripts (Settings).">{(p) => <textarea className="input mono" rows={3} value={f.header} onChange={(e) => setF({ ...f, header: e.target.value })} {...p} />}</Field>
            <Field label="Footer tracking code" hint="Injected before </body>.">{(p) => <textarea className="input mono" rows={3} value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} {...p} />}</Field>
          </>
        ) : <p className="muted small">Tracking codes can be edited by admins.</p>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={!dirty || save.isPending || Object.keys(errors).length > 0}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="btn" onClick={() => void preview()}>Open signed preview</button>
        </div>
      </form>

      <FunnelTracking funnel={funnel} />
      <PublishingCard funnel={funnel} />

      <div className="card">
        <h2>Actions</h2>
        <div className="row">
          <button type="button" className="btn" disabled={dup.isPending} onClick={() => dup.mutate(undefined, { onSuccess: (n) => { toast.push(`Created "${n.name}"`, 'ok'); nav(`/funnels/${n.id}`); } })}>Duplicate funnel</button>
          {can('funnels:delete') ? <button type="button" className="btn danger" onClick={() => setTrashing(true)}>Move to trash</button> : <span className="muted small">Admins can delete funnels.</span>}
        </div>
      </div>

      {conflicts ? <ConflictDialog conflicts={conflicts} busy={save.isPending} onCancel={() => setConflicts(null)} onConfirm={(res) => submit({ conflicts: res })} /> : null}
      {trashing ? <ConfirmDialog danger title="Move funnel to trash?" confirmLabel="Move to trash" busy={trash.isPending} message="It stops being served and its domain is detached. You can restore it from the trash." onCancel={() => setTrashing(false)} onConfirm={() => trash.mutate(undefined, { onSuccess: () => { toast.push('Moved to trash', 'ok'); nav('/funnels'); }, onError: () => setTrashing(false) })} /> : null}
    </div>
  );
}
