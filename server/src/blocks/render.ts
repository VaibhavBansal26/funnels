import { LIMITS } from './schema.js';
import { esc, formatMoney, parseVideoUrl, safeColor, safeImageSrc, safeUrl } from './safe.js';
import { sanitizeHtml } from './sanitize.js';

/**
 * Deterministic page renderer. `renderPage(doc, ctx)` is a pure function: the same input always yields
 * the same string, nothing is read from the clock, the environment or the network. It is defensive on
 * purpose (the document may come from an old backup or a hostile client): unknown block types are
 * skipped, oversized or too deeply nested documents are truncated, every value is escaped.
 */

export interface RenderContext {
  funnelId: string;
  stepId: string;
  stepName: string;
  title?: string | null;
  description?: string | null;
  customCss?: string | null;
  favicon?: string | null;
  headerCode?: string | null;
  footerCode?: string | null;
  /** Owner-only: custom HTML blocks keep scripts and event handlers. */
  allowScripts?: boolean;
  /** Inject header/footer tracking snippets verbatim. */
  allowTrackingCode?: boolean;
  /** Ordered steps of the funnel with the href each one should be linked at. */
  steps?: { id: string; href: string }[];
  /** live: public page; preview: signed preview (no page-view beacon); builder: static, script-free editor canvas. */
  mode?: 'live' | 'preview' | 'builder';
  apiBase?: string;
  beaconSrc?: string;
}

type L = Record<string, any>;

const str = (v: unknown, max: number = LIMITS.maxText): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const arr = (v: unknown): L[] => (Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null) as L[]) : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
const safeId = (v: unknown): string => str(v, 64).replace(/[^A-Za-z0-9_-]/g, '');

interface State {
  ctx: RenderContext;
  count: number;
  truncated: boolean;
  mainCheckoutId: string | null;
  hasCountdown: boolean;
  nextHref: string;
  hrefs: Map<string, string>;
}

