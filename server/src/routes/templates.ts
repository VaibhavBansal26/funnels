import { Hono } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as templates from '../services/templates.js';
import { bodyOf, queryOf } from './util.js';

export function templateRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await templates.listTemplates(deps, queryOf(c, templates.TemplateQuery))));
  r.get('/categories', async (c) => c.json(await templates.listCategories(deps)));
  r.get('/:id', async (c) => c.json(await templates.getTemplate(deps, c.req.param('id'))));
  r.post('/:id/use', async (c) => c.json(await templates.useTemplate(deps, authOf(c), c.req.param('id')), 201));
  return r;
}

/** Template administration. Guarded by the PLATFORM_ADMIN_EMAILS list, never by hostnames or workspace roles. */
export function adminTemplateRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.post('/templates', async (c) => c.json(await templates.createTemplate(deps, authOf(c), await bodyOf(c, templates.TemplateCreate)), 201));
  r.patch('/templates/:id', async (c) => c.json(await templates.updateTemplate(deps, authOf(c), c.req.param('id'), await bodyOf(c, templates.TemplatePatch))));
  r.delete('/templates/:id', async (c) => {
    await templates.deleteTemplate(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/template-categories', async (c) => c.json(await templates.createCategory(deps, authOf(c), await bodyOf(c, templates.CategoryInput)), 201));
  r.delete('/template-categories/:id', async (c) => {
    await templates.deleteCategory(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}

export function blockRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => c.json(await templates.listCustomBlocks(deps, authOf(c).workspaceId)));
  r.post('/', async (c) => c.json(await templates.saveCustomBlock(deps, authOf(c).workspaceId, await bodyOf(c, templates.CustomBlockInput)), 201));
  r.delete('/:id', async (c) => {
    await templates.deleteCustomBlock(deps, authOf(c).workspaceId, c.req.param('id'));
    return c.body(null, 204);
  });
  return r;
}
