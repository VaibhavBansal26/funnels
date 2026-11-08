import { esc, formatMoney, parseVideoUrl, safeImageSrc, safeUrl } from '../../blocks/safe.js';
import type { CartAddProps, CartCountProps, CartProps, CatalogProps, CountdownProps, FormProps, PaymentProps, ProductProps, ProgressProps, ReviewCtaProps, ReviewsProps, VideoProps } from './props.js';

/**
 * Inner HTML of the dynamic components. One implementation shared by the server renderer (published pages) and the
 * builder canvas (mode 'builder': inert, no endpoints), so what the editor shows is what gets published.
 * Everything interpolated is escaped; the output is also run through the server's allow-list sanitiser.
 */
export interface MarkupCtx {
  /** live: public page; preview: signed preview (nothing recorded); builder: inert editor canvas. */
  mode: 'live' | 'preview' | 'builder';
  funnelId: string;
  stepId: string;
  apiBase?: string;
  /** Link to the next step of the funnel ('#' when unknown). */
  nextHref: string;
  /** Block id of the main (non-bump, non-upsell) checkout of the page, which order bumps attach to. */
  mainCheckoutId?: string | null;
  /** Link of a step by id (one-click offers can accept or decline to a chosen step). */
  stepHref?: (stepId: string) => string | undefined;
  /** Google reviews: public token of a block, the review snapshot taken when the page was rendered, and the workspace's default place. */
  reviews?: { token(blockId: string): string; snapshot(placeId: string): ReviewsData | null; defaultPlaceId: string | null };
  /**
   * Product catalog blocks: the workspace's sellable products (active, one-time, with an active price) read when the page is rendered. Absent: none known
   * (the builder shows labelled sample cards, a published page its empty text).
   */
  catalog?: CatalogItem[];
}

/** An active one-time price of a catalog product, as the Product catalog block shows it. */
export interface CatalogPrice {
  id: string;
  /** Major units (12.5 = 12.50). */
  amount: number;
  currency: string;
  /** Older prices replaced by this one (a page that picked them shows this one). */
  replaces?: string[];
}
/** A product the Product catalog block can list. */
export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  image: string | null;
  imageAlt: string;
  createdAt: string;
  defaultPriceId: string | null;
  prices: CatalogPrice[];
  /** Template previews: the product slot this placeholder stands for. */
  slot?: string;
}
export interface CatalogCard { item: CatalogItem; price: CatalogPrice }

export interface ReviewItem { author: string; authorUri?: string; photoUri?: string; rating: number; text: string; lang?: string; when?: string }
/** Review content as shown on a page. Comes from the Places API (New) through the server's cache (source `google`) or from the author's own testimonials (`fallback`). */
export interface ReviewsData { source: 'google' | 'fallback'; rating: number | null; total: number | null; mapsUri: string | null; placeName?: string; reviews: ReviewItem[]; fetchedAt?: string }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const safeId = (v: unknown): string => str(v, 64).replace(/[^A-Za-z0-9_-]/g, '');

/** Inline formatting for short copy: **bold**, *italic*, [text](url). Everything else is escaped text. */
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

function successAttrs(ctx: MarkupCtx, success: FormProps['success'] | undefined): string {
  const builder = ctx.mode === 'builder';
  const type = success?.type ?? 'message';
  if (type === 'next_step') return ` data-success="next_step" data-href="${esc(builder ? '#' : ctx.nextHref)}"`;
  if (type === 'url') return ` data-success="url" data-href="${esc(safeUrl(success && 'url' in success ? success.url : '', ['http', 'https']) ?? '#')}"`;
  return ` data-success="message" data-message="${esc(success && 'message' in success ? str(success.message, 500) || 'Thank you!' : 'Thank you!')}"`;
}

export function publicEndpoint(ctx: MarkupCtx, kind: 'forms' | 'checkout' | 'pay', blockId: string): string {
  return `${ctx.apiBase ?? ''}/api/public/${kind}/${encodeURIComponent(ctx.funnelId)}/${encodeURIComponent(ctx.stepId)}/${encodeURIComponent(blockId)}`;
}