const BASE_CSS = `
:root{--fn-accent:#2563eb;--fn-bg:#ffffff;--fn-text:#1f2937;--fn-muted:#6b7280;--fn-border:#e5e7eb;--fn-radius:10px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fn-bg);color:var(--fn-text);font-family:var(--fn-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);line-height:1.6;font-size:17px}
.fn-font-serif{--fn-font:Georgia,"Times New Roman",serif}.fn-font-mono{--fn-font:ui-monospace,Menlo,Consolas,monospace}
img,video,iframe{max-width:100%}a{color:var(--fn-accent)}
.fn-skip{position:absolute;left:-999px;top:0;background:#000;color:#fff;padding:8px 12px;z-index:10}.fn-skip:focus{left:8px;top:8px}
:focus-visible{outline:3px solid var(--fn-accent);outline-offset:2px}
.fn-wrap{width:100%;max-width:760px;margin:0 auto;padding:0 20px}
.fn-w-narrow{max-width:560px}.fn-w-wide{max-width:1040px}.fn-w-full{max-width:none}
.fn-section{width:100%}.fn-pad-none{padding:0}.fn-pad-sm{padding:20px 0}.fn-pad-md{padding:44px 0}.fn-pad-lg{padding:72px 0}.fn-pad-xl{padding:104px 0}
.fn-center{text-align:center}.fn-al-left{text-align:left}.fn-al-center{text-align:center}.fn-al-right{text-align:right}
.fn-b{margin:0 0 18px}.fn-b:last-child{margin-bottom:0}
h1,h2,h3,h4{line-height:1.2;margin:0 0 .5em;letter-spacing:-.01em}h1{font-size:clamp(2rem,5vw,3.2rem)}h2{font-size:clamp(1.6rem,4vw,2.3rem)}h3{font-size:1.4rem}h4{font-size:1.15rem}
p{margin:0 0 1em}
.fn-cols{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}.fn-gap-sm{gap:12px}.fn-gap-lg{gap:44px}
.fn-col{flex:1 1 0;min-width:0}
@media(max-width:640px){.fn-col{flex:1 1 100%}.fn-pad-lg{padding:48px 0}.fn-pad-xl{padding:64px 0}}
.fn-img{display:block;height:auto;border-radius:var(--fn-radius)}.fn-img-wrap.fn-al-center .fn-img{margin:0 auto}.fn-img-wrap.fn-al-right .fn-img{margin-left:auto}
.fn-btn-row{margin:6px 0}.fn-btn{display:inline-block;text-decoration:none;font-weight:700;border-radius:var(--fn-radius);padding:12px 24px;border:2px solid var(--fn-accent);background:var(--fn-accent);color:#fff;cursor:pointer;font:inherit;font-weight:700;line-height:1.3;text-align:center}
.fn-btn:hover{filter:brightness(.93)}.fn-btn-lg{padding:16px 34px;font-size:1.15em}.fn-btn-sm{padding:8px 16px;font-size:.9em}.fn-btn-block{display:block;width:100%}
.fn-btn-secondary{background:#111827;border-color:#111827}.fn-btn-outline{background:transparent;color:var(--fn-accent)}
.fn-video{position:relative;aspect-ratio:16/9;background:#000;border-radius:var(--fn-radius);overflow:hidden}.fn-video iframe,.fn-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
hr.fn-divider{border:0;border-top:1px solid var(--fn-border);margin:8px 0}
.fn-list{padding-left:1.3em;margin:0}.fn-list li{margin:.35em 0}.fn-list-check{list-style:none;padding:0}.fn-list-check li{padding-left:1.7em;position:relative}.fn-list-check li::before{content:"\\2713";position:absolute;left:0;color:var(--fn-accent);font-weight:700}
.fn-faq details{border:1px solid var(--fn-border);border-radius:var(--fn-radius);padding:14px 18px;margin:0 0 10px}.fn-faq summary{cursor:pointer;font-weight:700}.fn-faq details p{margin:10px 0 0}
.fn-countdown{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.fn-countdown>div{background:#111827;color:#fff;border-radius:var(--fn-radius);padding:12px 16px;min-width:76px;text-align:center}.fn-countdown strong{display:block;font-size:1.9rem;line-height:1.1;font-variant-numeric:tabular-nums}.fn-countdown small{opacity:.8}
.fn-cd-label{text-align:center;font-weight:700;margin-bottom:8px}.fn-cd-msg{text-align:center;font-weight:700}
.fn-form,.fn-offer{border:1px solid var(--fn-border);border-radius:var(--fn-radius);padding:22px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.fn-field{margin:0 0 14px}.fn-field label{display:block;font-weight:600;margin-bottom:4px;font-size:.95em}
.fn-field input[type=text],.fn-field input[type=email],.fn-field input[type=tel],.fn-field textarea,.fn-field select{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff;color:inherit}
.fn-check{display:flex;gap:8px;align-items:flex-start;font-weight:400!important}.fn-req{color:#b91c1c;margin-left:2px}
.fn-hp{position:absolute!important;left:-5000px!important;width:1px;height:1px;overflow:hidden}
.fn-status{margin:10px 0 0;font-weight:600}.fn-status.fn-error{color:#b91c1c}.fn-status.fn-ok{color:#047857}
.fn-offer h3{margin-bottom:4px}.fn-price{font-size:1.8rem;font-weight:800;margin:0 0 8px}.fn-note{font-size:.8rem;color:var(--fn-muted);margin:10px 0 0}
.fn-bump{display:flex;gap:10px;align-items:flex-start;border:2px dashed var(--fn-accent);border-radius:var(--fn-radius);padding:14px;background:#f8fafc;cursor:pointer}
.fn-html{overflow-wrap:anywhere}
@media(prefers-reduced-motion:no-preference){.fn-btn{transition:filter .15s}}
`.replace(/\n/g, '');

