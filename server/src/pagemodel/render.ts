import { randomBytes } from 'node:crypto';
import { esc, safeUrl } from '../blocks/safe.js';
import { sanitizeCss } from './cssfilter.js';
import { sanitizePageBody, sanitizeUserHtml } from './htmlfilter.js';
import { BASE_CSS, FN_PAGE_CLASS } from './shared/css.js';
import { PROJECT_LIMITS, childrenOf, cleanProject, emptyProject, isFnType, wrapperOf, type GjsNode, type GjsProject, type GjsRule } from './shared/clean.js';
import { checkoutInner, countdownInner, formInner, progressInner, videoInner, type MarkupCtx } from './shared/markup.js';
import type { ButtonActionProps, CodeProps, CountdownProps, FormProps, ProductProps, ProgressProps, VideoProps } from './shared/props.js';

/**
 * Deterministic page renderer: GrapesJS project data in, a complete HTML document out. Pure with respect to its inputs (nothing is
 * read from the clock, environment or network), and the ONLY producer of published markup: the browser never sends HTML.
 *
 * Safety layers, in order: (1) `cleanProject` rebuilds the project from an allow-list, (2) every value interpolated here is escaped,
 * (3) free-form fragments (custom code) go through `sanitizeUserHtml` / `sanitizeCss` unless the page owner may run scripts, and
 * (4) the whole body passes `sanitizePageBody` once more before the page is assembled.
 */
export interface PageRenderContext {
  funnelId: string;
  stepId: string;
  stepName: string;
  title?: string | null;
  description?: string | null;
  customCss?: string | null;
  favicon?: string | null;
  headerCode?: string | null;
  footerCode?: string | null;
  /** Owner-only: custom code blocks keep scripts and event handlers (`allowCustomScripts` workspace flag AND a permitted last saver). */
  allowScripts?: boolean;
  /** Inject header/footer tracking snippets verbatim. */
  allowTrackingCode?: boolean;
  /** Ordered steps of the funnel with the href each one should be linked at. */
  steps?: { id: string; href: string }[];
  mode?: 'live' | 'preview';
  apiBase?: string;
  beaconSrc?: string;
}

const RUNTIME_JS = `(function(){function p(n){return n<10?'0'+n:''+n}function set(el,u,v){var s=el.querySelector('[data-u="'+u+'"]');if(s)s.textContent=p(v)}
document.querySelectorAll('[data-fn-countdown]').forEach(function(el){var end;if(el.getAttribute('data-mode')==='fixed'){end=Date.parse(el.getAttribute('data-end'))}else{var k='fn-cd-'+el.getAttribute('data-key'),s=0;try{s=+localStorage.getItem(k)}catch(e){}if(!s){s=Date.now();try{localStorage.setItem(k,String(s))}catch(e){}}end=s+(+el.getAttribute('data-minutes'))*60000}
function tick(){var left=Math.max(0,end-Date.now()),t=Math.floor(left/1000);set(el,'d',Math.floor(t/86400));set(el,'h',Math.floor(t%86400/3600));set(el,'m',Math.floor(t%3600/60));set(el,'s',t%60);if(left<=0){var m=el.parentNode.querySelector('.fn-cd-msg');if(m)m.hidden=false;clearInterval(i)}}
var i=setInterval(tick,1000);tick()});
document.querySelectorAll('.fn-tabs').forEach(function(tabs){var b=tabs.querySelectorAll('.fn-tab-btn'),pn=tabs.querySelectorAll('.fn-tab-panel');
b.forEach(function(btn,i){btn.setAttribute('role','tab');btn.setAttribute('aria-selected',i===0?'true':'false');btn.addEventListener('click',function(){b.forEach(function(x,j){x.setAttribute('aria-selected',j===i?'true':'false');x.classList.toggle('fn-active',j===i)});pn.forEach(function(x,j){if(j===i)x.removeAttribute('hidden');else x.setAttribute('hidden','')})})})});
function closeAll(){document.querySelectorAll('.fn-popup.fn-open').forEach(function(x){x.classList.remove('fn-open')})}
document.addEventListener('click',function(e){var t=e.target,o=t.closest&&t.closest('[data-fn-popup]');if(o){e.preventDefault();var pp=document.getElementById(o.getAttribute('data-fn-popup'));if(pp)pp.classList.add('fn-open');return}
if(t.closest&&t.closest('.fn-popup-close')){closeAll();return}if(t.classList&&t.classList.contains('fn-popup'))closeAll()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeAll()});
})();`;

