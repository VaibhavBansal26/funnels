import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, errorMessage } from '../api/client';
import { buildKey, isActive, saveBuildId, savedBuildId, useBuild, type Build, type BuildStage } from '../api/aibuild';
import { keys, useMutate, useProducts } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toasts';
import { ErrorBanner, Field, TextField } from '../components/ui';

const GOALS = [['', 'Let the AI decide'], ['leads', 'Collect leads'], ['webinar', 'Webinar registration'], ['sales', 'Sell a product'], ['booking', 'Book calls'], ['events', 'Sell event tickets'], ['donations', 'Take donations']] as const;
const TONES = ['', 'persuasive', 'friendly', 'concise', 'formal', 'playful', 'authoritative'] as const;

export function validateBrief(v: { prompt: string; offer: string }): Partial<Record<'prompt', string>> {
  return v.prompt.trim() || v.offer.trim() ? {} : { prompt: 'Describe your business in a sentence or two' };
}

const STATUS_LABEL: Record<BuildStage['status'], string> = { pending: 'Waiting', running: 'Working', done: 'Done', fallback: 'Built-in writer used', failed: 'Failed', skipped: 'Skipped' };
const MARK: Record<BuildStage['status'], string> = { pending: '○', running: '◐', done: '✓', fallback: '!', failed: '×', skipped: '–' };

