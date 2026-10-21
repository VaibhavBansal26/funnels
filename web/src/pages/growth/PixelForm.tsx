import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api/client';
import { growthKeys, idProblem, pixelsPath, usePixels, type ConsentSettings, type PixelSettings } from '../../api/growth';
import { useMutate } from '../../api/hooks';
import { useToast } from '../../components/Toasts';
import { ErrorBanner, Field, Loading, TextField } from '../../components/ui';

/** What the form edits: flat strings, so empty means "not set". */
export interface PixelDraft {
  meta: string;
  ga4: string;
  gaAds: string;
  gaAdsPurchase: string;
  gaAdsLead: string;
  tiktok: string;
  liPartner: string;
  liPurchase: string;
  liLead: string;
  uet: string;
  lead: boolean;
  consent: ConsentSettings & { touched: boolean };
  /** Networks this level switches off although a higher level sets them (sent as null). */
  off: string[];
}

export const CONSENT_DEFAULTS: ConsentSettings = {
  enabled: false, mode: 'opt_in', regions: 'everyone', respectDnt: true, title: 'We value your privacy',
  message: 'We use cookies and similar technologies to measure and improve our pages and to measure advertising. You can accept or decline.',
  acceptLabel: 'Accept', rejectLabel: 'Decline', policyUrl: '', position: 'bottom',
};

export const draftOf = (c: PixelSettings | null): PixelDraft => ({
  meta: c?.meta?.pixelId ?? '', ga4: c?.ga4?.measurementId ?? '', gaAds: c?.googleAds?.conversionId ?? '', gaAdsPurchase: c?.googleAds?.purchaseLabel ?? '', gaAdsLead: c?.googleAds?.leadLabel ?? '',
  tiktok: c?.tiktok?.pixelId ?? '', liPartner: c?.linkedin?.partnerId ?? '', liPurchase: c?.linkedin?.purchaseConversionId ?? '', liLead: c?.linkedin?.leadConversionId ?? '', uet: c?.uet?.tagId ?? '',
  lead: c?.events?.lead ?? false, consent: { ...CONSENT_DEFAULTS, ...(c?.consent ?? {}), touched: !!c?.consent },
  off: (['meta', 'ga4', 'googleAds', 'tiktok', 'linkedin', 'uet'] as const).filter((k) => c && k in c && c[k] === null),
});

export function problems(d: PixelDraft): Partial<Record<keyof PixelDraft, string>> {
  const e: Partial<Record<keyof PixelDraft, string>> = {};
  const set = (k: keyof PixelDraft, p: string | undefined) => { if (p) e[k] = p; };
  set('meta', idProblem('metaPixel', d.meta));
  set('ga4', idProblem('ga4', d.ga4));
  set('gaAds', idProblem('googleAds', d.gaAds));
  set('gaAdsPurchase', idProblem('googleAdsLabel', d.gaAdsPurchase));
  set('gaAdsLead', idProblem('googleAdsLabel', d.gaAdsLead));
  set('tiktok', idProblem('tiktok', d.tiktok));
  set('liPartner', idProblem('linkedinPartner', d.liPartner));
  set('liPurchase', idProblem('linkedinConversion', d.liPurchase));
  set('liLead', idProblem('linkedinConversion', d.liLead));
  set('uet', idProblem('uet', d.uet));
  if ((d.gaAdsPurchase.trim() || d.gaAdsLead.trim()) && !d.gaAds.trim()) e.gaAds = 'Enter the Google Ads conversion ID the labels belong to';
  if (d.consent.policyUrl && !/^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*)$/i.test(d.consent.policyUrl)) e.consent = 'Use an http(s) address or a path starting with /';
  return e;
}

/** The PUT body. Empty fields are omitted (the level does not set them), `inherit` fields that were cleared on a funnel/step become `null` only when asked to switch off. */
export function bodyOf(d: PixelDraft): PixelSettings {
  const off = new Set(d.off);
  const v = (s: string) => s.trim();
  const out: PixelSettings = {};
  const net = <K extends keyof PixelSettings>(key: K, value: PixelSettings[K] | undefined, field: string) => {
    if (off.has(field)) (out as Record<string, unknown>)[key] = null;
    else if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  };
  net('meta', v(d.meta) ? { pixelId: v(d.meta) } : undefined, 'meta');
  net('ga4', v(d.ga4) ? { measurementId: v(d.ga4) } : undefined, 'ga4');
  net('googleAds', v(d.gaAds) ? { conversionId: v(d.gaAds), purchaseLabel: v(d.gaAdsPurchase) || null, leadLabel: v(d.gaAdsLead) || null } : undefined, 'googleAds');
  net('tiktok', v(d.tiktok) ? { pixelId: v(d.tiktok) } : undefined, 'tiktok');
  net('linkedin', v(d.liPartner) ? { partnerId: v(d.liPartner), purchaseConversionId: v(d.liPurchase) || null, leadConversionId: v(d.liLead) || null } : undefined, 'linkedin');
  net('uet', v(d.uet) ? { tagId: v(d.uet) } : undefined, 'uet');
  if (d.lead) out.events = { lead: true };
  if (d.consent.touched) {
    const { touched: _t, ...c } = d.consent;
    void _t;
    out.consent = c;
  }
  return out;
}

