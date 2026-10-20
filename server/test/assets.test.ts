import { describe, expect, it } from 'vitest';
import { MAX_ASSET_BYTES, MAX_ASSETS, safeAssetName } from '../src/services/assets.js';
import { makeHarness, type Harness } from './helpers.js';

// 1x1 PNG, GIF, JPEG and WebP headers (enough for content sniffing)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(12)]);

const upload = (h: Harness, token: string, bytes: Buffer, name = 'pic.png', type = 'image/png') => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name, { type }));
  return h.app.request('/api/assets', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.7' }, body: form });
};

describe('asset uploads', () => {
  it('stores PNG, JPEG, GIF and WebP by content, serves them publicly with hardened headers, and lists and deletes per workspace', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    for (const [bytes, mime, ext] of [[PNG, 'image/png', 'png'], [JPEG, 'image/jpeg', 'jpg'], [GIF, 'image/gif', 'gif'], [WEBP, 'image/webp', 'webp']] as const) {
      const r = await upload(h, a.token, bytes, 'My Holiday Photo (1).bin');
      expect(r.status).toBe(201);
      const j = await r.json();
      expect(j).toMatchObject({ mime, size: bytes.length });
      expect(j.name).toBe(`My-Holiday-Photo-1.${ext}`); // extension from the sniffed type, name made URL-safe
      const pub = await h.app.request(j.url);
      expect(pub.status).toBe(200);
      expect(pub.headers.get('content-type')).toBe(mime);
      expect(pub.headers.get('x-content-type-options')).toBe('nosniff');
      expect(pub.headers.get('content-security-policy')).toContain('sandbox');
      expect(pub.headers.get('cache-control')).toContain('immutable');
      expect(Buffer.from(await pub.arrayBuffer()).equals(bytes)).toBe(true);
    }
    const list = (await h.call('GET', '/api/assets', { token: a.token })).json;
    expect(list.data).toHaveLength(4);
    expect(list.limits).toEqual({ maxBytes: MAX_ASSET_BYTES, maxFiles: MAX_ASSETS });
    expect((await h.call('GET', '/api/assets', { token: b.token })).json.data).toHaveLength(0);
    expect((await h.call('DELETE', `/api/assets/${list.data[0].id}`, { token: b.token })).status).toBe(404);
    expect((await h.call('DELETE', `/api/assets/${list.data[0].id}`, { token: a.token })).status).toBe(204);
    expect((await h.app.request(list.data[0].url)).status).toBe(404);
  });

  it('accepts a raw body with ?name= as well', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const r = await h.app.request('/api/assets?name=raw.png', { method: 'POST', headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(PNG) });
    expect(r.status).toBe(201);
    expect((await r.json()).name).toBe('raw.png');
  });

  it('refuses anything that is not a raster image, whatever the name or declared type says (SVG, HTML, scripts, polyglots)', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const cases: [string, Buffer, string, string][] = [
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'x.svg', 'image/svg+xml'],
      ['html as png', Buffer.from('<html><script>alert(1)</script>'), 'x.png', 'image/png'],
      ['js as jpg', Buffer.from('alert(1)'), 'x.jpg', 'image/jpeg'],
      ['gif header, wrong version', Buffer.from('GIF99a'), 'x.gif', 'image/gif'],
      ['riff but not webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)]), 'x.webp', 'image/webp'],
    ];
    for (const [label, bytes, name, type] of cases) expect((await upload(h, u.token, bytes, name, type)).status, label).toBe(415);
    expect((await upload(h, u.token, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(h, u.token, Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)]))).status).toBe(413);
    expect((await h.call('GET', '/api/assets', { token: u.token })).json.data).toHaveLength(0);
  });

  it('is limited per workspace and needs the funnels:write permission', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const viewer = await h.member(u, 'viewer');
    expect((await upload(h, viewer.token, PNG)).status).toBe(403);
    expect((await h.call('GET', '/api/assets', { token: viewer.token })).status).toBe(200);
    for (let i = 0; i < MAX_ASSETS; i++) await h.deps.db.run('INSERT INTO assets (id, workspace_id, name, mime, size, data_b64, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `ast_${i}`, u.wsId, 'a.png', 'image/png', 1, 'AA==', '2026-01-01T00:00:00Z');
    const r = await upload(h, u.token, PNG);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe('LIMIT_REACHED');
    expect((await h.call('GET', '/api/assets')).status).toBe(401);
  });

  it('safeAssetName keeps names URL-safe', () => {
    expect(safeAssetName('../../etc/passwd.png', 'png')).toBe('etc-passwd.png');
    expect(safeAssetName('<script>.png', 'png')).toBe('script.png');
    expect(safeAssetName('', 'gif')).toBe('image.gif');
    expect(safeAssetName('Ünïcödé photo.JPG', 'jpg')).toBe('Unicode-photo.jpg');
  });

  it('images are reachable on customer domains (hostname routing passes /uploads/ through to the app)', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const a = await (await upload(h, u.token, PNG)).json();
    const dom = await h.call('POST', '/api/domains', { token: u.token, body: { hostname: 'shop.example.test' } });
    expect(dom.status).toBe(201);
    h.dns.cname.set('shop.example.test', ['sites.funnels.test']);
    h.dns.txt.set('_funnels-challenge.shop.example.test', [dom.json.dns.txt.value]);
    await h.call('POST', `/api/domains/${dom.json.id}/verify`, { token: u.token });
    const r = await h.app.request(a.url, { headers: { host: 'shop.example.test' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
  });
});
