import { useQuery } from '@tanstack/react-query';
import { Eye, Layers, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import { keys, useMutate, useTemplate, useTemplateCategories, useTemplates } from '../api/hooks';
import type { FunnelDetail, TemplateSummary } from '../api/types';
import { Badge, Button, Input } from '../ui';
import { GeneratedThumb } from './FunnelThumb';
import { HtmlFrame, hashGradient, ScaledPage, useNearViewport, type Device } from './PreviewFrame';
import { useToast } from './Toasts';
import { Empty, ErrorBanner, Loading, Modal } from './ui';

const useTemplateHtml = (id: string, step: number, enabled = true) =>
  useQuery({ queryKey: ['template-html', id, step], enabled, queryFn: () => api.get<{ html: string; name: string }>(`/api/templates/${id}/html`, { step }), staleTime: 5 * 60_000 });

function TemplateThumb({ t }: { t: TemplateSummary }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const q = useTemplateHtml(t.id, 1, near);
  return (
    <div ref={ref} className="overflow-hidden rounded-md border border-border">
      {q.data ? <ScaledPage html={q.data.html} title={`${t.name} preview`} /> : <GeneratedThumb thumb={{ heading: t.heading ?? t.name, ...hashGradient(t.slug) }} className="block aspect-[16/10] w-full" />}
    </div>
  );
}

function PreviewModal({ id, onClose, onUse, busy }: { id: string; onClose: () => void; onUse: () => void; busy: boolean }) {
  const t = useTemplate(id);
  const [step, setStep] = useState(1);
  const [device, setDevice] = useState<Device>('desktop');
  const html = useTemplateHtml(id, step);
  return (
    <Modal
      wide
      title={t.data ? `${t.data.name} preview` : 'Template preview'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={busy} onClick={onUse}>Use this template</Button></>}
    >
      <ErrorBanner error={t.error} />
      {t.isLoading ? <Loading rows={2} /> : null}
      {t.data ? (
        <div className="flex flex-col gap-3">
          <p className="muted">{t.data.description}</p>
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

/** Browsable template catalogue with category filter, search, real previews and "use template". */
export function TemplateGallery({ onCreated }: { onCreated?: (f: FunnelDetail) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const cats = useTemplateCategories();
  const q = useTemplates({ category: category || undefined, search: search || undefined });
  const use = useMutate((t: string) => api.post<FunnelDetail>(`/api/templates/${t}/use`), [keys.funnels]);
  const choose = (t: TemplateSummary | string) => {
    const id = typeof t === 'string' ? t : t.id;
    use.mutate(id, {
      onSuccess: (f) => {
        toast.push(`Created "${f.name}"`, 'ok');
        if (onCreated) onCreated(f);
        else nav(`/funnels/${f.id}`);
      },
      onError: (e) => toast.push(errorMessage(e), 'error'),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-xs">
          <label htmlFor="t-search" className="sr-only">Search templates</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="t-search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates" />
        </div>
        <div className="row" role="group" aria-label="Category">
          <Button size="sm" aria-pressed={category === ''} variant={category === '' ? 'soft' : 'default'} onClick={() => setCategory('')}>All</Button>
          {cats.data?.data.map((c) => <Button key={c.id} size="sm" aria-pressed={category === c.slug} variant={category === c.slug ? 'soft' : 'default'} onClick={() => setCategory(c.slug)}>{c.name} ({c.templateCount})</Button>)}
        </div>
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title="No templates found">Try another category or search term.</Empty> : null}
      <div className="grid cards">
        {q.data?.data.map((t) => (
          <article key={t.id} className="card flex flex-col gap-3 transition-shadow hover:shadow-pop" aria-label={t.name}>
            <TemplateThumb t={t} />
            <div className="row between"><h3>{t.name}</h3><Badge><Layers className="size-3" aria-hidden="true" />{t.stepCount} step{t.stepCount === 1 ? '' : 's'}</Badge></div>
            <p className="small muted !mb-0 grow">{t.description}</p>
            <div className="row">
              <Badge tone="primary">{t.categoryName ?? 'Uncategorised'}</Badge>
              <span className="right row">
                <Button size="sm" onClick={() => setPreview(t.id)}><Eye /> Preview</Button>
                <Button size="sm" variant="primary" disabled={use.isPending} onClick={() => choose(t)}>Use template</Button>
              </span>
            </div>
          </article>
        ))}
      </div>
      {preview ? <PreviewModal id={preview} busy={use.isPending} onClose={() => setPreview(null)} onUse={() => choose(preview)} /> : null}
    </div>
  );
}
