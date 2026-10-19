import type { Context, MiddlewareHandler } from 'hono';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { type Operation, matchOperation } from '../routes/spec.js';
import { clientIp } from './ip.js';
import { denyError, limitHeaders, tightest } from './response.js';
import type { Decision, Principal } from './types.js';

export interface RlContext {
  op: Operation | null;
  params: Record<string, string>;
  principal: Principal;
  decisions: Decision[];
  idempotencyKey?: string;
  /** Set by the middleware; authenticate() calls it once the caller is known. */
  afterAuth?: (auth: Auth) => Promise<void>;
}

const RL_KEY = 'rl';

function apply(c: Context, rl: RlContext): void {
  const t = tightest(rl.decisions);
  if (t) for (const [k, v] of Object.entries(limitHeaders(t))) c.header(k, v);
}

export { denyError, limitHeaders, tightest };
export const rlOf = (c: Context): RlContext | undefined => c.get(RL_KEY as never) as RlContext | undefined;

/**
 * Pre-handler layers (ip and class) for the declared operation, cheapest first. Principal and workspace layers run inside
 * authenticate() once the caller is known; policies that need the body run in the handler (see Operation.inHandler).
 */
export function rateLimitMiddleware(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const m = matchOperation(c.req.method, url.pathname);
    const rl: RlContext = {
      op: m?.op ?? null,
      params: m?.params ?? {},
      principal: { ip: clientIp(c, deps.config) },
      decisions: [],
      idempotencyKey: c.req.header('idempotency-key')?.slice(0, 200),
    };
    c.set(RL_KEY as never, rl as never);
    rl.afterAuth = (auth) => applyPrincipalLayers(deps, c, auth);
    if (m?.op.exempt) return next();
    const op = m?.op;
    if (op?.scope) rl.principal.scope = m!.params[op.scope];
    const ids = (op?.limits ?? ['ip.global']).filter((id) => ['ip', 'class'].includes(deps.limiter.policy(id).layer));
    const { decisions, denied } = await deps.limiter.evaluate(ids, rl.principal, { idempotencyKey: rl.idempotencyKey });
    rl.decisions.push(...decisions);
    apply(c, rl);
    if (denied) throw denyError(denied);
    await next();
  };
}

/** Called by authenticate(): the user/workspace layers for the declared operation. */
export async function applyPrincipalLayers(deps: Deps, c: Context, auth: Auth): Promise<void> {
  const rl = rlOf(c);
  if (!rl?.op || rl.op.exempt) return;
  rl.principal.userId = auth.userId;
  rl.principal.workspaceId = auth.workspaceId;
  const ids = rl.op.limits.filter((id) => ['principal', 'workspace'].includes(deps.limiter.policy(id).layer));
  const { decisions, denied } = await deps.limiter.evaluate(ids, rl.principal, { cost: rl.op.cost, idempotencyKey: rl.idempotencyKey });
  rl.decisions.push(...decisions);
  apply(c, rl);
  if (denied) throw denyError(denied);
}

/** For policies the handler evaluates itself (body-scoped keys, model calls). */
export async function enforceInHandler(deps: Deps, c: Context, policyId: string, opts: { scope?: string; cost?: number } = {}): Promise<void> {
  const rl = rlOf(c) ?? { op: null, params: {}, principal: { ip: clientIp(c, deps.config) }, decisions: [] as Decision[] };
  const principal = { ...rl.principal, ...(opts.scope !== undefined ? { scope: opts.scope } : {}) };
  const d = await deps.limiter.check(policyId, principal, { cost: opts.cost, idempotencyKey: (rl as RlContext).idempotencyKey });
  rl.decisions.push(d);
  if (rlOf(c)) apply(c, rl as RlContext);
  if (!d.allowed) throw denyError(d);
}

/** Principal for service-level policy calls (AI guard): the request's context plus the authenticated workspace. */
export function principalFor(c: Context, deps: Deps, auth: Auth): Principal {
  return { ...(rlOf(c)?.principal ?? { ip: clientIp(c, deps.config) }), userId: auth.userId, workspaceId: auth.workspaceId };
}
