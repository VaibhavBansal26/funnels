import { useEffect, useState } from 'react';
import type { PageDocument } from '@blocks';
import { api, ApiError } from '../api/client';
import { keys, useMutate } from '../api/hooks';
import type { Step } from '../api/types';
import { ErrorBanner, Field, Modal, TextField } from '../components/ui';

export interface PageSettingsValue {
  name: string;
  path: string;
  title: string;
  seo: string;
  css: string;
  header: string;
  footer: string;
  accent: string;
  background: string;
  font: PageDocument['settings']['font'];
}

export function validatePageSettings(v: PageSettingsValue): Partial<Record<'name' | 'path' | 'title' | 'seo' | 'accent' | 'background', string>> {
  const e: Partial<Record<'name' | 'path' | 'title' | 'seo' | 'accent' | 'background', string>> = {};
  const color = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24})$/;
  if (!v.name.trim()) e.name = 'Give the step a name';
  if (!/^\/([a-zA-Z0-9-]|%[0-9A-Fa-f]{2})*([^/.]\/?)?$/.test(v.path) || /[\s?#\\]/.test(v.path)) e.path = 'Use a path like /thank-you: letters, digits and "-" only';
  if (v.title.length > 200) e.title = 'Keep the title under 200 characters';
  if (v.seo.length > 400) e.seo = 'Keep the description under 400 characters';
  if (v.accent && !color.test(v.accent)) e.accent = 'Use a hex color such as #2563eb';
  if (v.background && !color.test(v.background)) e.background = 'Use a hex color such as #ffffff';
  return e;
}

/** Step settings (name, path, SEO, custom CSS, tracking code) and document-wide look (accent, background, font). */
export function PageSettingsDialog({ funnelId, domainId, step, settings, isAdmin, onClose, onApplyDoc }: { funnelId: string; domainId?: string; step: Step; settings: PageDocument['settings']; isAdmin: boolean; onClose: () => void; onApplyDoc: (patch: Partial<PageDocument['settings']>) => void }) {
  const [v, setV] = useState<PageSettingsValue>({ name: step.name, path: step.path, title: step.title ?? '', seo: step.seoDescription ?? '', css: step.customCss ?? '', header: step.headerTrackingCode ?? '', footer: step.footerTrackingCode ?? '', accent: settings.accent ?? '', background: settings.background ?? '', font: settings.font });
  const [pathError, setPathError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const errors = validatePageSettings(v);
  const save = useMutate((body: object) => api.patch(`/api/funnels/${funnelId}/steps/${step.id}`, body), [keys.funnel(funnelId), keys.funnels]);

  useEffect(() => {
    if (v.path === step.path) { setPathError(null); setSuggestions([]); return; }
    const t = setTimeout(() => {
      api.post<{ success: boolean; reason?: string; uniquePaths: string[] }>('/api/funnels/validate-path', { path: v.path, funnelId, stepId: step.id, domainId })
        .then((r) => { setPathError(r.success ? null : 'This path is already used'); setSuggestions(r.success ? [] : r.uniquePaths); })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [v.path, step.path, step.id, funnelId, domainId]);

  const submit = () => {
    if (Object.keys(errors).length || pathError) return;
    const body: Record<string, unknown> = { name: v.name.trim(), base_path: v.path, title: v.title || null, seo_description: v.seo || null, custom_css: v.css || null };
    if (isAdmin) Object.assign(body, { header_tracking_code: v.header || null, footer_tracking_code: v.footer || null });
    save.mutate(body, {
      onSuccess: () => {
        onApplyDoc({ accent: v.accent || undefined, background: v.background || undefined, font: v.font });
        onClose();
      },
    });
  };
  const pathMsg = errors.path ?? pathError ?? undefined;
  const serverField = save.error instanceof ApiError ? save.error.fieldErrors : {};
  return (
    <Modal wide title="Page settings" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={save.isPending || Object.keys(errors).length > 0 || !!pathError} onClick={submit}>Apply</button></>}>
      <ErrorBanner error={save.error} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div>
          <h3>Details</h3>
          <TextField label="Step name" value={v.name} error={errors.name ?? serverField.name} onChange={(name) => setV({ ...v, name })} />
          <TextField label="Path" value={v.path} error={pathMsg} onChange={(path) => setV({ ...v, path })} />
          {suggestions.length ? <p className="small">Try: {suggestions.map((s) => <button key={s} type="button" className="btn sm" style={{ marginRight: 4 }} onClick={() => setV({ ...v, path: s })}>{s}</button>)}</p> : null}
          <h3>Look</h3>
          <TextField label="Accent color" value={v.accent} error={errors.accent} onChange={(accent) => setV({ ...v, accent })} />
          <TextField label="Page background" value={v.background} error={errors.background} onChange={(background) => setV({ ...v, background })} />
          <Field label="Font">{(p) => <select className="input" value={v.font} onChange={(e) => setV({ ...v, font: e.target.value as PageSettingsValue['font'] })} {...p}><option value="system">System sans-serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>}</Field>
        </div>
        <div>
          <h3>SEO</h3>
          <TextField label="Page title" value={v.title} error={errors.title} hint="Shown in the browser tab and search results" onChange={(title) => setV({ ...v, title })} />
          <Field label="Meta description" error={errors.seo}>{(p) => <textarea className="input" rows={3} value={v.seo} onChange={(e) => setV({ ...v, seo: e.target.value })} {...p} />}</Field>
          <h3>Custom CSS</h3>
          <Field label="CSS for this page">{(p) => <textarea className="input mono" rows={4} value={v.css} onChange={(e) => setV({ ...v, css: e.target.value })} {...p} />}</Field>
        </div>
      </div>
      {isAdmin ? (
        <>
          <h3>Tracking code</h3>
          <p className="muted small">Published only when the workspace allows custom scripts (Settings).</p>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <Field label="Header code">{(p) => <textarea className="input mono" rows={3} value={v.header} onChange={(e) => setV({ ...v, header: e.target.value })} {...p} />}</Field>
            <Field label="Footer code">{(p) => <textarea className="input mono" rows={3} value={v.footer} onChange={(e) => setV({ ...v, footer: e.target.value })} {...p} />}</Field>
          </div>
        </>
      ) : <p className="muted small">Admins can edit tracking code.</p>}
    </Modal>
  );
}
