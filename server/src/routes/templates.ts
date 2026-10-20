import { Hono } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import * as templates from '../services/templates.js';
import * as templateio from '../services/templateio.js';
import { jsonWithEtag } from './etag.js';
import { bodyOf, queryOf } from './util.js';

export function templateRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  r.get('/', async (c) => jsonWithEtag(c, await templates.listTemplates(deps, queryOf(c, templates.TemplateQuery))));
  r.get('/categories', async (c) => jsonWithEtag(c, await templates.listCategories(deps)));
  r.get('/:id/html', async (c) => jsonWithEtag(c, await templates.templateStepHtml(deps, c.req.param('id'), queryOf(c, templates.TemplateHtmlQuery).step)));
  r.get('/:id', async (c) => jsonWithEtag(c, await templates.getTemplate(deps, c.req.param('id'), { docs: queryOf(c, templates.TemplateDetailQuery).docs === 'true', preview: true })));
  r.post('/:id/use', async (c) => c.json(await templates.useTemplate(deps, authOf(c), c.req.param('id'), await bodyOf(c, templates.UseTemplateInput, { optional: true })), 201));
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
  r.post('/templates/import', async (c) => c.json(await templateio.importTemplate(deps, authOf(c), await bodyOf(c, templateio.TemplateImport), c.req.header('x-forwarded-for')), 201));
  r.get('/templates/:id/export', async (c) => {
    const file = await templateio.exportTemplate(deps, authOf(c), c.req.param('id'));
    return c.json(file, 200, { 'content-disposition': `attachment; filename="template-${file.template.slug}.json"` });
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