const COUNTDOWN_JS = `(function(){function p(n){return n<10?'0'+n:''+n}function set(el,u,v){var s=el.querySelector('[data-u=\"'+u+'\"]');if(s)s.textContent=p(v)}
document.querySelectorAll('[data-fn-countdown]').forEach(function(el){var end;if(el.getAttribute('data-mode')==='fixed'){end=Date.parse(el.getAttribute('data-end'))}else{var k='fn-cd-'+el.getAttribute('data-key'),s=0;try{s=+localStorage.getItem(k)}catch(e){}if(!s){s=Date.now();try{localStorage.setItem(k,String(s))}catch(e){}}end=s+(+el.getAttribute('data-minutes'))*60000}
function tick(){var left=Math.max(0,end-Date.now()),t=Math.floor(left/1000);set(el,'d',Math.floor(t/86400));set(el,'h',Math.floor(t%86400/3600));set(el,'m',Math.floor(t%3600/60));set(el,'s',t%60);if(left<=0){var m=el.parentNode.querySelector('.fn-cd-msg');if(m)m.hidden=false;clearInterval(i)}}
var i=setInterval(tick,1000);tick()})})();`;

/** Inline formatting: **bold**, *italic*, [text](url) with allow-listed URLs. Everything else is escaped text. */
export function inline(raw: string): string {
  const re = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)|\*\*([^*\n]{1,500})\*\*|\*([^*\n]{1,500})\*/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out += esc(raw.slice(last, m.index));
    if (m[1] !== undefined) {
      const url = safeUrl(m[2]);
      out += url ? `<a href="${esc(url)}" rel="noopener noreferrer nofollow">${esc(m[1])}</a>` : esc(m[0]);
    } else if (m[3] !== undefined) out += `<strong>${esc(m[3])}</strong>`;
    else out += `<em>${esc(m[4])}</em>`;
    last = re.lastIndex;
  }
  out += esc(raw.slice(last));
  return out.replace(/\r?\n/g, '<br>');
}

const styleAttr = (parts: (string | null)[]): string => {
  const joined = parts.filter(Boolean).join(';');
  return joined ? ` style="${esc(joined)}"` : '';
};
const alignClass = (a: unknown): string => (a === 'center' || a === 'right' || a === 'left' ? ` fn-al-${a}` : '');
const anchorAttr = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v) ? ` id="${esc(v)}"` : '');

function actionTarget(st: State, action: L): { href: string; newTab: boolean } {
  const builder = st.ctx.mode === 'builder';
  switch (action?.type) {
    case 'next_step':
      return { href: builder ? '#' : st.nextHref, newTab: false };
    case 'step':
      return { href: builder ? '#' : (st.hrefs.get(str(action.stepId, 64)) ?? '#'), newTab: false };
    case 'link':
      return { href: builder ? '#' : (safeUrl(action.url) ?? '#'), newTab: action.newTab === true };
    case 'anchor': {
      const a = str(action.anchor, 40);
      return { href: /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(a) ? `#${a}` : '#', newTab: false };
    }
    default:
      return { href: '#', newTab: false };
  }
}

function successAttrs(st: State, success: L | undefined): string {
  const type = oneOf(success?.type, ['next_step', 'url', 'message'] as const, 'message');
  if (type === 'next_step') return ` data-success="next_step" data-href="${esc(st.ctx.mode === 'builder' ? '#' : st.nextHref)}"`;
  if (type === 'url') return ` data-success="url" data-href="${esc(safeUrl(success?.url, ['http', 'https']) ?? '#')}"`;
  return ` data-success="message" data-message="${esc(str(success?.message, 500) || 'Thank you!')}"`;
}

function renderChildren(blocks: unknown, st: State, depth: number): string {
  if (depth > LIMITS.maxDepth) {
    st.truncated = true;
    return '';
  }
  let out = '';
  for (const b of arr(blocks)) {
    if (st.count >= LIMITS.maxBlocks) {
      st.truncated = true;
      break;
    }
    st.count++;
    out += renderBlock(b, st, depth);
  }
  return out;
}

const wrap = (type: string, inner: string, extra = ''): string => `<div class="fn-b fn-b-${type}${extra}">${inner}</div>`;

