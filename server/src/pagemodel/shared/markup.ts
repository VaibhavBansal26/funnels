import { esc, formatMoney, parseVideoUrl, safeUrl } from '../../blocks/safe.js';
import type { CountdownProps, FormProps, ProductProps, ProgressProps, VideoProps } from './props.js';

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
}

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

export function publicEndpoint(ctx: MarkupCtx, kind: 'forms' | 'checkout', blockId: string): string {
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

export function checkoutInner(blockId: string, p: ProductProps, ctx: MarkupCtx): string {
  const bid = safeId(blockId);
  const money = esc(formatMoney(p.price, p.currency));
  const name = esc(p.productName);
  const desc = p.description ? `<p>${inline(p.description)}</p>` : '';
  const action = esc(publicEndpoint(ctx, 'checkout', bid));
  const test = '<p class="fn-note">Test mode: no real payment is taken.</p>';
  if (p.orderBump) {
    const form = ctx.mainCheckoutId ? ` form="co-${esc(ctx.mainCheckoutId)}"` : ' disabled';
    return `<label class="fn-bump"><input type="checkbox" name="bump" value="${esc(bid)}"${form}> <span><strong>Yes, add ${name} for ${money}</strong>${p.description ? `<br>${inline(p.description)}` : ''}</span></label>`;
  }
  if (p.oneClickUpsell) {
    const decline = ctx.mode === 'builder' ? '#' : ctx.nextHref;
    return `<div class="fn-offer" data-fn-upsell-box><h3>${name}</h3><p class="fn-price">${money}</p>${desc}<button type="button" class="fn-btn fn-btn-primary fn-btn-block" data-fn-upsell data-action="${action}"${successAttrs(ctx, p.success)}>${esc(p.buttonLabel || 'Yes, add to my order')}</button><p class="fn-status" role="status" aria-live="polite"></p><p class="fn-note"><a href="${esc(decline)}">No thanks</a></p>${test}</div>`;
  }
  return `<form class="fn-offer" id="co-${esc(bid)}" method="post" action="${action}" data-fn-checkout${successAttrs(ctx, p.success)}><h3>${name}</h3><p class="fn-price">${money}</p>${desc}<div class="fn-field"><label for="co-${esc(bid)}-email">Email<span class="fn-req" aria-hidden="true">*</span></label><input type="email" id="co-${esc(bid)}-email" name="email" autocomplete="email" maxlength="255" required aria-required="true"></div><div class="fn-field"><label for="co-${esc(bid)}-name">Name</label><input type="text" id="co-${esc(bid)}-name" name="name" autocomplete="name" maxlength="120"></div><div class="fn-hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="_hp" tabindex="-1" autocomplete="off"></label></div><button class="fn-btn fn-btn-primary fn-btn-block fn-btn-lg" type="submit">${esc(p.buttonLabel || 'Buy now')} · ${money}</button><p class="fn-status" role="status" aria-live="polite"></p>${test}</form>`;
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