const VOID = new Set(['br', 'hr', 'img']);

interface State {
  ctx: PageRenderContext;
  markup: MarkupCtx;
  count: number;
  hrefs: Map<string, string>;
  hasRuntime: boolean;
  raw: Map<string, string>;
  extraCss: string[];
  rawSeq: number;
  nonce: string;
}

const attrString = (attrs: Record<string, string>): string =>
  Object.keys(attrs)
    .sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map((k) => (attrs[k] === '' && (k === 'hidden' || k === 'open') ? ` ${k}` : ` ${k}="${esc(attrs[k])}"`))
    .join('');

function nodeAttrs(n: GjsNode, extra: Record<string, string> = {}): string {
  const attrs: Record<string, string> = { ...((n.attributes as Record<string, string> | undefined) ?? {}), ...extra };
  const classes = [...((n.classes as string[] | undefined) ?? []), ...(extra.class ? [extra.class] : [])];
  delete attrs.class;
  if (classes.length) attrs.class = [...new Set(classes)].join(' ');
  return attrString(attrs);
}

function actionAttrs(st: State, action: ButtonActionProps | undefined): Record<string, string> {
  const a = action ?? { type: 'none' };
  switch (a.type) {
    case 'next_step':
      return { href: st.markup.nextHref, 'data-fn-action': 'next_step' };
    case 'step':
      return { href: st.hrefs.get(a.stepId) ?? '#', 'data-fn-action': 'step' };
    case 'link':
      return { href: safeUrl(a.url) ?? '#', ...(a.newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}), 'data-fn-action': 'link' };
    case 'anchor':
      return { href: `#${a.anchor}`, 'data-fn-action': 'anchor' };
    case 'popup':
      st.hasRuntime = true;
      return { href: '#', 'data-fn-popup': a.popupId, 'data-fn-action': 'popup' };
    default:
      return { href: '#', 'data-fn-action': 'none' };
  }
}

function renderNode(n: GjsNode, st: State, depth: number): string {
  if (st.count++ >= PROJECT_LIMITS.maxNodes || depth > PROJECT_LIMITS.maxDepth) return '';
  const type = typeof n.type === 'string' ? n.type : 'default';
  if (type === 'textnode') return esc(typeof n.content === 'string' ? n.content : '');
  const tag = typeof n.tagName === 'string' ? n.tagName : 'div';
  const id = ((n.attributes as Record<string, string> | undefined) ?? {}).id ?? '';
  const mk = st.markup;

  switch (type) {
    case 'fn-form':
      return `<div${nodeAttrs(n)}>${formInner(id, n.fnForm as FormProps, mk)}</div>`;
    case 'fn-checkout':
      return `<div${nodeAttrs(n)}>${checkoutInner(id, n.fnProduct as ProductProps, mk)}</div>`;
    case 'fn-video':
      return `<div${nodeAttrs(n)}>${videoInner(n.fnVideo as VideoProps, mk)}</div>`;
    case 'fn-countdown':
      st.hasRuntime = true;
      return `<div${nodeAttrs(n)}>${countdownInner(id, n.fnCountdown as CountdownProps, mk)}</div>`;
    case 'fn-progress':
      return `<div${nodeAttrs(n)}>${progressInner(n.fnProgress as ProgressProps)}</div>`;
    case 'fn-code': {
      const code = n.fnCode as CodeProps;
      if (st.ctx.allowScripts) {
        const token = `FNRAW${st.nonce}${st.rawSeq++}END`;
        st.raw.set(token, `${code.css ? `<style>${code.css.replace(/<\/style/gi, '<\\/style')}</style>` : ''}${code.html}${code.js ? `<script>${code.js.replace(/<\/script/gi, '<\\/script')}</script>` : ''}`);
        return `<div${nodeAttrs(n)}>${token}</div>`;
      }
      const css = sanitizeCss(code.css);
      if (css) st.extraCss.push(css);
      return `<div${nodeAttrs(n)}>${sanitizeUserHtml(code.html)}</div>`;
    }
    default:
      break;
  }

  const extra: Record<string, string> = type === 'fn-button' ? actionAttrs(st, n.fnAction as ButtonActionProps | undefined) : {};
  if (type === 'fn-button' && tag === 'button') {
    delete extra.href;
    extra.type = 'button';
  }
  if (type === 'fn-popup') st.hasRuntime = true;
  if (type === 'fn-tabs') st.hasRuntime = true;
  if (type === 'fn-faq' || tag === 'details') {
    // `open` is an editor convenience, never part of the published state.
    const a = { ...((n.attributes as Record<string, string> | undefined) ?? {}) };
    delete a.open;
    n = { ...n, attributes: a };
  }
  if (tag === 'a' && !extra.href && !(n.attributes as Record<string, string> | undefined)?.href) extra.href = '#';
  if (tag === 'img') {
    if (!(n.attributes as Record<string, string> | undefined)?.src) return '';
    extra.loading = 'lazy';
  }
  const open = `<${tag}${nodeAttrs(n, extra)}>`;
  if (VOID.has(tag)) return open;
  const kids = childrenOf(n).map((c) => renderNode(c, st, depth + 1)).join('');
  return `${open}${kids}</${tag}>`;
}

