import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { keys, useMutate } from '../api/hooks';
import type { FunnelDetail } from '../api/types';
import { TemplateGallery } from '../components/TemplateGallery';
import { useToast } from '../components/Toasts';
import { ErrorBanner, Field, TextField } from '../components/ui';

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

const GOALS = [['leads', 'Collect leads (opt-in + thank you)'], ['webinar', 'Webinar registration'], ['sales', 'Sell a product (offer, bump, upsell)'], ['booking', 'Book calls']] as const;
const TONES = ['persuasive', 'friendly', 'concise', 'formal'] as const;

export function validateAi(v: { business: string }): Partial<Record<'business', string>> {
  return v.business.trim() ? {} : { business: 'Describe your business in a sentence or two' };
}

function AiForm() {
  const nav = useNavigate();
  const toast = useToast();
  const [v, setV] = useState({ business: '', goal: 'leads', tone: 'persuasive', audience: '', steps: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const gen = useMutate((b: object) => api.post<{ funnel: FunnelDetail; source: string }>('/api/ai/funnel', b), [keys.funnels]);
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const errs = validateAi(v);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        gen.mutate({ business: v.business, goal: v.goal, tone: v.tone, audience: v.audience, ...(v.steps ? { steps: Number(v.steps) } : {}) }, {
          onSuccess: (r) => {
            toast.push(r.source === 'model' ? 'Funnel drafted with AI' : 'Funnel drafted from built-in copy templates', 'ok');
            nav(`/funnels/${r.funnel.id}`);
          },
        });
      }}
    >
      <ErrorBanner error={gen.error} />
      <Field label="What does your business do?" error={errors.business} hint="Up to 1,500 characters are used.">
        {(p) => <textarea className="input" rows={4} value={v.business} onChange={(e) => setV({ ...v, business: e.target.value })} {...p} />}
      </Field>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Field label="Goal">{(p) => <select className="input" value={v.goal} onChange={(e) => setV({ ...v, goal: e.target.value })} {...p}>{GOALS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Tone">{(p) => <select className="input" value={v.tone} onChange={(e) => setV({ ...v, tone: e.target.value })} {...p}>{TONES.map((t) => <option key={t}>{t}</option>)}</select>}</Field>
        <Field label="Steps" hint="Leave empty for the recommended number.">{(p) => <select className="input" value={v.steps} onChange={(e) => setV({ ...v, steps: e.target.value })} {...p}><option value="">Recommended</option>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>}</Field>
      </div>
      <TextField label="Who is it for?" value={v.audience} onChange={(audience) => setV({ ...v, audience })} />
      <p className="muted small">The AI writes the copy only. Page structure, forms and checkout blocks are built from fixed layouts, and you can edit everything afterwards.</p>
      <div><button className="btn primary" type="submit" disabled={gen.isPending}>{gen.isPending ? 'Generating…' : 'Generate funnel'}</button></div>
    </form>
  );
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
        {mode === 'ai' ? <AiForm /> : null}
      </div>
    </div>
  );
}