function renderBlock(b: L, st: State, depth: number): string {
  const ctx = st.ctx;
  switch (b.type) {
    case 'section': {
      const pad = oneOf(b.padding, ['none', 'sm', 'md', 'lg', 'xl'] as const, 'md');
      const width = oneOf(b.width, ['narrow', 'medium', 'wide', 'full'] as const, 'medium');
      const bg = safeColor(b.background);
      const cls = `fn-section fn-pad-${pad}${b.align === 'center' ? ' fn-center' : ''}`;
      return `<section class="${cls}"${anchorAttr(b.anchor)}${styleAttr([bg ? `background:${bg}` : null])}><div class="fn-wrap${width === 'medium' ? '' : ` fn-w-${width}`}">${renderChildren(b.children, st, depth + 1)}</div></section>`;
    }
    case 'columns': {
      const gap = oneOf(b.gap, ['sm', 'md', 'lg'] as const, 'md');
      const cols = arr(b.columns).slice(0, 5);
      const inner = cols
        .map((c) => `<div class="fn-col"${styleAttr([`flex-grow:${Math.round(num(c.width, 1, 1, 12))}`])}>${renderChildren(c.children, st, depth + 1)}</div>`)
        .join('');
      return `<div class="fn-cols fn-gap-${gap}">${inner}</div>`;
    }
    case 'heading': {
      const level = Math.round(num(b.level, 2, 1, 4));
      const color = safeColor(b.color);
      return `<h${level} class="fn-b${alignClass(b.align)}"${anchorAttr(b.anchor)}${styleAttr([color ? `color:${color}` : null])}>${inline(str(b.text, 500))}</h${level}>`;
    }
    case 'paragraph': {
      const color = safeColor(b.color);
      return `<p class="fn-b${alignClass(b.align)}"${anchorAttr(b.anchor)}${styleAttr([color ? `color:${color}` : null])}>${inline(str(b.text))}</p>`;
    }
    case 'image': {
      const src = safeImageSrc(b.src);
      if (!src) return '<!-- image: invalid source -->';
      const w = b.width ? Math.round(num(b.width, 0, 16, 2000)) : 0;
      const img = `<img class="fn-img" src="${esc(src)}" alt="${esc(str(b.alt, 300))}" loading="lazy"${w ? ` width="${w}"` : ''}${styleAttr(['max-width:100%'])}>`;
      const href = ctx.mode === 'builder' ? null : safeUrl(b.href);
      return wrap('image', href ? `<a href="${esc(href)}">${img}</a>` : img, ` fn-img-wrap${alignClass(b.align)}`);
    }
    case 'button': {
      const { href, newTab } = actionTarget(st, b.action ?? {});
      const style = oneOf(b.style, ['primary', 'secondary', 'outline'] as const, 'primary');
      const size = oneOf(b.size, ['sm', 'md', 'lg'] as const, 'md');
      const cls = `fn-btn fn-btn-${style} fn-btn-${size}${b.fullWidth ? ' fn-btn-block' : ''}`;
      const target = newTab ? ' target="_blank" rel="noopener noreferrer"' : '';
      return wrap('button', `<a class="${cls}" href="${esc(href)}"${target}>${inline(str(b.text, 120))}</a>`, ` fn-btn-row${alignClass(b.align)}`);
    }
    case 'video': {
      const v = parseVideoUrl(b.url);
      if (!v) return '<!-- video: source not allowed -->';
      const title = esc(str(b.title, 200) || 'Video');
      const media =
        v.kind === 'mp4'
          ? `<video controls preload="metadata" src="${esc(v.src)}" aria-label="${title}"></video>`
          : `<iframe src="${esc(v.src)}" title="${title}" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      return wrap('video', `<div class="fn-video">${media}</div>`);
    }
    case 'divider':
      return '<hr class="fn-divider">';
    case 'spacer':
      return `<div aria-hidden="true" style="height:${Math.round(num(b.height, 32, 4, 240))}px"></div>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, LIMITS.maxItems).map((i) => `<li>${inline(str(i, 500))}</li>`).join('');
      const cls = !b.ordered && b.icon !== 'dot' ? 'fn-list fn-list-check' : 'fn-list';
      return wrap('list', `<${tag} class="${cls}">${items}</${tag}>`);
    }
    case 'faq': {
      const items = arr(b.items)
        .slice(0, LIMITS.maxItems)
        .map((i) => `<details><summary>${esc(str(i.q, 300))}</summary><p>${inline(str(i.a, 2000))}</p></details>`)
        .join('');
      return wrap('faq', items, ' fn-faq');
    }
    case 'countdown': {
      st.hasCountdown = true;
      const mode = b.mode === 'evergreen' ? 'evergreen' : 'fixed';
      const attrs =
        mode === 'fixed'
          ? ` data-end="${esc(str(b.endsAt, 40))}"`
          : ` data-minutes="${Math.round(num(b.minutes, 30, 1, 60 * 24 * 30))}" data-key="${esc(`${ctx.stepId}-${safeId(b.id)}`)}"`;
      const cell = (u: string, label: string) => `<div><strong data-u="${u}">00</strong><small>${label}</small></div>`;
      const label = str(b.label, 200);
      return wrap(
        'countdown',
        `${label ? `<div class="fn-cd-label">${esc(label)}</div>` : ''}<div class="fn-countdown" role="timer" data-fn-countdown data-mode="${mode}"${attrs}>${cell('d', 'Days')}${cell('h', 'Hours')}${cell('m', 'Minutes')}${cell('s', 'Seconds')}</div><p class="fn-cd-msg" hidden>${esc(str(b.expiredText, 200) || 'This offer has ended')}</p>`,
      );
    }
    case 'form':
      return renderForm(b, st);
    case 'checkout':
      return renderCheckout(b, st);
    case 'html':
      return wrap('html', sanitizeHtml(str(b.html, LIMITS.maxHtml), { allowScripts: ctx.allowScripts === true }), ' fn-html');
    default:
      return '<!-- unsupported block -->';
  }
}

