import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { keys, useMutate } from '../api/hooks';
import type { FunnelDetail } from '../api/types';
import { TemplateGallery } from '../components/TemplateGallery';
import { useToast } from '../components/Toasts';
import { ErrorBanner, TextField } from '../components/ui';
import { AiBuilderWizard } from './AiBuilder';

type Mode = 'blank' | 'template' | 'ai';

export const slugify = (name: string): string => {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `/${s || 'funnel'}`;
};

export function validateBlank(v: { name: string; path: string }): Partial<Record<'name' | 'path', string>> {
  const e: Partial<Record<'name' | 'path', string>> = {};
  if (!v.name.trim()) e.name = 'Give the funnel a name';
  else if (v.name.trim().length > 120) e.name = 'Name must be at most 120 characters';
  if (!/^\/([a-zA-Z0-9-]|%[0-9A-Fa-f]{2})*([^/.]\/?)?$/.test(v.path) || /[\s?#\\]/.test(v.path)) e.path = 'Use a path like /my-offer: letters, digits and "-" only, no nested segments';
  return e;
}

function BlankForm() {
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [touchedPath, setTouchedPath] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutate((b: { name: string; base_path: string }) => api.post<FunnelDetail>('/api/funnels', b), [keys.funnels]);
  const effectivePath = touchedPath ? path : slugify(name);
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const errs = validateBlank({ name, path: effectivePath });
        setErrors(errs as Record<string, string>);
        if (Object.keys(errs).length) return;
        create.mutate({ name: name.trim(), base_path: effectivePath }, {
          onSuccess: (f) => { toast.push('Funnel created', 'ok'); nav(`/funnels/${f.id}`); },
          onError: (err) => { if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors); },
        });
      }}
    >
      <ErrorBanner error={create.error && !(create.error instanceof ApiError && Object.keys(create.error.fieldErrors).length) ? create.error : null} />
      <TextField label="Funnel name" value={name} error={errors.name} onChange={setName} autoFocus />
      <TextField label="First page path" value={effectivePath} error={errors.path} hint="The address of the first step, e.g. /my-offer" onChange={(v) => { setTouchedPath(true); setPath(v); }} />
      <div><button className="btn primary" type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create funnel'}</button></div>
    </form>
  );
}

export function validateAi(v: { business: string }): Partial<Record<'business', string>> {
  return v.business.trim() ? {} : { business: 'Describe your business in a sentence or two' };
}

export function NewFunnelPage() {
  const [mode, setMode] = useState<Mode>('blank');
  const nav = useNavigate();
  const options: [Mode, string, string][] = [['blank', 'Blank funnel', 'One empty landing page. You design the rest.'], ['template', 'From a template', 'Pick a proven funnel and customise it.'], ['ai', 'Generate with AI', 'Describe your business and get a first draft.']];
  return (
    <div className="stack">
      <div className="row between"><h1>New funnel</h1><Link to="/funnels" className="btn ghost">Cancel</Link></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }} role="group" aria-label="How do you want to start?">
        {options.map(([k, title, desc]) => (
          <button key={k} type="button" className="choice" aria-pressed={mode === k} onClick={() => setMode(k)}><h3>{title}</h3><span className="muted small">{desc}</span></button>
        ))}
      </div>
      <div className="card">
        {mode === 'blank' ? <BlankForm /> : null}
        {mode === 'template' ? <TemplateGallery onCreated={(f) => nav(`/funnels/${f.id}`)} /> : null}
        {mode === 'ai' ? <AiBuilderWizard /> : null}
      </div>
    </div>
  );
}