export function formInner(blockId: string, p: FormProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const fields = p.fields
    .slice(0, 20)
    .filter((f) => /^[a-z][a-z0-9_]{0,31}$/.test(f.id))
    .map((f) => {
      const fid = `f-${bid}-${f.id}`;
      const label = esc(f.label);
      const reqAttr = f.required ? ' required aria-required="true"' : '';
      const star = f.required ? '<span class="fn-req" aria-hidden="true">*</span>' : '';
      const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
      const max = f.maxLength ? ` maxlength="${Math.round(f.maxLength)}"` : '';
      let control: string;
      if (f.type === 'textarea') control = `<textarea id="${fid}" name="${f.id}" rows="4"${ph}${max}${reqAttr}></textarea>`;
      else if (f.type === 'select') {
        const opts = (f.options ?? []).slice(0, 30).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        control = `<select id="${fid}" name="${f.id}"${reqAttr}><option value="">Select…</option>${opts}</select>`;
      } else if (f.type === 'checkbox') {
        return `<div class="fn-field"><label class="fn-check" for="${fid}"><input type="checkbox" id="${fid}" name="${f.id}" value="yes"${reqAttr}> <span>${label}${star}</span></label></div>`;
      } else {
        const htmlType = { email: 'email', phone: 'tel', name: 'text', text: 'text' }[f.type];
        const ac = { email: 'email', phone: 'tel', name: 'name', text: 'off' }[f.type];
        control = `<input type="${htmlType}" id="${fid}" name="${f.id}" autocomplete="${ac}"${ph}${max || ' maxlength="255"'}${reqAttr}>`;
      }
      return `<div class="fn-field"><label for="${fid}">${label}${star}</label>${control}</div>`;
    })
    .join('');
  const consent = p.consent?.enabled
    ? `<div class="fn-field"><label class="fn-check" for="f-${bid}-consent"><input type="checkbox" id="f-${bid}-consent" name="_consent" value="yes" required aria-required="true"> <span>${inline(str(p.consent.text, 400))}</span></label></div>`
    : '';
  const hp = '<div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>';
  return `<form class="fn-form" method="post" action="${esc(publicEndpoint(ctx, 'forms', bid))}" data-fn-form aria-label="${esc(p.name || 'Form')}"${successAttrs(ctx, p.success)}>${fields}${consent}${hp}<button class="fn-btn fn-btn-primary fn-btn-block" type="submit">${esc(p.submitLabel || 'Submit')}</button><p class="fn-status" role="status" aria-live="polite"></p></form>`;
}

const EVERY: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

/** "$29.00 / month", "$29.00 every 3 months" or just "$38.00". */
function priceLabel(p: ProductProps): string {
  const money = formatMoney(p.price, p.currency);
  return p.interval ? `${money} / ${EVERY[p.interval] ?? 'month'}` : money;
}

export function checkoutInner(blockId: string, p: ProductProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const money = esc(priceLabel(p));
  const name = esc(p.productName);
  const desc = p.description ? `<p>${inline(p.description)}</p>` : '';
  const action = esc(publicEndpoint(ctx, 'checkout', bid));
  const test = '<p class="fn-note">Test mode: no real payment is taken.</p>';
  const trial = p.interval && p.trialDays ? `<p class="fn-note">${Math.round(p.trialDays)}-day free trial, then ${esc(priceLabel(p))}.</p>` : '';
  if (p.orderBump) {
    const form = ctx.mainCheckoutId ? ` form="co-${esc(ctx.mainCheckoutId)}"` : ' disabled';
    return `<label class="fn-bump"><input type="checkbox" name="bump" value="${esc(bid)}"${form}> <span><strong>Yes, add ${name} for ${money}</strong>${p.description ? `<br>${inline(p.description)}` : ''}</span></label>`;
  }
  if (p.oneClickUpsell) {
    const builder = ctx.mode === 'builder';
    const at = (id: string | undefined) => (id && !builder ? ctx.stepHref?.(id) : undefined);
    const decline = builder ? '#' : (at(p.declineStepId) ?? ctx.nextHref);
    const accept = at(p.acceptStepId);
    const done = accept ? ` data-success="next_step" data-href="${esc(accept)}"` : successAttrs(ctx, p.success);
    return `<div class="fn-offer" data-fn-upsell-box><h3>${name}</h3><p class="fn-price">${money}</p>${desc}<button type="button" class="fn-btn fn-btn-primary fn-btn-block" data-fn-upsell data-action="${action}"${done}>${esc(p.buttonLabel || 'Yes, add to my order')}</button><p class="fn-status" role="status" aria-live="polite"></p><p class="fn-note"><a href="${esc(decline)}">No thanks</a></p>${test}</div>`;
  }
  const q = p.quantity?.enabled ? p.quantity : null;
  const qty = q
    ? `<div class="fn-field"><label for="co-${esc(bid)}-qty">Quantity</label><select id="co-${esc(bid)}-qty" name="quantity">${Array.from({ length: Math.max(0, Math.min(q.max, 99) - q.min + 1) }, (_, i) => q.min + i).map((n) => `<option value="${n}"${n === Math.min(Math.max(q.default, q.min), q.max) ? ' selected' : ''}>${n}</option>`).join('')}</select></div>`
    : '';
  return `<form class="fn-offer" id="co-${esc(bid)}" method="post" action="${action}" data-fn-checkout${successAttrs(ctx, p.success)}><h3>${name}</h3><p class="fn-price">${money}</p>${desc}${trial}<div class="fn-field"><label for="co-${esc(bid)}-email">Email<span class="fn-req" aria-hidden="true">*</span></label><input type="email" id="co-${esc(bid)}-email" name="email" autocomplete="email" maxlength="255" required aria-required="true"></div><div class="fn-field"><label for="co-${esc(bid)}-name">Name</label><input type="text" id="co-${esc(bid)}-name" name="name" autocomplete="name" maxlength="120"></div>${qty}<div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div><button class="fn-btn fn-btn-primary fn-btn-block fn-btn-lg" type="submit">${esc(p.buttonLabel || 'Buy now')} · ${money}</button><p class="fn-status" role="status" aria-live="polite"></p>${p.allowPromotionCodes ? '<p class="fn-note">Have a promotion code? You can enter it on the next screen.</p>' : ''}${test}</form>`;
}

