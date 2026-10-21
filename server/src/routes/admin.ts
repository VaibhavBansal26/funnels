import { Hono, type Context } from 'hono';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { clientIp } from '../ratelimit/ip.js';
import * as admin from '../services/admin.js';
import * as ann from '../services/announcements.js';
import * as flags from '../services/flags.js';
import * as gdpr from '../services/gdpr.js';
import * as queues from '../services/queueadmin.js';
import * as monitoring from '../services/monitoring.js';
import { parse } from '../errors.js';
import { bodyOf, queryOf } from './util.js';

/**
 * The admin area (docs/ADMIN.md): every route is declared `auth: 'platform'` in routes/spec.ts, and authenticate() applies the platform check (administrator,
 * not impersonating, two-factor when required) before any handler here runs. Every state change writes an audit row naming the administrator.
 */
export function platformAdminRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const ip = (c: Context) => clientIp(c, deps.config);
  r.use('*', authenticate(deps));

  r.get('/stats', async (c) => c.json(await admin.stats(deps)));
  r.get('/admins', async (c) => c.json(await admin.listAdmins(deps)));
  r.post('/admins', async (c) => c.json(await admin.addAdmin(deps, authOf(c), await bodyOf(c, admin.AdminAddInput), ip(c)), 201));
  r.delete('/admins/:userId', async (c) => {
    await admin.removeAdmin(deps, authOf(c), c.req.param('userId'), ip(c));
    return c.body(null, 204);
  });

  r.get('/workspaces', async (c) => c.json(await admin.listWorkspaces(deps, queryOf(c, admin.WorkspaceQuery))));
  r.get('/workspaces/:id', async (c) => c.json(await admin.getWorkspace(deps, c.req.param('id'))));
  r.post('/workspaces/:id/suspend', async (c) => c.json(await admin.suspendWorkspace(deps, authOf(c), c.req.param('id'), await bodyOf(c, admin.SuspendInput), ip(c))));
  r.post('/workspaces/:id/unsuspend', async (c) => c.json(await admin.unsuspendWorkspace(deps, authOf(c), c.req.param('id'), ip(c))));
  r.post('/workspaces/:id/impersonate', async (c) =>
    c.json(await admin.impersonate(deps, authOf(c), c.req.param('id'), await bodyOf(c, admin.ImpersonateInput), { ip: ip(c), userAgent: c.req.header('user-agent') }), 201),
  );
  r.delete('/workspaces/:id', async (c) => {
    await admin.deleteWorkspace(deps, authOf(c), c.req.param('id'), await bodyOf(c, admin.DeleteWorkspaceInput), ip(c));
    return c.body(null, 204);
  });
  r.get('/workspaces/:id/export', async (c) => {
    const stream = await gdpr.exportWorkspace(deps, authOf(c), c.req.param('id'), ip(c));
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="workspace-${c.req.param('id')}.ndjson"`, 'cache-control': 'no-store' } });
  });

  r.get('/monitoring', (c) => c.json(monitoring.monitoringStatus(deps)));
  r.post('/monitoring/test', async (c) => c.json(await monitoring.sendTestError(deps, authOf(c), ip(c))));

  r.get('/queues', async (c) => c.json(await queues.overview(deps)));
  r.get('/queues/dead-jobs', async (c) => c.json(await queues.deadJobs(deps)));
  r.get('/queues/dead-letters', async (c) => c.json(await queues.deadLetters(deps)));
  r.post('/queues/jobs/:id/retry', async (c) => c.json(await queues.retryJob(deps, authOf(c), c.req.param('id'), ip(c))));
  r.delete('/queues/jobs/:id', async (c) => {
    await queues.discardJob(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });

  r.get('/flags', async (c) => c.json(await flags.listFlags(deps)));
  r.put('/flags/:key', async (c) => c.json(await flags.upsertFlag(deps, authOf(c), parse(flags.FlagKey, c.req.param('key')), await bodyOf(c, flags.FlagInput), ip(c))));
  r.delete('/flags/:key', async (c) => {
    await flags.deleteFlag(deps, authOf(c), parse(flags.FlagKey, c.req.param('key')), ip(c));
    return c.body(null, 204);
  });
  r.put('/flags/:key/workspaces/:id', async (c) => c.json(await flags.setOverride(deps, authOf(c), parse(flags.FlagKey, c.req.param('key')), c.req.param('id'), (await bodyOf(c, flags.OverrideInput)).enabled, ip(c))));

  r.get('/announcements', async (c) => c.json(await ann.listAll(deps)));
  r.post('/announcements', async (c) => c.json(await ann.create(deps, authOf(c), await bodyOf(c, ann.AnnouncementInput), ip(c)), 201));
  r.patch('/announcements/:id', async (c) => c.json(await ann.update(deps, authOf(c), c.req.param('id'), await bodyOf(c, ann.AnnouncementPatch), ip(c))));
  r.delete('/announcements/:id', async (c) => {
    await ann.remove(deps, authOf(c), c.req.param('id'), ip(c));
    return c.body(null, 204);
  });

  r.get('/audit', async (c) => c.json(await admin.listPlatformAudit(deps, queryOf(c, admin.PlatformAuditQuery))));
  r.post('/gdpr/export', async (c) => c.json(await gdpr.exportSubject(deps, authOf(c), await bodyOf(c, gdpr.SubjectInput), ip(c))));
  r.post('/gdpr/erase', async (c) => c.json(await gdpr.eraseSubject(deps, authOf(c), await bodyOf(c, gdpr.SubjectInput), ip(c))));
  return r;
}

/** What every signed-in user may read: active announcements (and dismiss them) and the evaluated feature flags of their workspace. */
export function noticeRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const auth = authenticate(deps); // per route: this router is mounted at '/', so a wildcard here would also catch every other /api route
  r.get('/announcements', auth, async (c) => c.json(await ann.activeFor(deps, authOf(c).userId)));
  r.post('/announcements/:id/dismiss', auth, async (c) => {
    await ann.dismiss(deps, authOf(c).userId, c.req.param('id'));
    return c.body(null, 204);
  });
  r.get('/workspace/flags', auth, async (c) => c.json({ flags: await flags.flagsFor(deps, authOf(c).workspaceId) }));
  return r;
}
