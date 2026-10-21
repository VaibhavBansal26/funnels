import { useQuery } from '@tanstack/react-query';
import { Eye, Layers, Search, ShoppingCart } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client';
import { useTemplate, useTemplateCategories, useTemplates } from '../api/hooks';
import type { FunnelDetail, TemplateSummary } from '../api/types';
import { Badge, Button, Input, Select } from '../ui';
import { GeneratedThumb } from './FunnelThumb';
import { HtmlFrame, hashGradient, ScaledPage, useNearViewport, type Device } from './PreviewFrame';
import { useToast } from './Toasts';
import { Empty, ErrorBanner, Loading, Modal, Pager } from './ui';
import { UseTemplateWizard, roleLabel } from './UseTemplateWizard';

const useTemplateHtml = (id: string, step: number, enabled = true) =>
  useQuery({ queryKey: ['template-html', id, step], enabled, queryFn: () => api.get<{ html: string; name: string }>(`/api/templates/${id}/html`, { step }), staleTime: 5 * 60_000 });

export const label = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const GOAL_LABEL: Record<string, string> = { leads: 'Collect leads', webinar: 'Webinar', sales: 'Sell', booking: 'Book calls', events: 'Events', donations: 'Donations', engagement: 'Engagement' };

function TemplateThumb({ t }: { t: TemplateSummary }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const q = useTemplateHtml(t.id, 1, near);
  return (
    <div ref={ref} className="overflow-hidden rounded-md border border-border" style={{ borderTop: `3px solid ${t.accent}` }}>
      {q.data ? <ScaledPage html={q.data.html} title={`${t.name} preview`} /> : <GeneratedThumb thumb={{ heading: t.heading ?? t.name, ...hashGradient(t.slug) }} className="block aspect-[16/10] w-full" />}
    </div>
  );
}

function PreviewModal({ id, onClose, onUse }: { id: string; onClose: () => void; onUse: () => void }) {
  const t = useTemplate(id);
  const [step, setStep] = useState(1);
  const [device, setDevice] = useState<Device>('desktop');
  const html = useTemplateHtml(id, step);
  return (
    <Modal
      wide
      title={t.data ? `${t.data.name} preview` : 'Template preview'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={onUse}>Use this template</Button></>}
    >
      <ErrorBanner error={t.error} />
      {t.isLoading ? <Loading rows={2} /> : null}
      {t.data ? (
        <div className="flex flex-col gap-3">
          <p className="muted m-0">{t.data.description}</p>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="primary">{t.data.categoryName}</Badge><Badge>{label(t.data.industry)}</Badge><Badge>{GOAL_LABEL[t.data.goal] ?? t.data.goal}</Badge>
            {t.data.tags.slice(0, 4).map((x) => <Badge key={x}>{x}</Badge>)}
          </div>
          {t.data.products.length ? (
            <p className="small m-0"><ShoppingCart className="mr-1 inline size-3.5" aria-hidden="true" /> Sells: {t.data.products.map((p) => `${p.name} (${roleLabel(p.role).toLowerCase()})`).join(', ')}. You choose the products when you use it.</p>
          ) : null}
          <div className="row between">
            <div className="tabs !mb-0 !border-0" role="tablist" aria-label="Template steps">
              {t.data.steps.map((s, i) => (
                <button key={s.id} type="button" role="tab" aria-selected={i + 1 === step} onClick={() => setStep(i + 1)}>{i + 1}. {s.name}</button>
              ))}
            </div>
            <div className="row" role="group" aria-label="Preview size">
              {(['desktop', 'tablet', 'mobile'] as Device[]).map((d) => <Button key={d} size="sm" aria-pressed={device === d} variant={device === d ? 'soft' : 'default'} onClick={() => setDevice(d)}>{d}</Button>)}
            </div>
          </div>
          {html.data ? <HtmlFrame html={html.data.html} title={`${t.data.name}: ${html.data.name}`} device={device} height={460} /> : <Loading rows={4} />}
        </div>
      ) : null}
    </Modal>
  );
}

const PAGE_SIZE = 12;