function ConsentFields({ d, set, disabled }: { d: PixelDraft; set: (c: Partial<ConsentSettings>) => void; disabled: boolean }) {
  const c = d.consent;
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }} disabled={disabled}>
      <legend className="label">Cookie consent</legend>
      <label className="check"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Ask visitors before loading advertising pixels</label>
      {c.enabled ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Field label="Mode" hint="Opt-in loads nothing until Accept. Opt-out loads at once and lets visitors decline.">
              {(p) => <select className="input" value={c.mode} onChange={(e) => set({ mode: e.target.value as ConsentSettings['mode'] })} {...p}><option value="opt_in">Opt-in (recommended for the EU and UK)</option><option value="opt_out">Opt-out</option></select>}
            </Field>
            <Field label="Who is asked" hint="Europe is detected from the browser time zone, a heuristic, not geolocation.">
              {(p) => <select className="input" value={c.regions} onChange={(e) => set({ regions: e.target.value as ConsentSettings['regions'] })} {...p}><option value="everyone">Everyone</option><option value="eu_uk">Visitors in Europe</option></select>}
            </Field>
            <Field label="Banner position">
              {(p) => <select className="input" value={c.position} onChange={(e) => set({ position: e.target.value as ConsentSettings['position'] })} {...p}><option value="bottom">Bottom</option><option value="bottom-left">Bottom left</option><option value="center">Centre</option></select>}
            </Field>
          </div>
          <TextField label="Title" value={c.title} maxLength={80} onChange={(title) => set({ title })} />
          <Field label="Message">{(p) => <textarea className="input" rows={3} maxLength={400} value={c.message} onChange={(e) => set({ message: e.target.value })} {...p} />}</Field>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <TextField label="Accept button" value={c.acceptLabel} maxLength={30} onChange={(acceptLabel) => set({ acceptLabel })} />
            <TextField label="Decline button" value={c.rejectLabel} maxLength={30} onChange={(rejectLabel) => set({ rejectLabel })} />
          </div>
          <TextField label="Privacy policy link" value={c.policyUrl} hint="Optional: an https:// address or a path such as /privacy" onChange={(policyUrl) => set({ policyUrl })} />
        </>
      ) : null}
      <label className="check"><input type="checkbox" checked={c.respectDnt} onChange={(e) => set({ respectDnt: e.target.checked })} />Respect Do Not Track and Global Privacy Control (load nothing and send no server-side conversions for those visitors)</label>
    </fieldset>
  );
}