export function videoInner(p: VideoProps, ctx: MarkupCtx): string {
  const v = parseVideoUrl(p.url);
  const title = esc(p.title || 'Video');
  if (!v) return '<div class="fn-video fn-video-empty"><span>Add a YouTube, Vimeo or .mp4 URL</span></div>';
  if (ctx.mode === 'builder') return `<div class="fn-video fn-video-placeholder" role="img" aria-label="${title}"><span class="fn-video-play" aria-hidden="true"></span><span class="fn-video-label">${esc(v.kind === 'mp4' ? 'MP4 video' : v.kind === 'youtube' ? 'YouTube video' : 'Vimeo video')}: ${title}</span></div>`;
  const media =
    v.kind === 'mp4'
      ? `<video controls preload="metadata" src="${esc(v.src)}" aria-label="${title}"></video>`
      : `<iframe src="${esc(v.src)}" title="${title}" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  return `<div class="fn-video">${media}</div>`;
}

export function countdownInner(blockId: string, p: CountdownProps, ctx: MarkupCtx): string {
  const mode = p.mode === 'evergreen' ? 'evergreen' : 'fixed';
  const attrs = mode === 'fixed' ? ` data-end="${esc(str(p.endsAt, 40))}"` : ` data-minutes="${Math.round(Math.min(Math.max(p.minutes ?? 30, 1), 60 * 24 * 30))}" data-key="${esc(`${ctx.stepId}-${safeId(blockId)}`)}"`;
  const cell = (u: string, label: string) => `<div><strong data-u="${u}">00</strong><small>${label}</small></div>`;
  const label = str(p.label, 200);
  return `${label ? `<div class="fn-cd-label">${esc(label)}</div>` : ''}<div class="fn-countdown" role="timer" data-fn-countdown data-mode="${mode}"${attrs}>${cell('d', 'Days')}${cell('h', 'Hours')}${cell('m', 'Minutes')}${cell('s', 'Seconds')}</div><p class="fn-cd-msg" hidden>${esc(p.expiredText || 'This offer has ended')}</p>`;
}

export function progressInner(p: ProgressProps): string {
  const v = Math.round(Math.min(Math.max(Number.isFinite(p.value) ? p.value : 0, 0), 100));
  const label = p.label ? `<div class="fn-progress-label"><span>${esc(p.label)}</span><span>${v}%</span></div>` : '';
  return `${label}<div class="fn-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"${p.label ? ` aria-label="${esc(p.label)}"` : ''}><div class="fn-progress-bar" style="width:${v}%"></div></div>`;
}

// ---- Google reviews ---------------------------------------------------------------------------------------------------------------------------------------

const GOOGLE_HOST = /(^|\.)(google\.com|goo\.gl)$/i;
const PHOTO_HOST = /(^|\.)googleusercontent\.com$/i;
/** An https link on a Google host (author profile, "view on Google Maps"). Anything else is dropped, not rewritten. */
export function googleLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && GOOGLE_HOST.test(u.hostname) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}
export function googlePhoto(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && PHOTO_HOST.test(u.hostname) && !u.username ? u.toString() : null;
  } catch {
    return null;
  }
}
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** 4.66 -> "4.7"; stars are filled to the nearest whole star (half rounds up): 4.5 shows five. */
export const ratingLabel = (r: number): string => (Math.round(Math.min(5, Math.max(0, r)) * 10) / 10).toFixed(1);
export const starCount = (r: number): number => Math.min(5, Math.max(0, Math.floor(r + 0.5)));
const stars = (r: number): string => `<span class="fn-rv-stars" role="img" aria-label="${esc(ratingLabel(r))} out of 5 stars"><span aria-hidden="true">${'★'.repeat(starCount(r))}${'☆'.repeat(5 - starCount(r))}</span></span>`;

function reviewItem(r: ReviewItem, google: boolean): string {
  const photo = googlePhoto(r.photoUri);
  const uri = googleLink(r.authorUri);
  const avatar = google && photo ? `<img class="fn-rv-avatar" src="${esc(photo)}" alt="" width="40" height="40" loading="lazy">` : '';
  const name = `<span class="fn-rv-name">${esc(str(r.author, 120) || 'Google user')}</span>`;
  const who = google && uri ? `<a class="fn-rv-author" href="${esc(uri)}" target="_blank" rel="noopener noreferrer nofollow">${avatar}${name}</a>` : `<span class="fn-rv-author">${avatar}${name}</span>`;
  const lang = r.lang && LANG.test(r.lang) ? ` lang="${esc(r.lang)}"` : '';
  const text = r.text ? `<blockquote class="fn-rv-text"${lang} dir="auto">${esc(str(r.text, 4000))}</blockquote>` : '';
  const when = r.when ? `<span class="fn-rv-when">${esc(str(r.when, 60))}</span>` : '';
  return `<li class="fn-rv-item">${who}<div class="fn-rv-meta">${stars(r.rating)}${when}</div>${text}</li>`;
}

/** The items a block shows: Google reviews filtered by the block's minimum rating and count, or the author's own testimonials. */
export function reviewsToShow(p: ReviewsProps, data: ReviewsData | null): ReviewsData {
  if (data && data.source === 'google' && (data.reviews.length || data.total)) {
    return { ...data, reviews: data.reviews.filter((r) => r.rating >= p.minRating).slice(0, p.count) };
  }
  return { source: 'fallback', rating: null, total: null, mapsUri: null, reviews: p.fallback.map((f) => ({ author: f.name, rating: f.rating ?? 5, text: f.text })).slice(0, p.count) };
}

export function reviewsInner(blockId: string, p: ReviewsProps, data: ReviewsData | null, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const shown = reviewsToShow(p, data);
  const google = shown.source === 'google';
  const token = ctx.mode === 'builder' ? '' : ctx.reviews?.token(bid) ?? '';
  const attrs = ` data-fn-reviews data-variant="${esc(p.variant)}" data-layout="${p.layout}" data-count="${p.count}" data-min="${p.minRating}" data-text="${p.showText ? 1 : 0}"${token ? ` data-token="${esc(token)}" data-api="${esc(ctx.apiBase ?? '')}"` : ''}`;
  const maps = googleLink(shown.mapsUri);
  const attribution = google
    ? `<p class="fn-rv-attr">Reviews from ${maps ? `<a href="${esc(maps)}" target="_blank" rel="noopener noreferrer nofollow">Google Maps</a>` : 'Google Maps'}</p>`
    : shown.reviews.length ? `<p class="fn-rv-attr">Customer feedback</p>` : ctx.mode === 'builder' ? '<p class="fn-rv-attr">Connect a Google place in the Settings tab to show your Google reviews. Until then your own testimonials are shown.</p>' : '';
  const aggregate = google && shown.rating !== null ? `<div class="fn-rv-summary">${stars(shown.rating)} <strong>${esc(ratingLabel(shown.rating))}</strong>${shown.total ? ` <span>(${Math.round(shown.total)} Google reviews)</span>` : ''}</div>` : '';
  if (p.variant === 'badge') {
    if (!google || shown.rating === null) return `<div class="fn-rv fn-rv-badge-wrap"${attrs}>${attribution}</div>`;
    return `<div class="fn-rv fn-rv-badge-wrap"${attrs}><div class="fn-rv-badge">${aggregate}</div>${attribution}</div>`;
  }
  const items = shown.reviews.map((r) => reviewItem(p.showText ? r : { ...r, text: '' }, google)).join('');
  const list = items ? `<ul class="fn-rv-list ${p.variant === 'carousel' ? 'fn-rv-carousel' : p.layout === 'stack' ? 'fn-rv-stack' : 'fn-rv-grid'}"${p.variant === 'carousel' ? ' tabindex="0" aria-label="Reviews"' : ''}>${items}</ul>` : '';
  return `<div class="fn-rv"${attrs}>${aggregate}${list}${attribution}</div>`;
}

export function reviewCtaInner(blockId: string, p: ReviewCtaProps, ctx: MarkupCtx): string {
  const place = p.placeId || ctx.reviews?.defaultPlaceId || '';
  const label = esc(p.label);
  const prompt = p.prompt ? `<p class="fn-rc-prompt">${esc(p.prompt)}</p>` : '';
  if (!place || !/^[A-Za-z0-9_-]{10,200}$/.test(place)) {
    return ctx.mode === 'builder' ? `${prompt}<span class="fn-btn fn-btn-primary fn-rc-btn" aria-disabled="true">${label}</span><p class="fn-note">Choose a Google place in the Settings tab (or set a default in Settings &gt; Integrations).</p>` : '';
  }
  const wait = p.delaySeconds > 0 && ctx.mode !== 'builder' ? ` fn-rc-wait fn-rc-d${p.delaySeconds}` : '';
  return `<div class="fn-rc${wait}" data-fn-review-cta>${prompt}<a class="fn-btn fn-btn-primary fn-rc-btn" href="${esc(ctx.mode === 'builder' ? '#' : `https://search.google.com/local/writereview?placeid=${encodeURIComponent(place)}`)}" target="_blank" rel="noopener noreferrer">${label}</a></div>`;
}


// ---- cart and payment form ------------------------------------------------------------------------------------------------------------------------
// The markup is a shell the beacon fills (cart lines, totals, card fields): every value it shows comes from the server's answer, never from the page.

const qtyOptions = (q: { min: number; max: number; default: number }) =>
  Array.from({ length: Math.max(0, Math.min(q.max, 99) - q.min + 1) }, (_, i) => q.min + i).map((n) => `<option value="${n}"${n === Math.min(Math.max(q.default, q.min), q.max) ? ' selected' : ''}>${n}</option>`).join('');

function stepLink(ctx: MarkupCtx, stepId: string | undefined, fallbackNext: boolean): string {
  if (ctx.mode === 'builder') return '#';
  const hit = stepId ? ctx.stepHref?.(stepId) : undefined;
  return hit ?? (fallbackNext ? ctx.nextHref : '#');
}

export function cartAddInner(blockId: string, p: CartAddProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const money = esc(formatMoney(p.price, p.currency));
  const then = p.then?.type === 'step' ? stepLink(ctx, p.then.stepId, true) : p.then?.type === 'next_step' ? stepLink(ctx, undefined, true) : '';
  const action = `${ctx.apiBase ?? ''}/api/public/cart/${encodeURIComponent(ctx.funnelId)}/${encodeURIComponent(ctx.stepId)}/${encodeURIComponent(bid)}/add`;
  const q = p.quantity?.enabled ? p.quantity : null;
  const qty = q ? `<div class="fn-field"><label for="atc-${bid}-qty">Quantity</label><select id="atc-${bid}-qty" name="quantity">${qtyOptions(q)}</select></div>` : '';
  // The product is named by the form's label (and usually by the card around it): the visible line is the price.
  const price = p.showPrice ? `<p class="fn-cart-add-price">${money}</p>` : '';
  return `<form class="fn-cart-add" method="post" action="${esc(action)}" data-fn-cart-add${then ? ` data-href="${esc(then)}"` : ''} aria-label="${esc(`Add ${p.productName} to the cart`)}">${price}${qty}<button class="fn-btn fn-btn-primary" type="submit">${esc(p.label || 'Add to cart')}</button><p class="fn-status" role="status" aria-live="polite"></p></form>`;
}

/** Sample lines for the builder canvas (never published: the published cart is filled from the server). */
const SAMPLE_LINES = [{ name: 'Sample product', q: 2, unit: '$24.00', total: '$48.00' }, { name: 'Another product', q: 1, unit: '$12.00', total: '$12.00' }];

export function cartInner(blockId: string, p: CartProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const checkout = stepLink(ctx, p.checkoutStepId, true);
  const sample = ctx.mode === 'builder'
    ? `<ul class="fn-cart-lines">${SAMPLE_LINES.map((l) => `<li class="fn-cart-line"><div class="fn-cart-info"><span class="fn-cart-name">${l.name}</span><span class="fn-cart-unit">${l.unit} each</span></div><div class="fn-qty"><button type="button" tabindex="-1">−</button><output>${l.q}</output><button type="button" tabindex="-1">+</button></div><span class="fn-cart-sum">${l.total}</span><button type="button" class="fn-cart-remove" tabindex="-1">Remove</button></li>`).join('')}</ul><div class="fn-totals"><div><span>Subtotal</span><span>$60.00</span></div><div class="fn-total"><span>Total</span><span>$60.00</span></div></div><p class="fn-note">Sample lines (editor only). Visitors see their own cart.</p>`
    : `<p class="fn-cart-empty">${esc(p.emptyText || 'Your cart is empty.')}</p>`;
  const title = p.title ? `<h3>${esc(p.title)}</h3>` : '';
  return `<div class="fn-cart" data-fn-cart data-block="${esc(bid)}" data-empty="${esc(p.emptyText || 'Your cart is empty.')}"${p.showBumps ? ' data-bumps="1"' : ''}>${title}<div data-fn-cart-body aria-live="polite">${sample}</div><a class="fn-btn fn-btn-primary fn-btn-block" href="${esc(checkout)}" data-fn-cart-checkout>${esc(p.checkoutLabel || 'Checkout')}</a><p class="fn-status" role="status" aria-live="polite"></p></div>`;
}

export function cartCountInner(p: CartCountProps, ctx: MarkupCtx): string {
  const label = p.label || 'Cart';
  const n = ctx.mode === 'builder' ? '2' : '0';
  return `<a class="fn-cart-count" href="${esc(stepLink(ctx, p.cartStepId, false))}" data-fn-cart-count data-label="${esc(label)}" aria-label="${esc(`${label}, ${n} items`)}"><span>${esc(label)}</span> <span class="fn-cart-n" data-fn-cart-n>${n}</span></a>`;
}

export function paymentInner(blockId: string, p: PaymentProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const builder = ctx.mode === 'builder';
  const fid = (k: string) => `pay-${bid}-${k}`;
  const field = (k: string, label: string, input: string, required: boolean) => `<div class="fn-field"><label for="${fid(k)}">${esc(label)}${required ? '<span class="fn-req" aria-hidden="true">*</span>' : ''}</label>${input}</div>`;
  const text = (k: string, name: string, ac: string, max: number, required: boolean, type = 'text') => `<input type="${type}" id="${fid(k)}" name="${name}" autocomplete="${ac}" maxlength="${max}"${required ? ' required aria-required="true"' : ''}>`;
  const product = p.source === 'product';
  const money = esc(formatMoney(p.price, p.currency));
  const q = product && p.quantity?.enabled ? p.quantity : null;
  const summary = product
    ? `<ul class="fn-pay-lines"><li class="fn-pay-line"><span>${esc(p.productName)}</span><span>${money}</span></li></ul><div class="fn-totals"><div class="fn-total"><span>Total</span><span>${money}</span></div></div>`
    : builder
      ? `<ul class="fn-pay-lines">${SAMPLE_LINES.map((l) => `<li class="fn-pay-line"><span>${l.name} × ${l.q}</span><span>${l.total}</span></li>`).join('')}</ul><div class="fn-totals"><div class="fn-total"><span>Total</span><span>$60.00</span></div></div><p class="fn-note">Sample order (editor only): the published form shows the visitor's cart.</p>`
      : '<p class="fn-muted" data-fn-pay-loading>Loading your order…</p>';
  const address = p.collectAddress
    ? field('line1', 'Address', text('line1', 'line1', 'address-line1', 200, true), true) +
      `<div class="fn-pay-row">${field('city', 'City', text('city', 'city', 'address-level2', 100, true), true)}${field('postal', 'Postal code', text('postal', 'postalCode', 'postal-code', 20, true), true)}</div>` +
      field('country', 'Country (2-letter code)', `<input type="text" id="${fid('country')}" name="country" autocomplete="country" maxlength="2" placeholder="US" required aria-required="true">`, true)
    : '';
  const card = builder
    ? '<div class="fn-pay-mock" aria-hidden="true"><div class="fn-pay-fake">Card number</div><div class="fn-pay-row"><div class="fn-pay-fake">MM / YY</div><div class="fn-pay-fake">CVC</div></div></div><p class="fn-note">Card fields appear here on the published page: the Stripe Payment Element, or a labelled TEST card form while payments are in test mode.</p>'
    : `<p class="fn-note" data-fn-pay-wait>${p.mode === 'hosted' ? 'You will enter your card on Stripe’s secure checkout page.' : 'Loading secure card fields…'}</p>`;
  const note = p.mode === 'hosted' ? 'Payments are processed by Stripe.' : 'Card details are entered in a secure field and never touch this site.';
  return `<form class="fn-pay" id="co-${esc(bid)}" method="post" action="${esc(publicEndpoint(ctx, 'pay', bid))}" data-fn-pay data-mode="${p.mode}" data-source="${p.source}"${p.collectAddress ? ' data-address="1"' : ''}${successAttrs(ctx, p.success)} aria-label="${esc(p.title || 'Payment')}" novalidate>`
    + (p.title ? `<h3>${esc(p.title)}</h3>` : '')
    + `<div class="fn-pay-summary" data-fn-pay-summary aria-live="polite">${summary}</div>`
    + (q ? field('qty', 'Quantity', `<select id="${fid('qty')}" name="quantity">${qtyOptions(q)}</select>`, false) : '')
    + field('email', 'Email', text('email', 'email', 'email', 254, true, 'email'), true)
    + (p.collectName ? field('name', 'Name on card', text('name', 'name', 'name', 120, false), false) : '')
    + address
    + `<div class="fn-field"><span class="fn-pay-label" id="${fid('cardlabel')}">Payment</span><div class="fn-pay-card" data-fn-pay-card role="group" aria-labelledby="${fid('cardlabel')}">${card}</div></div>`
    + '<div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div>'
    + `<button class="fn-btn fn-btn-primary fn-btn-block fn-btn-lg" type="submit">${esc(p.buttonLabel || 'Pay now')}</button><p class="fn-status" role="status" aria-live="polite"></p><p class="fn-note">${note}</p></form>`;
}

