import { ADS_RUNTIME_JS } from './runtime.js';
import { type EffectivePixels } from './pixelConfig.js';
import { ID_FORMATS } from './ids.js';
import { createHash } from 'node:crypto';

export interface AdProduct {
  id: string;
  name: string;
  price: number;
  currency: string;
  bump: boolean;
  upsell: boolean;
}

export interface AdTagContext {
  funnelId: string;
  stepId: string;
  mode: 'live' | 'preview';
  products: AdProduct[];
}

export interface AdTags {
  /** The complete `<script>` element to put in the page head. */
  html: string;
  /** The script text (for a Content-Security-Policy hash). */
  source: string;
  /** SHA-256 CSP hash source of the script text, `'sha256-...'`. */
  cspHash: string;
}

/** JSON that is safe inside a `<script>` element: no `</script`, no `<!--`, no line separators that older engines treat as newlines. */
export function safeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const ok = (re: RegExp, v: string | null | undefined): string | null => (typeof v === 'string' && re.test(v) ? v : null);

/**
 * The page configuration handed to the runtime. Every identifier is re-checked against its strict format here, whatever the stored settings say; one that fails is left
 * out. Product names are free text but only ever travel as JSON strings (escaped by safeJson), never as markup.
 */
export function pageConfig(eff: EffectivePixels, ctx: AdTagContext): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const meta = ok(ID_FORMATS.metaPixel, eff.meta?.pixelId);
  if (meta) p.meta = { id: meta };
  const ga4 = ok(ID_FORMATS.ga4, eff.ga4?.measurementId);
  if (ga4) p.ga4 = { id: ga4 };
  const aw = ok(ID_FORMATS.googleAds, eff.googleAds?.conversionId);
  if (aw) p.ads = { id: aw, pl: ok(ID_FORMATS.googleAdsLabel, eff.googleAds?.purchaseLabel), ll: ok(ID_FORMATS.googleAdsLabel, eff.googleAds?.leadLabel) };
  const tt = ok(ID_FORMATS.tiktok, eff.tiktok?.pixelId);
  if (tt) p.tiktok = { id: tt };
  const li = ok(ID_FORMATS.linkedinPartner, eff.linkedin?.partnerId);
  if (li) p.li = { pid: li, pc: ok(ID_FORMATS.linkedinConversion, eff.linkedin?.purchaseConversionId), lc: ok(ID_FORMATS.linkedinConversion, eff.linkedin?.leadConversionId) };
  const uet = ok(ID_FORMATS.uet, eff.uet?.tagId);
  if (uet) p.uet = { id: uet };
  const c = eff.consent;
  return {
    p,
    lead: eff.events.lead,
    consent: { enabled: c.enabled, mode: c.mode, regions: c.regions, respectDnt: c.respectDnt, title: c.title, message: c.message, acceptLabel: c.acceptLabel, rejectLabel: c.rejectLabel, policyUrl: c.policyUrl, position: c.position },
    products: ctx.products.slice(0, 20).map((x) => ({ id: x.id.slice(0, 64), name: x.name.slice(0, 120), price: x.price, currency: x.currency, bump: x.bump, upsell: x.upsell })),
    funnel: ctx.funnelId,
    step: ctx.stepId,
    mode: ctx.mode,
  };
}

/** The inline tag script for a page, or null when the page has neither a pixel nor a consent banner. Deterministic for equal input. */
export function renderAdTags(eff: EffectivePixels, ctx: AdTagContext): AdTags | null {
  const cfg = pageConfig(eff, ctx);
  const anyPixel = Object.keys(cfg.p as object).length > 0;
  if (!anyPixel && !eff.consent.enabled) return null;
  const source = ADS_RUNTIME_JS.replace('__CFG__', () => safeJson(cfg));
  return { html: `<script>${source}</script>`, source, cspHash: `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'` };
}

/** Hosts the configured networks need, for a Content-Security-Policy (published pages on Cloudflare Pages). */
export function cspHosts(eff: EffectivePixels): { script: string[]; connect: string[]; img: string[]; frame: string[] } {
  const s = new Set<string>();
  const c = new Set<string>();
  const i = new Set<string>();
  const f = new Set<string>();
  if (eff.meta) {
    s.add('https://connect.facebook.net');
    c.add('https://www.facebook.com').add('https://connect.facebook.net');
    i.add('https://www.facebook.com');
  }
  if (eff.ga4 || eff.googleAds) {
    s.add('https://www.googletagmanager.com');
    c.add('https://www.google-analytics.com').add('https://*.google-analytics.com').add('https://*.analytics.google.com').add('https://*.googletagmanager.com').add('https://*.g.doubleclick.net').add('https://www.google.com');
    i.add('https://www.google-analytics.com').add('https://*.google-analytics.com').add('https://*.googletagmanager.com').add('https://*.g.doubleclick.net').add('https://www.google.com');
    f.add('https://www.googletagmanager.com');
  }
  if (eff.googleAds) {
    s.add('https://www.googleadservices.com');
    c.add('https://www.googleadservices.com').add('https://googleads.g.doubleclick.net');
    i.add('https://www.googleadservices.com').add('https://googleads.g.doubleclick.net');
  }
  if (eff.tiktok) {
    s.add('https://analytics.tiktok.com');
    c.add('https://analytics.tiktok.com').add('https://analytics-ipv6.tiktokw.us');
    i.add('https://analytics.tiktok.com');
  }
  if (eff.linkedin) {
    s.add('https://snap.licdn.com');
    c.add('https://px.ads.linkedin.com');
    i.add('https://px.ads.linkedin.com');
  }
  if (eff.uet) {
    s.add('https://bat.bing.com').add('https://bat.bing.net');
    c.add('https://bat.bing.com').add('https://bat.bing.net');
    i.add('https://bat.bing.com').add('https://bat.bing.net').add('https://bat.r.msn.com');
  }
  return { script: [...s].sort(), connect: [...c].sort(), img: [...i].sort(), frame: [...f].sort() };
}
