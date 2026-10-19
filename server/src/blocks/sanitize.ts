import { esc, safeUrl } from './safe.js';

/**
 * Allow-list HTML sanitiser for the "custom HTML" block. It tokenises the input and re-emits only
 * known tags with known attributes, so malformed markup can never be re-interpreted by a browser:
 * anything that does not tokenise as a well-formed tag is emitted as escaped text.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'div', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'mark', 'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'details', 'summary', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'center', 'font',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
// Elements whose entire content is dropped, not just the tag.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'noscript', 'template', 'svg', 'math', 'title', 'textarea', 'xmp', 'noembed', 'noframes', 'plaintext']);
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir', 'role', 'style']);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel', 'name']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  font: new Set(['color', 'size']),
};
const URL_ATTRS = new Set(['href', 'src']);

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Inline style values are kept only when they contain nothing that can execute or fetch. */
function safeStyle(value: string): string | null {
  const v = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/(expression|url\s*\(|@import|javascript:|behavior|binding|-moz-binding|\\)/i.test(v)) return null;
  if (!/^[\w\s#%.,:;()!\-/"']*$/.test(v)) return null;
  return v.trim();
}

function renderAttrs(tag: string, raw: string): string {
  let out = '';
  const allowed = TAG_ATTRS[tag];
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on')) continue;
    if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name) && !name.startsWith('aria-') && !/^data-[a-z0-9-]+$/.test(name)) continue;
    if (URL_ATTRS.has(name)) {
      const url = safeUrl(decodeEntities(value), tag === 'img' ? ['http', 'https'] : undefined);
      if (!url) continue;
      out += ` ${name}="${esc(url)}"`;
    } else if (name === 'style') {
      const s = safeStyle(decodeEntities(value));
      if (s) out += ` style="${esc(s)}"`;
    } else if (name === 'target') {
      out += value === '_blank' ? ' target="_blank"' : '';
    } else {
      out += ` ${name}="${esc(value)}"`;
    }
  }
  if (tag === 'a' && /target="_blank"/.test(out)) out += ' rel="noopener noreferrer"';
  return out;
}

/** Only the numeric and a few named entities matter for URL/style checks. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&(colon|tab|newline|lpar|rpar);/gi, (_, n: string) => ({ colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')' })[n.toLowerCase()]!)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export interface SanitizeOptions {
  /** Owner-only escape hatch: when true the HTML is passed through untouched. */
  allowScripts?: boolean;
  maxLength?: number;
}

export function sanitizeHtml(input: string, opts: SanitizeOptions = {}): string {
  const html = String(input ?? '').slice(0, opts.maxLength ?? 50_000);
  if (opts.allowScripts) return html;
  let out = '';
  let i = 0;
  const open: string[] = [];
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += esc(html.slice(i)).replace(/&amp;(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, '&$1;');
      break;
    }
    if (lt > i) out += esc(html.slice(i, lt)).replace(/&amp;(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, '&$1;');
    const rest = html.slice(lt);
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      i = end === -1 ? html.length : lt + end + 3;
      continue;
    }
    const m = TAG_RE.exec(rest);
    if (!m) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing) {
        const re = new RegExp(`</${tag}\\s*>`, 'i');
        const after = re.exec(html.slice(i));
        i = after ? i + after.index + after[0].length : html.length;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) continue; // unknown or void-dropped (embed, input, ...) tags vanish, their text stays
    if (closing) {
      const idx = open.lastIndexOf(tag);
      if (idx !== -1) {
        // Close any tags left open inside, keeping the output well nested.
        while (open.length > idx) out += `</${open.pop()}>`;
      }
      continue;
    }
    out += `<${tag}${renderAttrs(tag, m[3] ?? '')}${VOID_TAGS.has(tag) ? ' /' : ''}>`;
    if (!VOID_TAGS.has(tag) && !m[4]) open.push(tag);
    else if (!VOID_TAGS.has(tag) && m[4]) out += `</${tag}>`;
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}
