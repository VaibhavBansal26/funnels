/**
 * Allow-list filtering of style declarations. Project styles arrive as structured `{property: value}` maps, so there is no CSS text to
 * parse: every property must be a known one and every value must be free of anything that can execute, fetch from an unexpected place
 * or break out of the declaration. Pure (no Node imports): shared by the editor (pre-save validation) and the server (save and render).
 */
export const ALLOWED_PROPS = new Set(
  (
    'align-content align-items align-self aspect-ratio background background-attachment background-blend-mode background-clip background-color background-image background-origin background-position background-position-x background-position-y background-repeat background-size ' +
    'border border-bottom border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style border-bottom-width border-collapse border-color border-left border-left-color border-left-style border-left-width border-radius border-right border-right-color border-right-style border-right-width border-spacing border-style border-top border-top-color border-top-left-radius border-top-right-radius border-top-style border-top-width border-width ' +
    'bottom box-shadow box-sizing clear color column-gap columns cursor display filter flex flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float font font-family font-size font-style font-variant font-weight gap grid grid-area grid-auto-columns grid-auto-flow grid-auto-rows grid-column grid-column-end grid-column-start grid-gap grid-row grid-row-end grid-row-start grid-template grid-template-areas grid-template-columns grid-template-rows ' +
    'height inset justify-content justify-items justify-self left letter-spacing line-height list-style list-style-position list-style-type margin margin-bottom margin-left margin-right margin-top max-height max-width min-height min-width object-fit object-position opacity order outline outline-color outline-offset outline-style outline-width overflow overflow-x overflow-y overflow-wrap ' +
    'padding padding-bottom padding-left padding-right padding-top place-content place-items place-self pointer-events position resize right row-gap scroll-margin-top text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-overflow text-shadow text-transform top transform transform-origin transition transition-delay transition-duration transition-property transition-timing-function ' +
    'vertical-align visibility white-space width word-break word-spacing z-index backdrop-filter mix-blend-mode user-select fill stroke'
  ).split(' '),
);

const CUSTOM_PROP = /^--fn-[a-z0-9-]{1,40}$/;
export const MAX_DATA_IMAGE_BYTES = 400_000;

const FORBIDDEN = /(expression\s*\(|javascript:|vbscript:|livescript:|-moz-binding|behavior\s*:|@import|<|>|\{|\}|;|\\|\/\*|\*\/|\bimage-set\s*\(|\bsrc\s*\(|attr\s*\()/i;

/** A url() argument that is allowed: https/http, same-site absolute path, or a base64 raster data URI. */
function urlAllowed(raw: string): boolean {
  const u = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!u || u.length > 2048 + MAX_DATA_IMAGE_BYTES) return false;
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) return u.length <= MAX_DATA_IMAGE_BYTES;
  if (/[\s\u0000-\u001f\u007f-\u009f"'()]/.test(u)) return false;
  if (u.startsWith('/')) return !u.startsWith('//');
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Returns the trimmed value when it is safe, else null. */
export function safeCssValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const v = String(value).trim();
  if (v.length === 0 || v.length > 600 + MAX_DATA_IMAGE_BYTES) return null;
  // data: URIs inside url() are checked separately below, so remove them from the generic scan first.
  const urls = [...v.matchAll(/url\(\s*((?:"[^"]*")|(?:'[^']*')|[^)]*)\s*\)/gi)];
  for (const m of urls) if (!urlAllowed(m[1]!)) return null;
  const withoutUrls = v.replace(/url\(\s*((?:"[^"]*")|(?:'[^']*')|[^)]*)\s*\)/gi, 'url()');
  if (withoutUrls.length > 600) return null;
  if (/url\s*\(/i.test(withoutUrls.replace(/url\(\)/g, ''))) return null;
  if (FORBIDDEN.test(withoutUrls)) return null;
  // Balanced parentheses and quotes keep a value from swallowing the next declaration.
  let depth = 0;
  for (const ch of withoutUrls) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  if (((withoutUrls.match(/"/g) ?? []).length % 2) !== 0 || ((withoutUrls.match(/'/g) ?? []).length % 2) !== 0) return null;
  return v;
}

export function safeProperty(prop: unknown): string | null {
  if (typeof prop !== 'string') return null;
  const p = prop.trim().toLowerCase();
  return ALLOWED_PROPS.has(p) || CUSTOM_PROP.test(p) ? p : null;
}

export function cleanDeclarations(style: unknown, maxDecls = 120): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof style !== 'object' || style === null || Array.isArray(style)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(style as Record<string, unknown>)) {
    if (++n > maxDecls) break;
    const prop = safeProperty(k);
    const val = prop ? safeCssValue(v) : null;
    if (prop && val !== null) out[prop] = val;
  }
  return out;
}

const STATES = new Set(['hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited', 'disabled', 'first-child', 'last-child', 'nth-child(odd)', 'nth-child(even)', 'before', 'after', 'placeholder']);
export const isAllowedState = (s: unknown): s is string => typeof s === 'string' && STATES.has(s);

/** Media conditions the style manager produces, e.g. "(max-width: 992px)". */
export function safeMediaText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length > 160) return null;
  return /^(?:(?:\(\s*(?:max|min)-(?:width|height)\s*:\s*\d{1,5}(?:\.\d+)?(?:px|em|rem)\s*\)|\(\s*orientation\s*:\s*(?:portrait|landscape)\s*\)|\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)|screen|print)(?:\s+and\s+)?)+$/i.test(t) ? t : null;
}

/** A complex "selectorsAdd" selector written by a user in the selector manager. Strict: no braces, escapes, at-rules or comments. */
export function safeSelectorAdd(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 200) return null;
  return /^[A-Za-z0-9_\-\s.#:>+~*,()[\]="'^$|]+$/.test(t) && !/javascript|expression|url\s*\(/i.test(t) ? t : null;
}

export const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
