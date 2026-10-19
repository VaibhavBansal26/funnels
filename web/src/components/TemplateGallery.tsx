import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../api/client';
import { keys, useMutate, useTemplate, useTemplateCategories, useTemplates } from '../api/hooks';
import type { FunnelDetail, TemplateSummary } from '../api/types';
import { FunnelThumb } from './FunnelThumb';
import { hashGradient, PreviewFrame, type Device } from './PreviewFrame';
import { useToast } from './Toasts';
import { Empty, ErrorBanner, Loading, Modal } from './ui';

function PreviewModal({ id, onClose, onUse, busy }: { id: string; onClose: () => void; onUse: () => void; busy: boolean }) {
  const t = useTemplate(id);
  const [step, setStep] = useState(0);
  const [device, setDevice] = useState<Device>('desktop');
  const current = t.data?.steps[step];
  return (
    <Modal
      wide
      title={t.data ? `${t.data.name} preview` : 'Template preview'}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={busy} onClick={onUse}>Use this template</button></>}
    >
      <ErrorBanner error={t.error} />
      {t.isLoading ? <Loading rows={2} /> : null}
      {t.data ? (
        <div className="stack">
          <p className="muted">{t.data.description}</p>
          <div className="row between">
            <div className="tabs" role="tablist" aria-label="Template steps" style={{ margin: 0, border: 0 }}>
              {t.data.steps.map((s, i) => (
                <button key={s.id} type="button" role="tab" aria-selected={i === step} onClick={() => setStep(i)}>{i + 1}. {s.name}</button>
              ))}
            </div>
            <div className="row" role="group" aria-label="Preview size">
              {(['desktop', 'tablet', 'mobile'] as Device[]).map((d) => <button key={d} type="button" className="btn sm" aria-pressed={device === d} onClick={() => setDevice(d)}>{d}</button>)}
            </div>
          </div>
          {current ? <PreviewFrame doc={current.doc} title={`${t.data.name}: ${current.name}`} device={device} height={460} /> : null}
        </div>
      ) : null}
    </Modal>
  );
}

/** Browsable template catalogue with category filter, search, preview and "use template". */
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
    <div className="stack">
      <div className="filters">
        <div className="field"><label htmlFor="t-search">Search templates</label><input id="t-search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates" /></div>
        <div className="row" role="group" aria-label="Category">
          <button type="button" className="btn sm" aria-pressed={category === ''} onClick={() => setCategory('')}>All</button>
          {cats.data?.data.map((c) => <button key={c.id} type="button" className="btn sm" aria-pressed={category === c.slug} onClick={() => setCategory(c.slug)}>{c.name} ({c.templateCount})</button>)}
        </div>
      </div>
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <div className="card"><Empty title="No templates found">Try another category or search term.</Empty></div> : null}
      <div className="grid cards">
        {q.data?.data.map((t) => (
          <article key={t.id} className="card funnel-card" aria-label={t.name}>
            <FunnelThumb thumb={{ heading: t.heading ?? t.name, ...hashGradient(t.slug) }} />
            <div className="row between"><h3>{t.name}</h3><span className="badge">{t.stepCount} step{t.stepCount === 1 ? '' : 's'}</span></div>
            <p className="muted small">{t.description}</p>
            <div className="row"><span className="badge primary">{t.categoryName ?? 'Uncategorised'}</span>
              <span className="right row"><button type="button" className="btn sm" onClick={() => setPreview(t.id)}>Preview</button><button type="button" className="btn sm primary" disabled={use.isPending} onClick={() => choose(t)}>Use template</button></span></div>
          </article>
        ))}
      </div>
      {preview ? <PreviewModal id={preview} busy={use.isPending} onClose={() => setPreview(null)} onUse={() => choose(preview)} /> : null}
    </div>
  );
}
