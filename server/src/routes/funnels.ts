import { Hono, type Context } from 'hono';
import { authenticate, authOf, requireRole, type AppEnv } from '../auth/context.js';
import { signPreviewToken } from '../auth/tokens.js';
import type { Deps } from '../deps.js';
import { requireFunnel } from '../repos/funnels.js';
import * as analytics from '../services/analytics.js';
import * as funnels from '../services/funnels.js';
import * as pages from '../services/pages.js';
import * as steps from '../services/steps.js';
import { z } from 'zod';
import { bodyOf, queryOf } from './util.js';

const SaveInput = z.object({ doc: z.unknown(), version: z.number().int().optional(), backup: z.boolean().optional() });

export function funnelRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', authenticate(deps));
  const ws = (c: Context<AppEnv>) => authOf(c).workspaceId;

  r.get('/', (c) => c.json(funnels.listFunnels(deps, ws(c), queryOf(c, funnels.ListQuery))));
  r.get('/filters', (c) => c.json(funnels.filterCounts(deps, ws(c))));
  r.get('/trash', (c) => c.json(funnels.listTrash(deps, ws(c))));
  r.post('/', async (c) => c.json(funnels.createFunnel(deps, authOf(c), await bodyOf(c, funnels.CreateFunnelInput)), 201));
  r.post('/validate-path', async (c) => c.json(steps.validatePath(deps, ws(c), await bodyOf(c, steps.ValidatePathInput))));
  r.post('/bulk-tag', async (c) => c.json(funnels.bulkTag(deps, ws(c), await bodyOf(c, funnels.BulkTagInput))));

  r.get('/:id', (c) => c.json(funnels.getFunnelDetail(deps, ws(c), c.req.param('id'))));
  const update = async (c: Context<AppEnv>) => c.json(funnels.updateFunnel(deps, authOf(c), c.req.param('id') as string, await bodyOf(c, funnels.UpdateFunnelInput)));
  r.patch('/:id', update);
  r.put('/:id', update);
  r.delete('/:id', requireRole('admin'), (c) => {
    funnels.softDeleteFunnel(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/:id/restore', requireRole('admin'), (c) => c.json(funnels.restoreFunnel(deps, authOf(c), c.req.param('id'))));
  r.delete('/:id/purge', requireRole('owner'), (c) => {
    funnels.purgeFunnel(deps, authOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/:id/duplicate', (c) => c.json(funnels.duplicateFunnel(deps, authOf(c), c.req.param('id')), 201));

  // Previews are not world-readable: a short-lived signed token is minted for an authenticated member and carried in the URL.
  r.post('/:id/preview-token', async (c) => {
    const f = requireFunnel(deps.db, ws(c), c.req.param('id'));
    const token = await signPreviewToken(deps.config, ws(c), f.id, deps.now());
    return c.json({ token, url: `/preview/${f.id}?token=${token}`, expiresInSeconds: deps.config.PREVIEW_TOKEN_TTL_SECONDS });
  });

  r.get('/:id/analytics', (c) => c.json(analytics.funnelAnalytics(deps, ws(c), c.req.param('id'), queryOf(c, analytics.AnalyticsQuery))));

  r.get('/:id/steps', (c) => c.json({ data: funnels.getFunnelDetail(deps, ws(c), c.req.param('id')).steps }));
  r.post('/:id/steps', async (c) => c.json(steps.createStep(deps, authOf(c), c.req.param('id'), await bodyOf(c, steps.StepInput)), 201));
  r.put('/:id/steps/order', async (c) => c.json({ data: steps.reorderSteps(deps, authOf(c), c.req.param('id'), await bodyOf(c, steps.ReorderInput)) }));
  r.patch('/:id/steps/:sid', async (c) => c.json(steps.updateStep(deps, authOf(c), c.req.param('id'), c.req.param('sid'), await bodyOf(c, steps.StepPatch))));
  r.delete('/:id/steps/:sid', (c) => {
    steps.deleteStep(deps, authOf(c), c.req.param('id'), c.req.param('sid'));
    return c.body(null, 204);
  });
  r.post('/:id/steps/:sid/duplicate', (c) => c.json(steps.duplicateStep(deps, authOf(c), c.req.param('id'), c.req.param('sid')), 201));
  r.get('/:id/steps/:sid/analytics', (c) => c.json(analytics.stepAnalytics(deps, ws(c), c.req.param('id'), c.req.param('sid'), queryOf(c, analytics.AnalyticsQuery))));

  r.get('/:id/steps/:sid/page', (c) => c.json(pages.getPage(deps, ws(c), c.req.param('id'), c.req.param('sid'))));
  r.put('/:id/steps/:sid/page', async (c) => {
    const b = await bodyOf(c, SaveInput);
    return c.json(pages.savePage(deps, authOf(c), c.req.param('id'), c.req.param('sid'), b.doc, { expectedVersion: b.version, backup: b.backup }));
  });
  r.get('/:id/steps/:sid/backups', (c) => c.json({ data: pages.listBackups(deps, ws(c), c.req.param('id'), c.req.param('sid')) }));
  r.get('/:id/steps/:sid/backups/:bid', (c) => c.json(pages.getBackup(deps, ws(c), c.req.param('id'), c.req.param('sid'), c.req.param('bid'))));
  r.post('/:id/steps/:sid/backups/:bid/restore', (c) => c.json(pages.restoreBackup(deps, authOf(c), c.req.param('id'), c.req.param('sid'), c.req.param('bid'))));
  return r;
}
