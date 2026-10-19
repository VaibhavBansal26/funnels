/** Escaping and allow-list helpers shared by the schema, the sanitiser and the renderer. Pure, no Node imports. */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

export const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|(rgb|hsl)a?\([0-9.,%\s/]{3,40}\))$/;

export function safeColor(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim() : fallback;
}

const LINK_PROTOCOLS = ['http', 'https', 'mailto', 'tel'];

/**
 * Returns the URL when it is a same-page anchor, an absolute-path URL or an absolute URL with an
 * allowed protocol; otherwise null. Control characters and whitespace anywhere reject the value so
 * tricks such as "java\tscript:" never reach an attribute.
 */
export function safeUrl(input: unknown, protocols: string[] = LINK_PROTOCOLS): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 2048) return null;
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return null;
  if (s.startsWith('#')) return s;
  if (s.startsWith('/')) return s.startsWith('//') || s.startsWith('/\\') ? null : s;
  try {
    const u = new URL(s);
    return protocols.includes(u.protocol.slice(0, -1)) ? s : null;
  } catch {
    return null;
  }
}

export const MAX_DATA_IMAGE = 400_000;

export function safeImageSrc(input: unknown): string | null {
  if (typeof input === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(input)) {
    return input.length <= MAX_DATA_IMAGE ? input : null;
  }
  return safeUrl(input, ['http', 'https']);
}

export interface VideoEmbed {
  kind: 'youtube' | 'vimeo' | 'mp4';
  src: string;
}

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

/** Allow-list for video sources: YouTube, Vimeo and direct https .mp4 files. */
export function parseVideoUrl(input: unknown): VideoEmbed | null {
  const s = safeUrl(input, ['https']);
  if (!s || !s.startsWith('https://')) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const ytId = (v: string | null | undefined) => (v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null);
  let id: string | null = null;
  if (host === 'youtu.be') id = ytId(u.pathname.slice(1));
  else if (YT_HOSTS.has(host)) {
    if (u.pathname === '/watch') id = ytId(u.searchParams.get('v'));
    else {
      const m = /^\/(embed|shorts)\/([^/]+)$/.exec(u.pathname);
      if (m) id = ytId(m[2]);
    }
  }
  if (id) return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` };
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const m = /^(?:\/video)?\/(\d{6,12})$/.exec(u.pathname);
    if (m) return { kind: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}` };
    return null;
  }
  if (u.pathname.toLowerCase().endsWith('.mp4')) return { kind: 'mp4', src: s };
  return null;
}

export function formatMoney(amount: number, currency: string): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const cur = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
}