// ---------- CSS ----------

const cssId = (id: string) => `#${id}`;

function selectorOf(rule: GjsRule, wrapperId: string | null): string {
  const sels = (rule.selectors ?? []).map((s) => {
    if (typeof s === 'string') return s.startsWith('#') ? s : `.${s}`;
    return s.type === 2 ? cssId(s.name) : `.${s.name}`;
  });
  const compound = sels.join('');
  const state = rule.state ? `:${rule.state}` : '';
  const main = compound ? (wrapperId && compound === `#${wrapperId}` ? 'body' : compound) + state : '';
  if (rule.selectorsAdd) return main ? `${main},${rule.selectorsAdd}` : rule.selectorsAdd;
  return main;
}

const declText = (style: Record<string, string>): string => Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');

function mediaWeight(m: string): [number, number] {
  const max = /max-width\s*:\s*(\d+(?:\.\d+)?)/i.exec(m);
  if (max) return [0, -Number(max[1])]; // desktop-first: wider max-width queries come first
  const min = /min-width\s*:\s*(\d+(?:\.\d+)?)/i.exec(m);
  if (min) return [1, Number(min[1])];
  return [2, 0];
}

/** Style rules in GrapesJS output order: plain rules first, then media queries ordered desktop-first. */
export function rulesToCss(project: GjsProject): string {
  const wrapper = wrapperOf(project);
  const wid = ((wrapper.attributes as Record<string, string> | undefined) ?? {}).id ?? null;
  const plain: string[] = [];
  const media = new Map<string, string[]>();
  const nodeRules: GjsRule[] = [];
  const collect = (n: GjsNode) => {
    const attrs = (n.attributes as Record<string, string> | undefined) ?? {};
    if (n.style && attrs.id && typeof n.style === 'object') nodeRules.push({ selectors: [`#${attrs.id}`], style: n.style as Record<string, string> });
    for (const c of childrenOf(n)) collect(c);
  };
  collect(wrapper);
  if (wid && wrapper.style) nodeRules.push({ selectors: [`#${wid}`], style: wrapper.style as Record<string, string> });
  for (const r of [...nodeRules, ...project.styles]) {
    const sel = selectorOf(r, wid);
    const decls = declText(r.style);
    if (!sel || !decls) continue;
    const text = `${sel}{${decls}}`;
    if (r.mediaText) {
      const list = media.get(r.mediaText) ?? [];
      list.push(text);
      media.set(r.mediaText, list);
    } else plain.push(text);
  }
  const ordered = [...media.entries()].sort((a, b) => {
    const [ga, va] = mediaWeight(a[0]);
    const [gb, vb] = mediaWeight(b[0]);
    return ga - gb || va - vb;
  });
  return plain.join('') + ordered.map(([m, rules]) => `@media ${m}{${rules.join('')}}`).join('');
}

// ---------- page ----------

const FAVICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%232563eb%22/%3E%3Cpath d=%22M8 9h16l-6 7v7l-4-2v-5z%22 fill=%22%23fff%22/%3E%3C/svg%3E';

export interface RenderedPage {
  html: string;
  /** The stylesheet as emitted (base + project rules), for diagnostics and tests. */
  css: string;
  /** The sanitised body markup. */
  body: string;
}

export function renderProject(rawProject: unknown, ctx: PageRenderContext): RenderedPage {
  const cleaned = cleanProject(rawProject);
  const project = cleaned.ok ? cleaned.project : emptyProject();
  const steps = ctx.steps ?? [];
  const idx = steps.findIndex((s) => s.id === ctx.stepId);
  const mode = ctx.mode ?? 'live';
  const products = cleaned.ok ? cleaned.products : [];
  const main = products.find((p) => !p.orderBump && !p.oneClickUpsell);
  const st: State = {
    ctx,
    markup: { mode, funnelId: ctx.funnelId, stepId: ctx.stepId, apiBase: ctx.apiBase, nextHref: idx >= 0 && steps[idx + 1] ? steps[idx + 1]!.href : '#', mainCheckoutId: main?.id ?? null },
    count: 0,
    hrefs: new Map(steps.map((s) => [s.id, s.href])),
    hasRuntime: false,
    raw: new Map(),
    extraCss: [],
    rawSeq: 0,
    nonce: randomBytes(6).toString('hex'),
  };
  const wrapper = wrapperOf(project);
  let body = childrenOf(wrapper).map((c) => renderNode(c, st, 1)).join('');
  if (!body) body = '<section class="fn-section fn-pad-md fn-w-small fn-align-center"><p class="fn-muted">This page is empty.</p></section>';
  body = sanitizePageBody(body, { apiBase: ctx.apiBase });
  for (const [token, raw] of st.raw) body = body.replace(token, () => raw);

  const projectCss = rulesToCss(project);
  const userCss = ctx.customCss ? (ctx.allowScripts ? String(ctx.customCss).slice(0, 20_000).replace(/<\/?style/gi, '') : sanitizeCss(ctx.customCss)) : '';
  const css = `${BASE_CSS}${projectCss}${st.extraCss.join('')}${userCss}`;

  const bodyClasses = [FN_PAGE_CLASS, ...(((wrapper.classes as string[] | undefined) ?? []).filter((c) => !c.startsWith('fn-page')))];
  const title = (ctx.title ?? '').toString().slice(0, 200).trim() || ctx.stepName.slice(0, 200) || 'Untitled';
  const description = (ctx.description ?? '').toString().slice(0, 400).trim();
  const favicon = safeUrl(ctx.favicon, ['http', 'https']) ?? FAVICON;
  const header = ctx.allowTrackingCode ? String(ctx.headerCode ?? '').slice(0, 20_000) : '';
  const footer = ctx.allowTrackingCode ? String(ctx.footerCode ?? '').slice(0, 20_000) : '';
  const preview = mode === 'preview';
  const beacon = `<script async src="${esc(ctx.beaconSrc ?? `${ctx.apiBase ?? ''}/beacon.js`)}" data-funnel="${esc(ctx.funnelId)}" data-step="${esc(ctx.stepId)}" data-api="${esc(ctx.apiBase ?? '')}"${preview ? ' data-preview="1"' : ''}></script>`;
  const runtime = st.hasRuntime ? `<script>${RUNTIME_JS}</script>` : '';
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    (description ? `<meta name="description" content="${esc(description)}">` : '') +
    (mode === 'live' ? '' : '<meta name="robots" content="noindex,nofollow">') +
    `<meta name="funnel_id" content="${esc(ctx.funnelId)}"><meta name="step_id" content="${esc(ctx.stepId)}">` +
    `<link rel="icon" href="${esc(favicon)}"><style>${css.replace(/<\/?style/gi, '')}</style>` +
    header +
    `</head><body class="${esc(bodyClasses.join(' '))}"><a class="fn-skip" href="#fn-main">Skip to content</a><main id="fn-main">${body}</main>` +
    runtime +
    footer +
    beacon +
    `</body></html>`;
  return { html, css, body };
}

export const isKnownFnType = isFnType;