export function StageList({ stages }: { stages: BuildStage[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Progress">
      {stages.map((s) => (
        <li key={s.id} className="flex items-start gap-3" aria-current={s.status === 'running' ? 'step' : undefined} data-status={s.status}>
          <span aria-hidden className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-sm ${s.status === 'done' ? 'border-ok text-ok' : s.status === 'fallback' ? 'border-warn text-warn' : s.status === 'failed' ? 'border-danger text-danger' : s.status === 'running' ? 'border-primary text-primary' : 'border-border text-muted'}`}>{MARK[s.status]}</span>
          <span className="flex flex-col">
            <span className={s.status === 'pending' ? 'text-muted' : 'font-medium'}>{s.label}<span className="sr-only"> — {STATUS_LABEL[s.status]}</span></span>
            {s.detail ? <span className="small muted">{s.detail}</span> : null}
            {s.attempts && s.attempts > 1 && s.status === 'running' ? <span className="small muted">Checking the answer again ({s.attempts})</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

const SOURCE_NOTE: Record<NonNullable<Build['source']>, string> = {
  model: 'Written by the AI model, checked by the rules below.',
  heuristic: 'Written by the built-in writer (no AI model is configured), so the same description always gives the same funnel.',
  fallback: 'The AI model could not be used for some parts, so the built-in writer filled in. The funnel passed the same checks.',
};

export function BuildResult({ build, onAgain }: { build: Build; onAgain: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const regen = useMutate((key: string) => api.post<{ message?: string; source: string }>(`/api/ai/builds/${build.id}/steps/${key}/regenerate`, {}), [buildKey(build.id)]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const checks = build.report?.checks ?? [];
  const problems = checks.filter((c) => c.status !== 'pass');
  const stepName = (k?: string) => build.steps?.find((s) => s.key === k)?.name;
  return (
    <div className="stack" data-testid="build-result">
      <div className="alert ok" role="status"><strong>Your funnel is ready.</strong> It was saved in test status, so nothing is live until you publish it.</div>
      {build.degraded ? <div className="alert warn" role="status">Some parts used the built-in writer instead of the AI model: {build.report?.fallbacks?.map((f) => f.reason).slice(0, 2).join(' ')}</div> : null}
      <p className="muted small">{build.source ? SOURCE_NOTE[build.source] : null} {build.model ? `Model: ${build.model}. ` : ''}{build.usage.calls ? `${build.usage.inputTokens + build.usage.outputTokens} tokens in ${build.usage.calls} calls.` : ''}</p>

      {build.strategy ? (
        <section className="stack" aria-label="Strategy">
          <h3>The plan</h3>
          <p>{build.strategy.rationale}</p>
          <ol className="row" style={{ flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
            {build.strategy.steps.map((s, i) => <li key={s.key} className="badge primary">{i + 1}. {s.name}</li>)}
          </ol>
          {build.strategy.templates[0] ? <p className="small muted">Visual style borrowed from the closest template: {build.strategy.templates[0].name} ({build.strategy.templates[0].reason}).</p> : null}
        </section>
      ) : null}

      {build.assumptions.length ? (
        <section className="stack" aria-label="Assumptions">
          <h3>Assumptions we made</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">{build.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          <p className="small muted">Wrong about something? Edit the pages, or describe it more precisely and generate again.</p>
        </section>
      ) : null}

      {build.products?.length ? (
        <section className="stack" aria-label="Draft products">
          <h3>Draft products in your catalog</h3>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">{build.products.map((p) => <li key={p.slot}>{p.name}: {p.amount} {p.currency}</li>)}</ul>
          <p className="small muted">They are not synced to Stripe. Check names, descriptions and prices in Products before you publish.</p>
        </section>
      ) : null}

      <section className="stack" aria-label="Checks">
        <h3>Checks</h3>
        <p className="small">{checks.filter((c) => c.status === 'pass').length} of {checks.length} checks passed{problems.length ? `, ${problems.length} to review` : ''}.</p>
        {problems.length ? <ul className="m-0 flex list-disc flex-col gap-1 pl-5 small">{problems.slice(0, 8).map((c, i) => <li key={i}>{c.status === 'warn' ? 'Review: ' : 'Problem: '}{stepName(c.step) ? `${stepName(c.step)}: ` : ''}{c.detail}</li>)}</ul> : null}
      </section>

      {build.steps?.length ? (
        <section className="stack" aria-label="Pages">
          <h3>Pages</h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {build.steps.map((s) => (
              <li key={s.key} className="row between">
                <span>{s.name}</span>
                <button type="button" className="btn sm" disabled={regen.isPending} aria-label={`Rewrite ${s.name}`} onClick={() => {
                  setBusyKey(s.key);
                  regen.mutate(s.key, { onSuccess: (r) => { toast.push(r.message ?? `${s.name} rewritten`, r.message ? 'info' : 'ok'); void qc.invalidateQueries({ queryKey: keys.funnels }); }, onSettled: () => setBusyKey(null) });
                }}>{busyKey === s.key ? 'Rewriting…' : 'Rewrite this page'}</button>
              </li>
            ))}
          </ul>
          <p className="small muted">Rewriting replaces that page's text with a new version. The old one stays in the page's version history.</p>
          <ErrorBanner error={regen.error} />
        </section>
      ) : null}

      <div className="row">
        <button type="button" className="btn primary" onClick={() => { saveBuildId(null); nav(`/funnels/${build.funnelId}`); }}>Open the funnel</button>
        <button type="button" className="btn" onClick={onAgain}>Start another</button>
      </div>
    </div>
  );
}

function Progress({ build, onAgain }: { build: Build; onAgain: () => void }) {
  const cancel = useMutate(() => api.post(`/api/ai/builds/${build.id}/cancel`), [buildKey(build.id)]);
  if (build.status === 'succeeded') return <BuildResult build={build} onAgain={onAgain} />;
  const failed = build.status === 'failed' || build.status === 'canceled';
  return (
    <div className="stack" data-testid="build-progress">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{build.status === 'canceled' ? 'Cancelled' : failed ? 'The funnel could not be built' : 'Building your funnel'}</h3>
        {isActive(build) ? <button type="button" className="btn sm" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined)}>Cancel</button> : null}
      </div>
      {isActive(build) ? <p className="small muted" role="status">You can leave this page: the build continues and shows up here when you come back.</p> : null}
      <StageList stages={build.stages.length ? build.stages : [{ id: 'queued', label: 'Waiting to start', status: 'running' }]} />
      {build.assumptions.length && isActive(build) ? <div className="small muted"><strong>So far we assume:</strong><ul className="m-0 flex list-disc flex-col gap-1 pl-5">{build.assumptions.slice(0, 4).map((a) => <li key={a}>{a}</li>)}</ul></div> : null}
      {build.status === 'failed' ? <div className="alert error" role="alert">{build.error?.message ?? 'Something went wrong.'}</div> : null}
      <ErrorBanner error={cancel.error} />
      {failed ? <div><button type="button" className="btn primary" onClick={onAgain}>Change the description and try again</button></div> : null}
    </div>
  );
}

export function AiBuilderWizard() {
  const toast = useToast();
  const { can } = useAuth();
  const [id, setId] = useState<string | null>(() => savedBuildId());
  const [v, setV] = useState({ prompt: '', offer: '', audience: '', goal: '', tone: '', priceMin: '', priceMax: '', currency: 'USD', avoid: '', steps: '', products: 'none', redact: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const products = useProducts({ status: 'active', limit: 20 });
  const [picked, setPicked] = useState<string[]>([]);
  const q = useBuild(id);
  const start = useMutate((b: object) => api.post<Build>('/api/ai/builds', b), []);
  const again = () => { saveBuildId(null); setId(null); };

  const gone = !!id && q.error instanceof ApiError && q.error.status === 404;
  useEffect(() => { if (gone) again(); }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps
  if (id && q.data) return <Progress build={q.data} onAgain={again} />;
  if (id && q.isLoading) return <p className="muted" role="status">Loading your build…</p>;

  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const canCreate = can('products:write');
  const existing = products.data?.data ?? [];
  const submit = () => {
    const errs = validateBrief(v);
    const min = num(v.priceMin);
    const max = num(v.priceMax);
    if (min !== undefined && (!Number.isFinite(min) || min < 0)) (errs as Record<string, string>).priceMin = 'Enter a price such as 29';
    if (max !== undefined && (!Number.isFinite(max) || max < 0)) (errs as Record<string, string>).priceMax = 'Enter a price such as 99';
    if (min !== undefined && max !== undefined && min > max) (errs as Record<string, string>).priceMax = 'The maximum must be at least the minimum';
    setErrors(errs as Record<string, string>);
    if (Object.keys(errs).length) return;
    const structured = {
      ...(v.offer.trim() ? { offer: v.offer.trim() } : {}), ...(v.audience.trim() ? { audience: v.audience.trim() } : {}), ...(v.goal ? { goal: v.goal } : {}), ...(v.tone ? { tone: v.tone } : {}),
      ...(min !== undefined ? { priceMin: min } : {}), ...(max !== undefined ? { priceMax: max } : {}), ...(min !== undefined || max !== undefined ? { currency: v.currency.toUpperCase() } : {}),
      ...(v.avoid.trim() ? { avoid: v.avoid.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    };
    start.mutate({ prompt: v.prompt, structured: Object.keys(structured).length ? structured : undefined, options: { products: v.products, redactPii: v.redact, ...(v.steps ? { steps: Number(v.steps) } : {}), ...(v.products === 'existing' && picked.length ? { productIds: picked } : {}) } }, {
      onSuccess: (b) => { saveBuildId(b.id); setId(b.id); },
      onError: (e) => { if (e instanceof ApiError && e.code === 'BUILD_IN_PROGRESS') { const other = (e.details as { id?: string } | undefined)?.id; if (other) { saveBuildId(other); setId(other); toast.push('A build is already running; showing it', 'info'); } } },
    });
  };
  return (
    <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <ErrorBanner error={start.error && !(start.error instanceof ApiError && start.error.code === 'BUILD_IN_PROGRESS') ? start.error : null} />
      <Field label="Describe your business and what you want visitors to do" error={errors.prompt} hint="Plain words are fine. Mention your offer, who it is for, any prices and what to avoid.">
        {(p) => <textarea className="input" rows={5} value={v.prompt} maxLength={50000} onChange={(e) => setV({ ...v, prompt: e.target.value })} {...p} />}
      </Field>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Field label="Goal">{(p) => <select className="input" value={v.goal} onChange={(e) => setV({ ...v, goal: e.target.value })} {...p}>{GOALS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</Field>
        <Field label="Voice">{(p) => <select className="input" value={v.tone} onChange={(e) => setV({ ...v, tone: e.target.value })} {...p}>{TONES.map((t) => <option key={t} value={t}>{t || 'Let the AI decide'}</option>)}</select>}</Field>
        <Field label="Pages" hint="Leave empty for the recommended number.">{(p) => <select className="input" value={v.steps} onChange={(e) => setV({ ...v, steps: e.target.value })} {...p}><option value="">Recommended</option>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select>}</Field>
      </div>

      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend className="small" style={{ fontWeight: 600 }}>Products</legend>
        <label className="check"><input type="radio" name="products" checked={v.products === 'none'} onChange={() => setV({ ...v, products: 'none' })} />Do not touch my catalog (offer pages collect enquiries instead of payments)</label>
        <label className="check"><input type="radio" name="products" disabled={!canCreate} checked={v.products === 'create'} onChange={() => setV({ ...v, products: 'create' })} />Create draft products in my catalog and wire the checkout{canCreate ? '' : ' (needs permission to edit products)'}</label>
        <label className="check"><input type="radio" name="products" disabled={!existing.length} checked={v.products === 'existing'} onChange={() => setV({ ...v, products: 'existing' })} />Sell products I already have{existing.length ? '' : ' (none yet)'}</label>
        {v.products === 'existing' ? (
          <div className="stack" role="group" aria-label="Choose products">
            {existing.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((c) => (e.target.checked ? [...c, p.id].slice(0, 5) : c.filter((x) => x !== p.id)))} />{p.name}</label>)}
          </div>
        ) : null}
        {v.products === 'create' ? <p className="small muted">Prices stay inside the range you give below. Nothing is synced to Stripe and the funnel starts in test status.</p> : null}
      </fieldset>

      <div><button type="button" className="btn ghost" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Fewer details' : 'More details (offer, audience, prices, words to avoid)'}</button></div>
      {more ? (
        <div className="stack">
          <TextField label="Your offer" value={v.offer} onChange={(offer) => setV({ ...v, offer })} hint="What exactly do visitors get?" />
          <TextField label="Who is it for?" value={v.audience} onChange={(audience) => setV({ ...v, audience })} />
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <TextField label="Lowest price" inputMode="decimal" value={v.priceMin} error={errors.priceMin} onChange={(priceMin) => setV({ ...v, priceMin })} />
            <TextField label="Highest price" inputMode="decimal" value={v.priceMax} error={errors.priceMax} onChange={(priceMax) => setV({ ...v, priceMax })} />
            <TextField label="Currency" value={v.currency} maxLength={3} onChange={(currency) => setV({ ...v, currency })} />
          </div>
          <TextField label="Words to avoid" value={v.avoid} onChange={(avoid) => setV({ ...v, avoid })} hint="Separated by commas" />
        </div>
      ) : null}

      <label className="check"><input type="checkbox" checked={v.redact} onChange={(e) => setV({ ...v, redact: e.target.checked })} />Remove emails, phone numbers and card numbers from my description before it is sent or stored</label>
      <p className="muted small">The AI writes copy and picks a structure; pages are assembled from fixed, validated building blocks and checked (links, forms, contrast, claims) before they are saved. You can edit everything afterwards.</p>
      <div><button className="btn primary" type="submit" disabled={start.isPending}>{start.isPending ? 'Starting…' : 'Build my funnel'}</button></div>
      <span className="sr-only" aria-live="polite">{start.error ? errorMessage(start.error) : ''}</span>
    </form>
  );
}
