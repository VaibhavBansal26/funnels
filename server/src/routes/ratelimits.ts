import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, authOf, type AppEnv } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { RateLimitAdmin } from '../ratelimit/admin.js';
import { PLANS } from '../ratelimit/types.js';
import { assertPlatformAdmin } from '../services/templates.js';
import { bodyOf, queryOf } from './util.js';

export const WhoInput = z.object({ kind: z.enum(['ip', 'workspace', 'user']), value: z.string().min(1).max(120) });
export const ListEntryInput = WhoInput.extend({ ttlSeconds: z.number().int().min(1).max(30 * 86400).nullable().default(3600) });
export const TierInput = z.object({ plan: z.enum(PLANS as [string, ...string[]]).optional(), multiplier: z.number().min(0.01).max(1000).nullable().optional() });
export const LimitedQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/**
 * Operator hooks for the rate limiter. The admin panel does not exist yet, so this is the whole surface it will call:
 * list recently limited subjects, block/allow a client (ip, workspace or user) with a TTL, override a workspace's plan or multiplier.
 * Guarded by PLATFORM_ADMIN_EMAILS like the template administration; every change is written to audit_log.
 */
export function rateLimitAdminRoutes(deps: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const admin = new RateLimitAdmin(deps);
  r.use('*', authenticate(deps));
  r.use('*', async (c, next) => {
    assertPlatformAdmin(deps, authOf(c));
    await next();
  });
  r.get('/rate-limits', async (c) => {
    const q = queryOf(c, LimitedQuery);
    return c.json({ limited: await admin.limited(q.limit), lists: await admin.lists(), policies: deps.limiter.policies.map((p) => ({ id: p.id, algo: p.algo, layer: p.layer, keyBy: p.keyBy, limit: p.limit, windowMs: p.windowMs, onFail: p.onFail })) });
  });
  r.post('/rate-limits/blocks', async (c) => {
    const b = await bodyOf(c, ListEntryInput);
    return c.json(await admin.block(authOf(c).email, b, b.ttlSeconds), 201);
  });
  r.delete('/rate-limits/blocks', async (c) => {
    await admin.unblock(authOf(c).email, await bodyOf(c, WhoInput));
    return c.body(null, 204);
  });
  r.post('/rate-limits/allows', async (c) => {
    const b = await bodyOf(c, ListEntryInput);
    return c.json(await admin.allow(authOf(c).email, b, b.ttlSeconds), 201);
  });
  r.delete('/rate-limits/allows', async (c) => {
    await admin.unallow(authOf(c).email, await bodyOf(c, WhoInput));
    return c.body(null, 204);
  });
  r.put('/workspaces/:id/rate-tier', async (c) => c.json(await admin.setTier(authOf(c).email, c.req.param('id'), (await bodyOf(c, TierInput)) as { plan?: 'free' | 'pro' | 'business'; multiplier?: number | null })));
  return r;
}