/** The template library from the backend: category, industry, goal and checkout filters, search, real page thumbnails, a sandboxed device preview and a "use this template" wizard. */
export function TemplateGallery({ onCreated }: { onCreated?: (f: FunnelDetail) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [industry, setIndustry] = useState('');
  const [goal, setGoal] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<string | null>(null);
  const [using, setUsing] = useState<TemplateSummary | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [category, industry, goal, checkout, debounced]);
  const cats = useTemplateCategories();
  const q = useTemplates({ category: category || undefined, industry: industry || undefined, goal: goal || undefined, checkout: checkout ? 'true' : undefined, search: debounced || undefined, page, limit: PAGE_SIZE });
  const facets = q.data?.facets;
  const filtered = !!(category || industry || goal || checkout || debounced);
  const created = (f: FunnelDetail) => {
    toast.push(`Created "${f.name}"`, 'ok');
    if (onCreated) onCreated(f);
    else nav(`/funnels/${f.id}`);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-xs">
          <label htmlFor="t-search" className="sr-only">Search templates</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="t-search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates, e.g. webinar or dentist" />
        </div>
        <div className="w-44"><Select aria-label="Industry" value={industry} onValueChange={setIndustry} options={[{ value: '', label: 'Any industry' }, ...(facets?.industries ?? []).map((f) => ({ value: f.value, label: `${label(f.value)} (${f.count})` }))]} /></div>
        <div className="w-44"><Select aria-label="Goal" value={goal} onValueChange={setGoal} options={[{ value: '', label: 'Any goal' }, ...(facets?.goals ?? []).map((f) => ({ value: f.value, label: `${GOAL_LABEL[f.value] ?? f.value} (${f.count})` }))]} /></div>
        <Button size="sm" aria-pressed={checkout} variant={checkout ? 'soft' : 'default'} onClick={() => setCheckout(!checkout)}><ShoppingCart /> Has checkout</Button>
        {filtered ? <Button size="sm" variant="ghost" onClick={() => { setCategory(''); setIndustry(''); setGoal(''); setCheckout(false); setSearch(''); }}>Clear filters</Button> : null}
      </div>
      <div className="row" role="group" aria-label="Category">
        <Button size="sm" aria-pressed={category === ''} variant={category === '' ? 'soft' : 'default'} onClick={() => setCategory('')}>All</Button>
        {cats.data?.data.filter((c) => c.templateCount > 0).map((c) => <Button key={c.id} size="sm" aria-pressed={category === c.slug} variant={category === c.slug ? 'soft' : 'default'} onClick={() => setCategory(c.slug)}>{c.name} ({c.templateCount})</Button>)}
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data ? <p className="small muted m-0" role="status">{q.data.pagination.total} template{q.data.pagination.total === 1 ? '' : 's'}</p> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="No templates found">Try another category, industry or search term.</Empty> : null}
      <div className="grid cards">
        {q.data?.data.map((t) => (
          <article key={t.id} className="card flex flex-col gap-3 transition-shadow hover:shadow-pop" aria-label={t.name}>
            <TemplateThumb t={t} />
            <div className="row between"><h3>{t.name}</h3><Badge><Layers className="size-3" aria-hidden="true" />{t.stepCount} step{t.stepCount === 1 ? '' : 's'}</Badge></div>
            <p className="small muted !mb-0 line-clamp-3 grow">{t.description}</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="primary">{t.categoryName ?? 'Uncategorised'}</Badge>
              <Badge>{label(t.industry)}</Badge>
              {t.hasCheckout ? <Badge tone="info"><ShoppingCart className="size-3" aria-hidden="true" />Checkout</Badge> : null}
            </div>
            <div className="row">
              <span className="right row">
                <Button size="sm" onClick={() => setPreview(t.id)} aria-label={`Preview ${t.name}`}><Eye /> Preview</Button>
                <Button size="sm" variant="primary" onClick={() => setUsing(t)} aria-label={`Use template ${t.name}`}>Use template</Button>
              </span>
            </div>
          </article>
        ))}
      </div>
      {q.data ? <Pager p={q.data.pagination} onPage={setPage} /> : null}
      {preview ? <PreviewModal id={preview} onClose={() => setPreview(null)} onUse={() => { setUsing(q.data?.data.find((x) => x.id === preview) ?? null); setPreview(null); }} /> : null}
      {using ? <UseTemplateWizard template={using} onClose={() => setUsing(null)} onCreated={created} /> : null}
    </div>
  );
}