function endpoint(st: State, kind: 'forms' | 'checkout', blockId: string): string {
  const { ctx } = st;
  return `${ctx.apiBase ?? ''}/api/public/${kind}/${encodeURIComponent(ctx.funnelId)}/${encodeURIComponent(ctx.stepId)}/${encodeURIComponent(blockId)}`;
}

function renderForm(b: L, st: State): string {
  const bid = safeId(b.id);
  const fields = arr(b.fields)
    .slice(0, 20)
    .filter((f) => /^[a-z][a-z0-9_]{0,31}$/.test(str(f.id, 40)))
    .map((f) => {
      const id = str(f.id, 40);
      const fid = `f-${bid}-${id}`;
      const label = esc(str(f.label, 120));
      const req = f.required === true;
      const reqAttr = req ? ' required aria-required="true"' : '';
      const star = req ? '<span class="fn-req" aria-hidden="true">*</span>' : '';
      const ph = f.placeholder ? ` placeholder="${esc(str(f.placeholder, 120))}"` : '';
      const max = f.maxLength ? ` maxlength="${Math.round(num(f.maxLength, 255, 1, 5000))}"` : '';
      const type = oneOf(f.type, ['name', 'email', 'phone', 'text', 'textarea', 'select', 'checkbox'] as const, 'text');
      let control: string;
      if (type === 'textarea') control = `<textarea id="${fid}" name="${id}" rows="4"${ph}${max}${reqAttr}></textarea>`;
      else if (type === 'select') {
        const opts = (Array.isArray(f.options) ? f.options : []).slice(0, 30).map((o) => `<option value="${esc(str(o, 80))}">${esc(str(o, 80))}</option>`).join('');
        control = `<select id="${fid}" name="${id}"${reqAttr}><option value="">Select…</option>${opts}</select>`;
      } else if (type === 'checkbox') {
        return `<div class="fn-field"><label class="fn-check" for="${fid}"><input type="checkbox" id="${fid}" name="${id}" value="yes"${reqAttr}> <span>${label}${star}</span></label></div>`;
      } else {
        const htmlType = { email: 'email', phone: 'tel', name: 'text', text: 'text' }[type];
        const ac = { email: 'email', phone: 'tel', name: 'name', text: 'off' }[type];
        control = `<input type="${htmlType}" id="${fid}" name="${id}" autocomplete="${ac}"${ph}${max || ' maxlength="255"'}${reqAttr}>`;
      }
      return `<div class="fn-field"><label for="${fid}">${label}${star}</label>${control}</div>`;
    })
    .join('');
  const consent = b.consent?.enabled
    ? `<div class="fn-field"><label class="fn-check" for="f-${bid}-consent"><input type="checkbox" id="f-${bid}-consent" name="_consent" value="yes" required aria-required="true"> <span>${inline(str(b.consent.text, 400))}</span></label></div>`
    : '';
  const label = esc(str(b.submitLabel, 80) || 'Submit');
  const name = esc(str(b.name, 120) || 'Form');
  return wrap(
    'form',
    `<form class="fn-form" method="post" action="${esc(endpoint(st, 'forms', bid))}" data-fn-form aria-label="${name}"${successAttrs(st, b.success)}>${fields}${consent}<div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div><button class="fn-btn fn-btn-block" type="submit">${label}</button><p class="fn-status" role="status" aria-live="polite"></p></form>`,
  );
}

