// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildBundle, buildPausedBundle, BundleError, beaconPath, cspFor, filePathFor, findAssetRefs, type BundleInput, type BundleStep } from '../src/publish/bundle.js';
import { pagesHash } from '../src/publish/hash.js';
import { batches } from '../src/publish/cfclient.js';
import { RUNTIME_JS } from '../src/pagemodel/render.js';

const BEACON = '/*beacon*/(function(){})();';
const API = 'https://app.example.com';
const NO_VENDORS = { script: [], connect: [], img: [], frame: [] };
const page = (title: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body><main>${title}</main>${extra}<script async src="${beaconPath(BEACON)}" data-funnel="f" data-step="s" data-api="${API}"></script></body></html>`;
const step = (id: string, basePath: string, html = page(id), extra: Partial<BundleStep> = {}): BundleStep => ({ id, basePath, html, knownInline: [], vendors: NO_VENDORS, ...extra });
const input = (steps: BundleStep[], extra: Partial<BundleInput> = {}): BundleInput => ({ steps, assets: new Map(), beaconJs: BEACON, apiOrigin: API, limits: { maxFiles: 20_000, maxFileBytes: 25 * 1024 * 1024 }, ...extra });

describe('Pages asset hash', () => {
  it('is blake3 of base64(content) + extension, first 32 hex characters', () => {
    expect(pagesHash(Buffer.from('hello'), '/a/index.html')).toBe('a2b82584e50075886b08927390f2f573');
    expect(pagesHash(Buffer.from('hello'), '/a/readme')).toBe('324ea05bea4d7f75b8d9ed695e65b2ca'); // no extension
    expect(pagesHash(Buffer.from('hello'), '/v1.2/readme')).toBe('324ea05bea4d7f75b8d9ed695e65b2ca'); // a dot in a directory is not an extension
    expect(pagesHash(new Uint8Array(0), '/x')).toBe('af1349b9f5f9a1a6a0404dea36dcc949'); // BLAKE3 of the empty string, shortened
    expect(pagesHash(Buffer.from('hello'), '/a.html')).toHaveLength(32);
  });
});

describe('file paths', () => {
  it.each([
    ['/', '/index.html'], ['/promo', '/promo/index.html'], ['/promo/', '/promo/index.html'], ['/Promo', '/Promo/index.html'], ['/caf%C3%A9', '/café/index.html'], ['/a-b-1', '/a-b-1/index.html'],
    ['/cafe%CC%81', '/café/index.html'], // NFD input is stored as NFC
  ])('%s -> %s', (p, want) => expect(filePathFor(p)).toBe(want));

  it.each(['/%2e%2e', '/%2E%2E', '/%2e', '/a%2fb', '/a%5cb', '/%00', '/%0a', '/%5f', '/_fn', '/%2e%2e%2f%2e%2e', '/a%3fb', '/x%25y', '/%E0%A4%A', 'no-slash', '/ok%20', '/.hidden', '/%2ehidden', '/a%3A', '/' + 'a'.repeat(101)])(
    'refuses %j',
    (p) => expect(() => filePathFor(p)).toThrow(BundleError),
  );

  it('whatever the stored path, the published path never leaves the site', () => {
    for (const p of ['/%2e%2e', '/..%2f', '/%2e%2e%5c', '/a%2f..%2fb']) {
      try {
        const out = filePathFor(p);
        expect(out.split('/')).not.toContain('..');
      } catch (e) {
        expect(e).toBeInstanceOf(BundleError);
      }
    }
  });
});

describe('bundle', () => {
  const steps = [step('s1', '/'), step('s2', '/offer'), step('s3', '/thanks')];

  it('lays out pages, 404, beacon and config files', () => {
    const b = buildBundle(input(steps));
    expect(b.files.map((f) => f.path)).toEqual(['/404.html', '/_fn/beacon.' + beaconPath(BEACON).split('.')[1] + '.js', '/index.html', '/offer/index.html', '/thanks/index.html'].sort());
    expect(Object.keys(b.manifest)).toEqual(b.files.map((f) => f.path));
    for (const f of b.files) expect(b.manifest[f.path]).toBe(pagesHash(f.bytes, f.path));
    expect(b.headers).toContain('/_fn/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(b.headers).toContain('/offer/\n  Content-Security-Policy:');
    expect(b.headers.match(/^\/\*$/gm)).toHaveLength(1);
    expect(b.redirects).toBe('');
    expect(b.versionId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic: same input, same bytes, hashes and version; order of the input does not matter', () => {
    const a = buildBundle(input(steps));
    const b = buildBundle(input([...steps].reverse()));
    expect(b.manifest).toEqual(a.manifest);
    expect(b.versionId).toBe(a.versionId);
    expect(b.headers).toBe(a.headers);
    expect(JSON.stringify(Object.keys(a.manifest))).toBe(JSON.stringify([...Object.keys(a.manifest)].sort()));
  });

  it('a change in one page changes only that file hash and the version', () => {
    const a = buildBundle(input(steps));
    const b = buildBundle(input([step('s1', '/'), step('s2', '/offer', page('changed')), step('s3', '/thanks')]));
    const changed = Object.keys(a.manifest).filter((k) => a.manifest[k] !== b.manifest[k]);
    expect(changed).toEqual(['/offer/index.html']);
    expect(b.versionId).not.toBe(a.versionId);
  });

  it('serves the domain home step at / when no step has that path, and uses the 404 step', () => {
    const b = buildBundle(input([step('home', '/welcome', page('Welcome')), step('nf', '/missing', page('Gone'))], { homeStepId: 'home', notFoundStepId: 'nf' }));
    const text = (p: string) => Buffer.from(b.files.find((f) => f.path === p)!.bytes).toString();
    expect(text('/index.html')).toContain('Welcome');
    expect(text('/welcome/index.html')).toContain('Welcome');
    expect(text('/404.html')).toContain('Gone');
    const plain = buildBundle(input(steps));
    expect(Buffer.from(plain.files.find((f) => f.path === '/404.html')!.bytes).toString()).toContain('Page not found');
  });

  it('a step at / wins over the home setting', () => {
    const b = buildBundle(input([step('a', '/', page('Root')), step('b', '/x', page('X'))], { homeStepId: 'b' }));
    expect(Buffer.from(b.files.find((f) => f.path === '/index.html')!.bytes).toString()).toContain('Root');
  });

  it('keeps the stored case and redirects the lower-case form', () => {
    const b = buildBundle(input([step('a', '/Black-Friday')]));
    expect(b.files.some((f) => f.path === '/Black-Friday/index.html')).toBe(true);
    expect(b.redirects).toBe('/black-friday /Black-Friday/ 301\n');
    expect(buildBundle(input([step('a', '/black-friday')])).redirects).toBe('');
  });

  it('unicode paths become unicode file names', () => {
    const b = buildBundle(input([step('a', '/%E3%82%B5%E3%83%B3%E3%83%97%E3%83%AB'), step('b', '/caf%C3%A9')]));
    expect(Object.keys(b.manifest)).toContain('/サンプル/index.html');
    expect(Object.keys(b.manifest)).toContain('/café/index.html');
  });

  it('refuses collisions, including case-folded and normalisation twins', () => {
    expect(() => buildBundle(input([step('a', '/Same'), step('b', '/same')]))).toThrow(/Two pages/);
    expect(() => buildBundle(input([step('a', '/caf%C3%A9'), step('b', '/cafe%CC%81')]))).toThrow(BundleError);
    expect(() => buildBundle(input([step('a', '/x'), step('b', '/x/')]))).toThrow(BundleError);
  });

  it('refuses unsafe paths and an empty funnel', () => {
    expect(() => buildBundle(input([step('a', '/%2e%2e')]))).toThrow(BundleError);
    expect(() => buildBundle(input([]))).toThrow(/no pages/);
  });

  it('copies the uploaded images a page uses and rewrites their URLs; a missing image is a warning', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const html = page('A', '<img src="/uploads/ast_abc123/logo.png"><img src="/uploads/ast_abc123"><div style="background:url(/uploads/ast_gone99/x.png)"></div>');
    expect(findAssetRefs(html).sort()).toEqual(['ast_abc123', 'ast_gone99']);
    const b = buildBundle(input([step('a', '/', html)], { assets: new Map([['ast_abc123', { name: 'logo.png', mime: 'image/png', bytes: png }]]) }));
    const out = Buffer.from(b.files.find((f) => f.path === '/index.html')!.bytes).toString();
    expect(out).toContain('src="/uploads/ast_abc123/logo.png"');
    expect(out.match(/\/uploads\/ast_abc123\/logo\.png/g)).toHaveLength(2);
    expect(b.files.find((f) => f.path === '/uploads/ast_abc123/logo.png')).toMatchObject({ contentType: 'image/png' });
    expect(b.warnings.join()).toContain('ast_gone99');
    expect(b.headers).toContain('/uploads/*\n  Cache-Control: public, max-age=31536000, immutable');
  });

  it('enforces file count and size limits with readable errors', () => {
    expect(() => buildBundle(input(steps, { limits: { maxFiles: 3, maxFileBytes: 1e9 } }))).toThrow(/limit is 3/);
    const big = page('big', 'x'.repeat(2_000_000));
    expect(() => buildBundle(input([step('a', '/', big)], { limits: { maxFiles: 100, maxFileBytes: 1_000_000 } }))).toThrow(/index\.html is 1\.9 MB/);
  });

  it('a large funnel still builds: 300 pages fall back to one rule set, with a warning', () => {
    const many = Array.from({ length: 300 }, (_, i) => step(`s${i}`, `/page-${i}`));
    const b = buildBundle(input(many));
    expect(b.files).toHaveLength(300 + 2); // pages, 404.html, the beacon
    expect(b.warnings.join()).toContain('_headers');
    expect(b.headers.split('\n').filter((l) => l.startsWith('/')).length).toBeLessThanOrEqual(100);
  });

  it('1,000 pages build quickly and deterministically', () => {
    const many = Array.from({ length: 1000 }, (_, i) => step(`s${i}`, `/p${i}`, page(`Page ${i}`, '<p>' + 'lorem '.repeat(200) + '</p>')));
    const t = Date.now();
    const a = buildBundle(input(many));
    expect(Date.now() - t).toBeLessThan(5000);
    expect(buildBundle(input(many)).versionId).toBe(a.versionId);
  });

  it('a paused bundle has one page for every path, no scripts and no indexing', () => {
    const b = buildPausedBundle('Back soon <b>');
    expect(b.files.map((f) => f.path)).toEqual(['/404.html', '/index.html']);
    const html = Buffer.from(b.files[0]!.bytes).toString();
    expect(html).toContain('noindex');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(b.headers).toContain("default-src 'none'");
    expect(b.versionId).toBe(buildPausedBundle('Back soon <b>').versionId);
  });
});

describe('Content-Security-Policy per page', () => {
  const origins = new Set<string>([API]);
  it('a page with only the platform\'s own scripts gets a strict, hash-based policy', () => {
    const ads = '<script>/*ads runtime*/window.x=1</script>';
    const s = step('a', '/', page('A', `<script>${RUNTIME_JS}</script>${ads}`), { knownInline: [RUNTIME_JS, '/*ads runtime*/window.x=1'], vendors: { script: ['https://connect.facebook.net'], connect: ['https://www.facebook.com'], img: ['https://www.facebook.com'], frame: [] } });
    const { policy, relaxed } = cspFor(s, API, origins);
    expect(relaxed).toBe(false);
    expect(policy).toContain("script-src 'self' 'sha256-");
    expect(policy.match(/'sha256-/g)).toHaveLength(2);
    expect(policy).toContain('https://connect.facebook.net');
    expect(policy).toContain(`connect-src 'self' ${API} https://www.facebook.com`);
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", 'upgrade-insecure-requests', `form-action 'self' ${API}`]) expect(policy).toContain(d);
  });
  it('owner code (inline script, external script, event handler, javascript: link) relaxes the script policy', () => {
    for (const extra of ['<script>alert(1)</script>', '<script src="https://cdn.other.example/x.js"></script>', '<button onclick="go()">x</button>', '<a href="javascript:void(0)">x</a>']) {
      const { policy, relaxed } = cspFor(step('a', '/', page('A', extra)), API, origins);
      expect(relaxed, extra).toBe(true);
      expect(policy).toContain("script-src 'self' 'unsafe-inline' https:");
    }
  });
  it('JSON-LD data blocks and relative scripts do not relax it', () => {
    const { relaxed } = cspFor(step('a', '/', page('A', '<script type="application/ld+json">{"a":1}</script>')), API, origins);
    expect(relaxed).toBe(false);
  });
  it('is deterministic', () => {
    const s = step('a', '/');
    expect(cspFor(s, API, origins).policy).toBe(cspFor(s, API, origins).policy);
  });
});

describe('upload batches', () => {
  it('split by count and by size, keeping order', () => {
    const f = (n: number, size = 10) => Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, base64: 'x'.repeat(size), contentType: 'text/html' }));
    expect(batches(f(1200)).map((b) => b.length)).toEqual([500, 500, 200]);
    expect(batches(f(5, 10), 500, 25).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batches([], 5)).toEqual([]);
    expect(batches(f(2, 100), 500, 25).map((b) => b.length)).toEqual([1, 1]); // a single oversized file still travels alone
  });
});
