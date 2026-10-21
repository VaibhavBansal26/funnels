import { createHash } from 'node:crypto';
import { pagesHash } from './hash.js';

/**
 * Builds the static site of one funnel for Cloudflare Pages: pure and deterministic (the same input gives byte-identical files, the same manifest and the same
 * version id), with no clock, randomness or I/O, so it is testable without a network and a no-change save can be recognised by comparing version ids.
 *
 * Layout: every step is `<decoded path>/index.html` (`/` is `index.html`), the domain's 404 step is `404.html`, uploaded images the pages use are copied to
 * `uploads/<id>/<name>` (the HTML keeps pointing at the same URLs), the beacon is `_fn/beacon.<hash>.js`, and `_headers` / `_redirects` carry security headers, cache
 * rules and case redirects. Paths are validated segment by segment AFTER percent-decoding, because a stored path such as `/%2e%2e` is syntactically fine but would
 * climb out of the site when decoded.
 */
export class BundleError extends Error {
  constructor(public code: 'BAD_PATH' | 'PATH_COLLISION' | 'TOO_MANY_FILES' | 'FILE_TOO_LARGE' | 'NO_PAGES' | 'EMPTY', message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface VendorHosts {
  script: string[];
  connect: string[];
  img: string[];
  frame: string[];
}

export interface BundleStep {
  id: string;
  /** The step's stored path: `/promo`, `/`, `/Promo`, `/caf%C3%A9`. */
  basePath: string;
  /** The page, rendered for Pages (absolute API origin, beacon at `beaconPath(...)`). */
  html: string;
  /** Inline script texts the platform itself put in the page (pixel runtime, countdown runtime): hashed into the CSP. Any other inline script is the owner's. */
  knownInline: string[];
  /** Ad network hosts of the page's configured pixels. */
  vendors: VendorHosts;
}

export interface BundleAsset {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface BundleInput {
  steps: BundleStep[];
  /** The step served at `/` when no step has the path `/` (the domain's home step, if it belongs to this funnel). */
  homeStepId?: string | null;
  /** The step used as `404.html`. */
  notFoundStepId?: string | null;
  assets: Map<string, BundleAsset>;
  beaconJs: string;
  /** Origin of the app (`https://app.example.com`): forms, checkout and events call it, and the CSP lets pages connect to it. */
  apiOrigin: string;
  limits: { maxFiles: number; maxFileBytes: number };
}

export interface BundleFile {
  /** `/index.html`, `/promo/index.html`: the manifest key. */
  path: string;
  bytes: Uint8Array;
  contentType: string;
  /** Pages' asset hash (BLAKE3 of base64 + extension, 32 hex). */
  hash: string;
  sha256: string;
}

export interface Bundle {
  files: BundleFile[];
  manifest: Record<string, string>;
  headers: string;
  redirects: string;
  /** Twelve hex characters over the sorted files, headers and redirects: the version shown in the history. */
  versionId: string;
  bytes: number;
  warnings: string[];
}

const enc = new TextEncoder();
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const b64sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

export const beaconPath = (beaconJs: string): string => `/_fn/beacon.${sha256(beaconJs).slice(0, 10)}.js`;

const BAD_CHARS = /[\u0000-\u001f\u007f\\/%?#*:"<>|]/;

/** `/promo` -> `/promo/index.html`. Throws BundleError for anything that could leave the site or collide with the platform's own files. */
export function filePathFor(basePath: string): string {
  if (!basePath.startsWith('/')) throw new BundleError('BAD_PATH', `"${basePath}" is not an absolute path`);
  const trimmed = basePath.length > 1 && basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (trimmed === '/') return '/index.html';
  const segments = trimmed.slice(1).split('/');
  const out: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).normalize('NFC');
    } catch {
      throw new BundleError('BAD_PATH', `"${basePath}" is not valid percent-encoding`);
    }
    if (!seg || seg === '.' || seg === '..' || BAD_CHARS.test(seg) || seg.startsWith('_') || seg.startsWith('.') || seg.endsWith('.') || seg.trim() !== seg || [...seg].length > 100) {
      throw new BundleError('BAD_PATH', `The path "${basePath}" cannot be published as a file name`);
    }
    out.push(seg);
  }
  return `/${out.join('/')}/index.html`;
}

const ASSET_REF = /\/uploads\/([A-Za-z0-9_-]{4,64})(?:\/([^"'\s)<>?#\\]*))?/g;

/** Ids of uploaded images a page refers to. */
export function findAssetRefs(html: string): string[] {
  return [...new Set([...html.matchAll(ASSET_REF)].map((m) => m[1]!))];
}

const encodeSeg = (s: string) => encodeURIComponent(s);

function rewriteAssets(html: string, assets: Map<string, BundleAsset>): string {
  return html.replace(ASSET_REF, (whole, id: string) => {
    const a = assets.get(id);
    return a ? `/uploads/${id}/${encodeSeg(a.name)}` : whole;
  });
}

// ---- CSP ------------------------------------------------------------------------------------------------------------------------------------------------

interface ScriptReport {
  hashes: string[];
  /** The page has code the platform did not write (owner custom code, tracking snippets, event handler attributes): a hash list cannot describe it. */
  ownerCode: boolean;
}

function scriptsOf(html: string, known: Set<string>, vendorScriptHosts: Set<string>, selfOrigins: Set<string>): ScriptReport {
  const hashes = new Set<string>();
  let ownerCode = false;
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1] ?? '');
    if (src) {
      const url = src[1] ?? src[2] ?? src[3] ?? '';
      if (url.startsWith('/') && !url.startsWith('//')) continue;
      try {
        const u = new URL(url, 'https://x.invalid');
        if (selfOrigins.has(u.origin) || vendorScriptHosts.has(u.origin)) continue;
      } catch {
        /* unparsable: treated as owner code */
      }
      ownerCode = true;
      continue;
    }
    const text = m[2] ?? '';
    if (/\btype\s*=\s*["']?(application\/(ld\+)?json|importmap)/i.test(m[1] ?? '')) continue; // data blocks do not execute
    if (known.has(text)) hashes.add(`'sha256-${b64sha(text)}'`);
    else ownerCode = true;
  }
  if (/<[a-z][^>]*\s(on[a-z]{3,})\s*=/i.test(html) || /\bhref\s*=\s*["']\s*javascript:/i.test(html)) ownerCode = true;
  return { hashes: [...hashes].sort(), ownerCode };
}

export function cspFor(step: BundleStep, apiOrigin: string, beaconOrigins: Set<string>): { policy: string; relaxed: boolean } {
  const vendorScript = new Set(step.vendors.script);
  const report = scriptsOf(step.html, new Set(step.knownInline), vendorScript, beaconOrigins);
  const relaxed = report.ownerCode;
  const script = relaxed ? ["'self'", "'unsafe-inline'", 'https:'] : ["'self'", ...report.hashes, ...[...vendorScript].sort()];
  const connect = ["'self'", apiOrigin, ...step.vendors.connect];
  const img = ["'self'", 'data:', 'https:', ...step.vendors.img];
  const policy = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // Pages are styled by one inline <style> element (and the page builder's own style attributes), so styles need 'unsafe-inline'; fonts come from Google Fonts when a page asks.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `img-src ${[...new Set(img)].join(' ')}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' https:",
    `frame-src https: ${step.vendors.frame.join(' ')}`.trim(),
    `connect-src ${[...new Set(connect)].join(' ')}`,
    `form-action 'self' ${apiOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
  return { policy, relaxed };
}

// ---- the bundle -----------------------------------------------------------------------------------------------------------------------------------------

const contentTypeOf = (path: string, mime?: string) => mime ?? (path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream');
/** Pages allows 100 rules in `_headers`. Three are fixed; one per page keeps the CSP exact. */
const MAX_HEADER_RULES = 100;

const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1f2937;background:#f9fafb}main{text-align:center;padding:24px}h1{font-size:1.6rem;margin:0 0 8px}p{color:#6b7280;margin:0}</style></head><body><main><h1>Page not found</h1><p>The page you are looking for does not exist.</p></main></body></html>';

export function buildBundle(input: BundleInput): Bundle {
  const warnings: string[] = [];
  if (!input.steps.length) throw new BundleError('NO_PAGES', 'The funnel has no pages to publish');
  const apiOrigin = input.apiOrigin.replace(/\/$/, '');
  const beaconFile = beaconPath(input.beaconJs);
  const byPath = new Map<string, { id: string; html: string; step: BundleStep }>();
  const seenKeys = new Map<string, string>();
  const redirects: string[] = [];
  for (const s of input.steps) {
    const file = filePathFor(s.basePath);
    const key = file.normalize('NFC').toLowerCase();
    if (byPath.has(file) || seenKeys.has(key)) throw new BundleError('PATH_COLLISION', `Two pages would be published at ${file.replace(/\/index\.html$/, '') || '/'}`);
    seenKeys.set(key, s.id);
    byPath.set(file, { id: s.id, html: s.html, step: s });
    // Stored paths keep their case; the lower-case form redirects to it (the app answers the same way on its own domains).
    const visible = s.basePath.length > 1 && s.basePath.endsWith('/') ? s.basePath.slice(0, -1) : s.basePath;
    if (visible !== '/' && visible !== visible.toLowerCase()) redirects.push(`${visible.toLowerCase()} ${visible}/ 301`);
  }
  if (!byPath.has('/index.html') && input.homeStepId) {
    const home = input.steps.find((s) => s.id === input.homeStepId);
    if (home) byPath.set('/index.html', { id: home.id, html: home.html, step: home });
  }
  let notFound = input.steps.find((s) => s.id === input.notFoundStepId);
  const files: BundleFile[] = [];
  const add = (path: string, bytes: Uint8Array, mime?: string) => {
    if (bytes.length > input.limits.maxFileBytes) throw new BundleError('FILE_TOO_LARGE', `${path} is ${(bytes.length / 1_048_576).toFixed(1)} MB; Cloudflare Pages accepts files up to ${(input.limits.maxFileBytes / 1_048_576).toFixed(0)} MB`);
    files.push({ path, bytes, contentType: contentTypeOf(path, mime), hash: pagesHash(bytes, path), sha256: sha256(bytes) });
  };

  const used = new Map<string, BundleAsset>();
  const pages: { file: string; step: BundleStep; html: string }[] = [];
  for (const [file, p] of [...byPath.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const html = rewriteAssets(p.html, input.assets);
    for (const id of findAssetRefs(html)) {
      const a = input.assets.get(id);
      if (a) used.set(id, a);
      else warnings.push(`A page refers to an uploaded image (${id}) that no longer exists`);
    }
    pages.push({ file, step: p.step, html });
    add(file, enc.encode(html));
  }
  add('/404.html', enc.encode(notFound ? rewriteAssets(notFound.html, input.assets) : NOT_FOUND_HTML));
  if (notFound) for (const id of findAssetRefs(notFound.html)) { const a = input.assets.get(id); if (a) used.set(id, a); }
  for (const [id, a] of [...used.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) add(`/uploads/${id}/${a.name}`, a.bytes, a.mime);
  add(beaconFile, enc.encode(input.beaconJs));

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length > input.limits.maxFiles) throw new BundleError('TOO_MANY_FILES', `The site has ${files.length} files; the limit is ${input.limits.maxFiles}`);

  // headers
  const self = new Set<string>([apiOrigin]);
  const rules: string[] = ['/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()'];
  const perPage = pages.length + 3 <= MAX_HEADER_RULES;
  const cacheHtml = 'public, max-age=60, stale-while-revalidate=300';
  if (perPage) {
    rules.push('/_fn/*', '  Cache-Control: public, max-age=31536000, immutable', '/uploads/*', '  Cache-Control: public, max-age=31536000, immutable');
    for (const p of pages) {
      const route = p.file === '/index.html' ? '/' : p.file.replace(/index\.html$/, '');
      const { policy } = cspFor(p.step, apiOrigin, self);
      rules.push(route, `  Content-Security-Policy: ${policy}`, `  Cache-Control: ${cacheHtml}`);
    }
  } else {
    warnings.push(`The funnel has ${pages.length} pages: more than ${MAX_HEADER_RULES - 3} rules do not fit in Pages' _headers (limit ${MAX_HEADER_RULES}), so one relaxed policy covers all pages and assets use Pages' default caching`);
    rules.push('  Content-Security-Policy: ' + cspFor({ ...pages[0]!.step, html: '<script>x</script>' }, apiOrigin, self).policy, `  Cache-Control: ${cacheHtml}`);
  }
  const headers = rules.join('\n') + '\n';
  const redirectsText = [...new Set(redirects)].sort().join('\n') + (redirects.length ? '\n' : '');

  const manifest: Record<string, string> = {};
  for (const f of files) manifest[f.path] = f.hash;
  const versionId = sha256(JSON.stringify([files.map((f) => [f.path, f.sha256]), headers, redirectsText])).slice(0, 12);
  return { files, manifest, headers, redirects: redirectsText, versionId, bytes: files.reduce((n, f) => n + f.bytes.length, 0), warnings };
}

/** What a paused or unpublished site shows: one page for every path, no scripts, not indexed. */
export function buildPausedBundle(message = 'This page is not available right now.'): Bundle {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Not available</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1f2937;background:#f9fafb}main{text-align:center;padding:24px}h1{font-size:1.6rem;margin:0 0 8px}p{color:#6b7280;margin:0}</style></head><body><main><h1>Not available</h1><p>${message.replace(/[<>&"]/g, '')}</p></main></body></html>`;
  const bytes = enc.encode(html);
  const files: BundleFile[] = ['/404.html', '/index.html'].map((path) => ({ path, bytes, contentType: 'text/html; charset=utf-8', hash: pagesHash(bytes, path), sha256: sha256(bytes) }));
  const headers = "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'\n";
  const manifest = Object.fromEntries(files.map((f) => [f.path, f.hash]));
  return { files, manifest, headers, redirects: '', versionId: sha256(JSON.stringify([files.map((f) => [f.path, f.sha256]), headers])).slice(0, 12), bytes: bytes.length * 2, warnings: [] };
}