export function PixelFields({ d, setD, errors, inherited, disabled }: { d: PixelDraft; setD: (d: PixelDraft) => void; errors: Partial<Record<keyof PixelDraft, string>>; inherited?: Partial<Record<keyof PixelDraft, string>>; disabled: boolean }) {
  const offToggle = (net: string, label: string) =>
    inherited && inherited[net === 'googleAds' ? 'gaAds' : net === 'linkedin' ? 'liPartner' : (net as keyof PixelDraft)] && !disabled ? (
      <label className="check small"><input type="checkbox" checked={d.off.includes(net)} onChange={(e) => setD({ ...d, off: e.target.checked ? [...d.off, net] : d.off.filter((x) => x !== net) })} />Do not use {label} here</label>
    ) : null;
  const f = (k: 'meta' | 'ga4' | 'gaAds' | 'gaAdsPurchase' | 'gaAdsLead' | 'tiktok' | 'liPartner' | 'liPurchase' | 'liLead' | 'uet', label: string, hint?: string, placeholder?: string) => (
    <TextField label={label} value={d[k]} error={errors[k]} hint={hint ?? (inherited?.[k] && !d[k] ? `Inherited: ${inherited[k]}` : undefined)} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} onChange={(v) => setD({ ...d, [k]: v })} />
  );
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <div>{f('meta', 'Meta Pixel ID', undefined, '123456789012345')}{offToggle('meta', 'the inherited Meta Pixel')}</div>
        <div>{f('ga4', 'Google Analytics 4 measurement ID', undefined, 'G-ABC123XYZ9')}{offToggle('ga4', 'the inherited GA4 tag')}</div>
        <div>{f('tiktok', 'TikTok Pixel code', undefined, 'CABCDEF1234567890ABC')}{offToggle('tiktok', 'the inherited TikTok Pixel')}</div>
        <div>{f('uet', 'Microsoft Advertising UET tag ID', undefined, '12345678')}{offToggle('uet', 'the inherited UET tag')}</div>
      </div>
      <details open={!!(d.gaAds || d.liPartner)}>
        <summary className="small">Google Ads conversions and LinkedIn Insight</summary>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 12 }}>
          {f('gaAds', 'Google Ads conversion ID', undefined, 'AW-123456789')}
          {f('gaAdsPurchase', 'Purchase conversion label')}
          {f('gaAdsLead', 'Lead conversion label')}
          {f('liPartner', 'LinkedIn partner ID')}
          {f('liPurchase', 'LinkedIn purchase conversion ID')}
          {f('liLead', 'LinkedIn lead conversion ID')}
        </div>
        <div className="row" style={{ marginTop: 8 }}>{offToggle('googleAds', 'the inherited Google Ads tag')}{offToggle('linkedin', 'the inherited LinkedIn tag')}</div>
      </details>
      <label className="check"><input type="checkbox" checked={d.lead} disabled={disabled} onChange={(e) => setD({ ...d, lead: e.target.checked })} />Send a <strong>Lead</strong> event when a visitor opts in (off by default: many funnels count opt-ins as another event)</label>
      <ConsentFields d={d} disabled={disabled} set={(c) => setD({ ...d, consent: { ...d.consent, ...c, touched: true } })} />
      {errors.consent ? <div className="alert error" role="alert">{errors.consent}</div> : null}
      <p className="muted small">Pixels are generated by the server from these IDs; nothing you type here is run as script. Server-side conversions (Meta, Google, TikTok) are set up under Ads &gt; Integrations.</p>
    </div>
  );
}

/** Edits the pixel settings of one level: the workspace, a funnel or a step. */
export function PixelEditor({ funnelId, stepId, canEdit, heading }: { funnelId?: string | null; stepId?: string | null; canEdit: boolean; heading?: string }) {
  const q = usePixels(funnelId, stepId);
  const toast = useToast();
  const orig = useMemo(() => draftOf(q.data?.config ?? null), [q.data]);
  const [d, setD] = useState<PixelDraft>(orig);
  useEffect(() => setD(orig), [orig]);
  const errors = problems(d);
  const dirty = JSON.stringify(bodyOf(d)) !== JSON.stringify(bodyOf(orig));
  const save = useMutate((body: PixelSettings) => api.put(pixelsPath(funnelId, stepId), body), [growthKeys.pixels(`${funnelId ?? 'ws'}:${stepId ?? ''}`) as unknown as string[]]);
  const eff = q.data?.effective;
  const inherited = funnelId && eff ? ({ meta: eff.meta?.pixelId, ga4: eff.ga4?.measurementId, tiktok: eff.tiktok?.pixelId, uet: eff.uet?.tagId, gaAds: eff.googleAds?.conversionId, liPartner: eff.linkedin?.partnerId } as Partial<Record<keyof PixelDraft, string>>) : undefined;
  if (q.isLoading) return <Loading rows={2} />;
  return (
    <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); if (!Object.keys(errors).length) save.mutate(bodyOf(d), { onSuccess: () => toast.push('Tracking saved. Pages are being updated.', 'ok'), onError: (er) => toast.push(er instanceof ApiError ? errorMessage(er) : 'Could not save', 'error') }); }}>
      {heading ? <h3 style={{ margin: 0 }}>{heading}</h3> : null}
      <ErrorBanner error={q.error ?? save.error} onRetry={q.error ? () => void q.refetch() : undefined} />
      <PixelFields d={d} setD={setD} errors={errors} inherited={inherited} disabled={!canEdit} />
      {canEdit ? (
        <div className="row">
          <button className="btn primary" type="submit" disabled={!dirty || save.isPending || Object.keys(errors).length > 0}>{save.isPending ? 'Saving…' : 'Save tracking'}</button>
          <span className="muted small">Saving re-renders the affected pages and refreshes live copies.</span>
        </div>
      ) : <p className="muted small">You can see these settings; changing them needs the integrations:manage permission.</p>}
    </form>
  );
}
