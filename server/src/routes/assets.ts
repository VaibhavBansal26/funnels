import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest } from '../errors.js';
import { MAX_ASSET_BYTES, deleteAsset, listAssets, readAsset, uploadAsset } from '../services/assets.js';

export function assetRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await listAssets(deps, authOf(c).workspaceId)));
  r.post(
    '/',
    bodyLimit({ maxSize: MAX_ASSET_BYTES + 64 * 1024, onError: () => { throw new AppError(413, 'FILE_TOO_LARGE', 'The upload is too large'); } }),
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      let name = 'image';
      let bytes: Uint8Array;
      if (type.includes('multipart/form-data')) {
        const form = await c.req.parseBody();
        const file = form['file'];
        if (!(file instanceof File)) throw badRequest('NO_FILE', 'Send the image as the "file" field');
        name = file.name || name;
        bytes = new Uint8Array(await file.arrayBuffer());
      } else {
        // Raw upload: the body is the image, the name comes from ?name=
        name = c.req.query('name') ?? name;
        bytes = new Uint8Array(await c.req.arrayBuffer());
      }
      return c.json(await uploadAsset(deps, authOf(c), { name, bytes }), 201);
    },
  );
  r.delete('/:id', async (c) => {
    await deleteAsset(deps, authOf(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}

/** Public, cacheable image delivery for published pages (also reachable on customer domains, see PASSTHROUGH and the edge worker). */
export function uploadRoutes(deps: Deps): Hono {
  const r = new Hono();
  const handle = async (c: import('hono').Context) => {
    const a = await readAsset(deps, c.req.param('id') as string);
    if (!a) return c.json({ error: { code: 'NOT_FOUND', message: 'Image not found' } }, 404, { 'cache-control': 'no-store' });
    return c.body(new Uint8Array(a.bytes), 200, {
      'content-type': a.mime,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
      'content-disposition': 'inline',
    });
  };
  r.get('/uploads/:id/:name', handle);
  r.get('/uploads/:id', handle);
  return r;
}
