import sanitizeHtmlLib, { type IOptions } from 'sanitize-html';

/**
 * Server-side HTML allow-list sanitisers (sanitize-html, htmlparser2 based). Two profiles:
 *
 *  - `sanitizeUserHtml`: for free-form markup written by an author (custom code blocks of users who may not run scripts, text content).
 *    No forms, inputs, iframes, scripts, styles, svg, event handlers, javascript:/data: links; images may be http(s) or data: rasters.
 *  - `sanitizePageBody`: the last pass over the whole rendered page body. The renderer only emits allow-listed tags, but this pass is
 *    the safety net that makes "the stored page contains no script and no handler" true even if the renderer had a bug. It additionally
 *    permits the markup the renderer itself generates (forms posting to /api/public, allow-listed video embeds, inputs).
 */
const COMMON_TAGS = [
  'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'img', 'button',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup', 'br', 'hr', 'blockquote', 'pre', 'code', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'td', 'th', 'caption', 'details', 'summary', 'label', 'abbr', 'q', 'cite', 'time', 'center', 'font',
];

const GLOBAL_ATTRS = ['id', 'class', 'title', 'lang', 'dir', 'role', 'hidden', 'aria-*', 'data-*'];
const BASE_ATTRS: IOptions['allowedAttributes'] = {
  '*': GLOBAL_ATTRS,
  a: ['href', 'target', 'rel', 'name'],
  img: ['src', 'alt', 'width', 'height', 'loading'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  time: ['datetime'],
  font: ['color', 'size'],
  details: ['open'],
  button: ['type'],
  label: ['for'],
};

function fixAnchors(tagName: string, attribs: Record<string, string>) {
  const out = { ...attribs };
  if (tagName === 'a') {
    if (out.target && out.target !== '_blank' && out.target !== '_self') delete out.target;
    if (out.target === '_blank') {
      const rel = new Set((out.rel ?? '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      out.rel = [...rel].join(' ');
    }
  }
  return { tagName, attribs: out };
}

const USER: IOptions = {
  allowedTags: COMMON_TAGS,
  allowedAttributes: BASE_ATTRS,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'title', 'xmp', 'noembed', 'noframes', 'plaintext'],
  transformTags: { '*': fixAnchors },
};

/** Only `data:` images that are base64 rasters (no svg) survive. */
const DATA_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
function dropBadImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\ssrc="([^"]*)"/i.exec(tag);
    if (m && /^\s*data:/i.test(m[1]!) && !DATA_IMG.test(m[1]!.replace(/&#43;/g, '+').replace(/&#x2B;/gi, '+'))) return '';
    return tag;
  });
}

export function sanitizeUserHtml(input: string, maxLength = 50_000): string {
  return dropBadImages(sanitizeHtmlLib(String(input ?? '').slice(0, maxLength), USER));
}

const VIDEO_HOSTS = ['www.youtube-nocookie.com', 'player.vimeo.com'];

export function sanitizePageBody(html: string, opts: { apiBase?: string } = {}): string {
  const apiBase = (opts.apiBase ?? '').replace(/\/+$/, '');
  const options: IOptions = {
    ...USER,
    allowedTags: [...COMMON_TAGS, 'form', 'input', 'textarea', 'select', 'option', 'iframe', 'video'],
    allowedAttributes: {
      ...BASE_ATTRS,
      form: ['action', 'method', 'class', 'id', 'aria-label'],
      input: ['type', 'name', 'id', 'autocomplete', 'placeholder', 'maxlength', 'required', 'value', 'tabindex', 'form', 'disabled', 'class'],
      textarea: ['name', 'id', 'rows', 'placeholder', 'maxlength', 'required'],
      select: ['name', 'id', 'required'],
      option: ['value'],
      button: ['type', 'disabled'],
      iframe: ['src', 'title', 'loading', 'allow', 'allowfullscreen', 'referrerpolicy'],
      video: ['controls', 'preload', 'src', 'aria-label'],
      // `style` survives only as width:N% (the progress bar), see allowedStyles below.
      '*': [...GLOBAL_ATTRS, 'style'],
    },
    allowedIframeHostnames: VIDEO_HOSTS,
    allowedIframeDomains: [],
    allowIframeRelativeUrls: false,
    allowedStyles: { '*': { width: [/^\d{1,3}%$/] } },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'action'],
    nonTextTags: ['script', 'style', 'noscript', 'template', 'svg', 'math', 'object', 'embed', 'title', 'xmp', 'noembed', 'noframes', 'plaintext'],
    transformTags: {
      '*': fixAnchors,
      form: (tagName, attribs) => {
        const action = attribs.action ?? '';
        const ok = action.startsWith('/api/public/') || (apiBase && action.startsWith(`${apiBase}/api/public/`));
        return { tagName, attribs: { ...attribs, method: 'post', action: ok ? action : '/api/public/forms/invalid' } };
      },
      video: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: /^https:\/\/[^\s"'<>]+\.mp4(\?[^\s"'<>]*)?$/i.test(attribs.src ?? '') ? attribs.src! : '' } }),
      input: (tagName, attribs) => ({ tagName, attribs: /^(text|email|tel|checkbox)$/.test(attribs.type ?? 'text') ? attribs : { ...attribs, type: 'text' } }),
    },
    exclusiveFilter: (frame) => (frame.tag === 'video' || frame.tag === 'iframe') && !frame.attribs.src,
  };
  return dropBadImages(sanitizeHtmlLib(html, options));
}
