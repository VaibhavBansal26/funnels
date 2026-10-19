import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { badRequest } from '../errors.js';
import * as tags from '../services/tags.js';
import { bodyOf } from './util.js';

export function tagRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await tags.listTags(deps, authOf(c).workspaceId, c.req.query('search')?.slice(0, 50))));
  r.post('/', async (c) => c.json(await tags.createTag(deps, authOf(c).workspaceId, await bodyOf(c, tags.TagInput)), 201));
  r.put('/:id', async (c) => c.json(await tags.renameTag(deps, authOf(c).workspaceId, c.req.param('id'), await bodyOf(c, tags.TagInput))));
  r.delete('/:id', async (c) => {
    await tags.deleteTags(deps, authOf(c).workspaceId, [c.req.param('id')]);
    return c.body(null, 204);
  });
  // Bulk form kept from the legacy API: DELETE /tags?ids=a,b
  r.delete('/', async (c) => {
    const ids = z.array(z.string().min(1).max(64)).min(1).max(100).safeParse((c.req.query('ids') ?? '').split(',').filter(Boolean));
    if (!ids.success) throw badRequest('VALIDATION_ERROR', 'Provide ?ids=id1,id2');
    return c.json(await tags.deleteTags(deps, authOf(c).workspaceId, ids.data));
  });
  return r;
}