function renderCheckout(b: L, st: State): string {
  const bid = safeId(b.id);
  const price = num(b.price, 0, 0, 1_000_000);
  const currency = /^[A-Z]{3}$/.test(str(b.currency, 3)) ? str(b.currency, 3) : 'USD';
  const money = esc(formatMoney(price, currency));
  const name = esc(str(b.productName, 200));
  const desc = b.description ? `<p>${inline(str(b.description, 500))}</p>` : '';
  const action = esc(endpoint(st, 'checkout', bid));
  const test = '<p class="fn-note">Test mode: no real payment is taken.</p>';
  if (b.orderBump === true) {
    const form = st.mainCheckoutId ? ` form="co-${esc(st.mainCheckoutId)}"` : ' disabled';
    return wrap(
      'checkout',
      `<label class="fn-bump"><input type="checkbox" name="bump" value="${esc(bid)}"${form}> <span><strong>Yes, add ${name} for ${money}</strong>${b.description ? `<br>${inline(str(b.description, 500))}` : ''}</span></label>`,
    );
  }
  if (b.oneClickUpsell === true) {
    const decline = st.ctx.mode === 'builder' ? '#' : st.nextHref;
    return wrap(
      'checkout',
      `<div class="fn-offer" data-fn-upsell-box><h3>${name}</h3><p class="fn-price">${money}</p>${desc}<button type="button" class="fn-btn fn-btn-block" data-fn-upsell data-action="${action}"${successAttrs(st, b.success)}>${esc(str(b.buttonLabel, 80) || 'Yes, add to my order')}</button><p class="fn-status" role="status" aria-live="polite"></p><p class="fn-note"><a href="${esc(decline)}">No thanks</a></p>${test}</div>`,
    );
  }
  return wrap(
    'checkout',
    `<form class="fn-offer" id="co-${esc(bid)}" method="post" action="${action}" data-fn-checkout${successAttrs(st, b.success)}><h3>${name}</h3><p class="fn-price">${money}</p>${desc}<div class="fn-field"><label for="co-${esc(bid)}-email">Email<span class="fn-req" aria-hidden="true">*</span></label><input type="email" id="co-${esc(bid)}-email" name="email" autocomplete="email" maxlength="255" required aria-required="true"></div><div class="fn-field"><label for="co-${esc(bid)}-name">Name</label><input type="text" id="co-${esc(bid)}-name" name="name" autocomplete="name" maxlength="120"></div><div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div><button class="fn-btn fn-btn-block fn-btn-lg" type="submit">${esc(str(b.buttonLabel, 80) || 'Buy now')} · ${money}</button><p class="fn-status" role="status" aria-live="polite"></p>${test}</form>`,
  );
}