// ---- product catalog ----------------------------------------------------------------------------------------------------------------------------------
// The cards are rendered from the catalog snapshot of the render (server: read from the database; builder: the owner's products). Each card is an Add to cart
// form naming its product (its button is named "<label>: <product>", starting with the visible text): the server checks the product against the block and re-reads its price on every add, so nothing priced here is trusted.

/** The price a card sells: the chosen one (or the price that replaced it), else the product's default price, else its first active price. */
export function priceOfItem(item: CatalogItem, priceId?: string): CatalogPrice | null {
  if (priceId) {
    const hit = item.prices.find((p) => p.id === priceId || p.replaces?.includes(priceId));
    if (hit) return hit;
  }
  return item.prices.find((p) => p.id === item.defaultPriceId) ?? item.prices[0] ?? null;
}

const byCreated = (a: CatalogCard, b: CatalogCard) => (a.item.createdAt < b.item.createdAt ? -1 : a.item.createdAt > b.item.createdAt ? 1 : a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
const byName = (a: CatalogCard, b: CatalogCard) => a.item.name.localeCompare(b.item.name, 'en') || byCreated(a, b);

/** The cards a block shows, in order: its hand-picked products (in the order picked), or every listed product sorted as asked; at most `limit`. */
export function catalogCards(p: Pick<CatalogProps, 'source' | 'picks' | 'sort' | 'limit'>, items: CatalogItem[]): CatalogCard[] {
  const out: CatalogCard[] = [];
  if (p.source === 'picked') {
    for (const pick of p.picks ?? []) {
      const item = items.find((i) => (pick.productId ? i.id === pick.productId : !!pick.slot && i.slot === pick.slot)) ?? (pick.slot ? items.find((i) => i.slot === pick.slot) : undefined);
      const price = item ? priceOfItem(item, pick.priceId) : null;
      if (item && price && !out.some((c) => c.item.id === item.id)) out.push({ item, price });
    }
  } else {
    for (const item of items) {
      const price = priceOfItem(item);
      if (price) out.push({ item, price });
    }
    const sort = p.sort ?? 'catalog';
    out.sort(sort === 'newest' ? (a, b) => byCreated(b, a) : sort === 'price_asc' ? (a, b) => a.price.amount - b.price.amount || byName(a, b) : sort === 'price_desc' ? (a, b) => b.price.amount - a.price.amount || byName(a, b) : byCreated);
  }
  return out.slice(0, Math.max(1, p.limit ?? 12));
}

/** Labelled sample cards for the builder canvas when the catalog has no product yet (never published). */
export const SAMPLE_CATALOG: CatalogItem[] = [
  { id: 'sample_1', name: 'Sample product', description: 'Your product description appears here.', image: null, imageAlt: '', createdAt: '1', defaultPriceId: 's1', prices: [{ id: 's1', amount: 24, currency: 'USD' }] },
  { id: 'sample_2', name: 'Another product', description: 'Add products in Products to fill this grid.', image: null, imageAlt: '', createdAt: '2', defaultPriceId: 's2', prices: [{ id: 's2', amount: 12, currency: 'USD' }] },
  { id: 'sample_3', name: 'Third product', description: 'Prices always come from your catalog.', image: null, imageAlt: '', createdAt: '3', defaultPriceId: 's3', prices: [{ id: 's3', amount: 36, currency: 'USD' }] },
];

export function catalogInner(blockId: string, p: CatalogProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const builder = ctx.mode === 'builder';
  const known = ctx.catalog ?? [];
  // The canvas shows sample cards while the owner has nothing to list (and while their products load); a published page shows only real products.
  const sample = builder && (ctx.catalog === undefined || (known.length === 0 && p.source === 'all'));
  const cards = catalogCards(p, sample ? SAMPLE_CATALOG : known);
  const cols = Math.min(4, Math.max(1, Math.round(p.columns ?? 3)));
  const head = `<div class="fn-catalog fn-catalog-c${cols}" data-fn-catalog data-block="${esc(bid)}">`;
  if (!cards.length) {
    const why = builder ? (p.source === 'picked' ? 'Pick products in the settings to show them here.' : '') : '';
    return `${head}<p class="fn-catalog-empty">${esc(p.emptyText || 'No products are available right now.')}</p>${why ? `<p class="fn-note">${esc(why)} (Editor only.)</p>` : ''}</div>`;
  }
  const then = p.action === 'buy' ? stepLink(ctx, p.checkoutStepId, true) : p.then?.type === 'step' ? stepLink(ctx, p.then.stepId, true) : p.then?.type === 'next_step' ? stepLink(ctx, undefined, true) : '';
  const action = `${ctx.apiBase ?? ''}/api/public/cart/${encodeURIComponent(ctx.funnelId)}/${encodeURIComponent(ctx.stepId)}/${encodeURIComponent(bid)}/add`;
  const q = p.quantity?.enabled ? p.quantity : null;
  const label = p.buttonLabel || (p.action === 'buy' ? 'Buy now' : 'Add to cart');
  const items = cards.map(({ item, price }, i) => {
    const name = str(item.name, 200);
    const src = p.showImage ? safeImageSrc(item.image) : null;
    const img = !p.showImage ? '' : src
      ? `<img class="fn-catalog-img" src="${esc(src)}" alt="${esc(str(item.imageAlt, 300))}" loading="lazy">`
      : `<div class="fn-catalog-img fn-catalog-noimg" aria-hidden="true"><span>${esc(name.slice(0, 1).toUpperCase())}</span></div>`;
    const desc = p.showDescription && item.description ? `<p class="fn-catalog-desc">${esc(str(item.description, 600))}</p>` : '';
    const money = p.showPrice ? `<p class="fn-catalog-price">${esc(formatMoney(price.amount, price.currency))}</p>` : '';
    const qid = `cat-${bid}-${i}-qty`;
    const qty = q ? `<div class="fn-field"><label for="${qid}">Quantity</label><select id="${qid}" name="quantity">${qtyOptions(q)}</select></div>` : '';
    return `<li class="fn-catalog-item">${img}<div class="fn-catalog-body"><h3 class="fn-catalog-name">${esc(name)}</h3>${desc}${money}`
      + `<form class="fn-cart-add fn-catalog-form" method="post" action="${esc(action)}" data-fn-cart-add data-product="${esc(safeId(item.id))}"${then ? ` data-href="${esc(then)}"` : ''} aria-label="${esc(`Add ${name} to the cart`)}">`
      + `${qty}<button class="fn-btn fn-btn-primary fn-btn-block" type="submit" aria-label="${esc(`${label}: ${name}`)}">${esc(label)}</button><p class="fn-status" role="status" aria-live="polite"></p></form></div></li>`;
  }).join('');
  const note = sample ? '<p class="fn-note">Sample products (editor only). Your active one-time products appear here.</p>' : '';
  return `${head}<ul class="fn-catalog-grid" aria-label="Products">${items}</ul>${note}</div>`;
}