function findMainCheckout(blocks: unknown, depth = 0, seen = { n: 0 }): string | null {
  if (depth > LIMITS.maxDepth) return null;
  for (const b of arr(blocks)) {
    if (++seen.n > LIMITS.maxBlocks) return null;
    if (b.type === 'checkout' && b.orderBump !== true && b.oneClickUpsell !== true) return safeId(b.id);
    const kids = b.type === 'section' ? findMainCheckout(b.children, depth + 1, seen) : b.type === 'columns' ? arr(b.columns).map((c) => findMainCheckout(c.children, depth + 1, seen)).find(Boolean) ?? null : null;
    if (kids) return kids;
  }
  return null;
}

export function renderPage(doc: unknown, ctx: RenderContext): string {
  const d: L = typeof doc === 'object' && doc !== null ? (doc as L) : {};
  const settings: L = typeof d.settings === 'object' && d.settings !== null ? d.settings : {};
  const steps = ctx.steps ?? [];
  const idx = steps.findIndex((s) => s.id === ctx.stepId);
  const st: State = {
    ctx,
    count: 0,
    truncated: false,
    mainCheckoutId: findMainCheckout(d.blocks),
    hasCountdown: false,
    nextHref: idx >= 0 && steps[idx + 1] ? steps[idx + 1]!.href : '#',
    hrefs: new Map(steps.map((s) => [s.id, s.href])),
  };

  // Top-level blocks that are not sections get the default content wrapper.
  let body = '';
  for (const b of arr(d.blocks)) {
    if (st.count >= LIMITS.maxBlocks) {
      st.truncated = true;
      break;
    }
    st.count++;
    const html = renderBlock(b, st, 1);
    body += b.type === 'section' || b.type === 'columns' ? html : `<div class="fn-wrap">${html}</div>`;
  }
  if (st.truncated) body += '<!-- block or nesting limit reached; remaining content omitted -->';
  if (!body) body = '<div class="fn-wrap fn-pad-md"><p class="fn-center">This page is empty.</p></div>';

  const mode = ctx.mode ?? 'live';
  const accent = safeColor(settings.accent);
  const bg = safeColor(settings.background);
  const font = oneOf(settings.font, ['system', 'serif', 'mono'] as const, 'system');
  const rootVars = styleAttr([accent ? `--fn-accent:${accent}` : null, bg ? `--fn-bg:${bg}` : null]);
  const title = str(ctx.title, 200).trim() || str(ctx.stepName, 200) || 'Untitled';
  const description = str(ctx.description, 400).trim();
  const favicon = safeUrl(ctx.favicon, ['http', 'https']) ?? 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%232563eb%22/%3E%3Cpath d=%22M8 9h16l-6 7v7l-4-2v-5z%22 fill=%22%23fff%22/%3E%3C/svg%3E';
  const customCss = str(ctx.customCss, 20_000).replace(/</g, '\\3c ');
  const header = ctx.allowTrackingCode ? str(ctx.headerCode, 20_000) : '';
  const footer = ctx.allowTrackingCode ? str(ctx.footerCode, 20_000) : '';
  const preview = mode === 'preview';
  const beacon =
    mode === 'builder'
      ? ''
      : `<script async src="${esc(ctx.beaconSrc ?? `${ctx.apiBase ?? ''}/beacon.js`)}" data-funnel="${esc(ctx.funnelId)}" data-step="${esc(ctx.stepId)}" data-api="${esc(ctx.apiBase ?? '')}"${preview ? ' data-preview="1"' : ''}></script>`;
  const countdown = st.hasCountdown && mode !== 'builder' ? `<script>${COUNTDOWN_JS}</script>` : '';

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    (description ? `<meta name="description" content="${esc(description)}">` : '') +
    (mode === 'live' ? '' : '<meta name="robots" content="noindex,nofollow">') +
    `<meta name="funnel_id" content="${esc(ctx.funnelId)}"><meta name="step_id" content="${esc(ctx.stepId)}">` +
    `<link rel="icon" href="${esc(favicon)}"><style>${BASE_CSS}</style>` +
    (customCss ? `<style>${customCss}</style>` : '') +
    header +
    `</head><body class="fn-font-${font}"${rootVars}><a class="fn-skip" href="#fn-main">Skip to content</a><main id="fn-main">${body}</main>` +
    countdown +
    footer +
    beacon +
    `</body></html>`
  );
}
