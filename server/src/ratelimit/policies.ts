import type { Config } from '../config.js';
import { DEFAULT_PENALTY, type Policy } from './types.js';

const MIN = 60_000;

/**
 * THE policy registry: every limit the app enforces, in one table. Routes name a policy id in routes/spec.ts (the same declaration
 * that documents authz); a test fails for any route without one and for any id that is not defined here.
 * Layers run cheapest first: ip, class, principal, workspace, concurrency.
 */
export function buildPolicies(cfg: Pick<Config, 'IP_GUARD_PER_MINUTE' | 'PUBLIC_EVENTS_PER_MINUTE' | 'PUBLIC_FORMS_PER_MINUTE' | 'PUBLIC_PAGES_PER_MINUTE' | 'AUTH_ATTEMPTS_PER_MINUTE' | 'AI_RATE_LIMIT_PER_MINUTE' | 'API_USER_PER_MINUTE' | 'API_WORKSPACE_PER_MINUTE' | 'EXPORT_CONCURRENCY' | 'EDGE_RESOLVE_PER_MINUTE'> & Partial<Pick<Config, 'AI_DAILY_CAP' | 'INGEST_WORKSPACE_PER_MINUTE'>>): Policy[] {
  const tiers = { free: 1, pro: 5, business: 20 };
  return [
    { id: 'ip.global', description: 'Per client IP, every request. A coarse guard against floods; generous on purpose because many people share an IP.', layer: 'ip', keyBy: 'ip', algo: 'gcra', limit: cfg.IP_GUARD_PER_MINUTE, windowMs: MIN, burst: Math.ceil(cfg.IP_GUARD_PER_MINUTE / 4), cost: 1, onFail: 'open', lease: true },
    { id: 'public.events', description: 'Public beacon events, per IP and funnel.', layer: 'class', keyBy: 'composite', composite: ['ip', 'scope'], algo: 'gcra', limit: cfg.PUBLIC_EVENTS_PER_MINUTE, windowMs: MIN, cost: 1, onFail: 'open', lease: true },
    { id: 'public.forms', description: 'Public form posts, per IP and funnel. Fails closed so a limiter outage cannot become a spam flood.', layer: 'class', keyBy: 'composite', composite: ['ip', 'scope'], algo: 'gcra', limit: cfg.PUBLIC_FORMS_PER_MINUTE, windowMs: MIN, cost: 1, onFail: 'closed', penalty: true, idempotent: true },
    { id: 'public.checkout', description: 'Public checkout posts, per IP and funnel. Fails closed.', layer: 'class', keyBy: 'composite', composite: ['ip', 'scope'], algo: 'gcra', limit: cfg.PUBLIC_FORMS_PER_MINUTE, windowMs: MIN, cost: 1, onFail: 'closed', penalty: true, idempotent: true },
    { id: 'public.page', description: 'Pages served straight from the origin on a customer domain, per IP (the edge cache absorbs real traffic).', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: cfg.PUBLIC_PAGES_PER_MINUTE, windowMs: MIN, burst: Math.ceil(cfg.PUBLIC_PAGES_PER_MINUTE / 4), cost: 1, onFail: 'open', lease: true },
    { id: 'public.preview', description: 'Signed previews, per IP.', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: 300, windowMs: MIN, burst: 100, cost: 1, onFail: 'open', lease: true },
    { id: 'auth.attempts', description: 'Register and login requests, per IP. Fails closed, with a penalty box.', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: cfg.AUTH_ATTEMPTS_PER_MINUTE, windowMs: MIN, cost: 1, onFail: 'closed', penalty: true },
    { id: 'auth.failures.account', description: 'Failed logins per account (hashed email): lockout after 8 failures in 15 minutes.', layer: 'principal', keyBy: 'composite', composite: ['scope'], algo: 'window', limit: 8, windowMs: 15 * MIN, cost: 1, onFail: 'closed' },
    { id: 'auth.failures.ip', description: 'Failed logins per IP: lockout after 30 failures in 15 minutes.', layer: 'principal', keyBy: 'ip', algo: 'window', limit: 30, windowMs: 15 * MIN, cost: 1, onFail: 'closed' },
    { id: 'api.read', description: 'Authenticated reads, per user.', layer: 'principal', keyBy: 'user', algo: 'gcra', limit: cfg.API_USER_PER_MINUTE, windowMs: MIN, burst: Math.ceil(cfg.API_USER_PER_MINUTE / 3), cost: 1, onFail: 'open', lease: true },
    { id: 'api.write', description: 'Authenticated writes, per user. A repeated Idempotency-Key is not counted twice.', layer: 'principal', keyBy: 'user', algo: 'gcra', limit: Math.ceil(cfg.API_USER_PER_MINUTE / 2), windowMs: MIN, burst: Math.ceil(cfg.API_USER_PER_MINUTE / 6), cost: 1, onFail: 'open', idempotent: true },
    { id: 'api.workspace', description: 'Workspace quota across all its users, tiered by plan (free x1, pro x5, business x20, overridable per workspace).', layer: 'workspace', keyBy: 'workspace', algo: 'gcra', limit: cfg.API_WORKSPACE_PER_MINUTE, windowMs: MIN, burst: Math.ceil(cfg.API_WORKSPACE_PER_MINUTE / 3), cost: 1, onFail: 'open', tiers, lease: true },
    { id: 'api.export', description: 'Concurrent CSV exports per workspace (in-flight cap, lease with TTL, released in finally).', layer: 'concurrency', keyBy: 'workspace', algo: 'concurrency', limit: cfg.EXPORT_CONCURRENCY, windowMs: 0, cost: 1, onFail: 'open', tiers: { free: 1, pro: 2, business: 4 }, leaseTtlMs: 120_000 },
    { id: 'api.stream', description: 'Open SSE streams per user.', layer: 'concurrency', keyBy: 'user', algo: 'concurrency', limit: 5, windowMs: 0, cost: 1, onFail: 'open', leaseTtlMs: 3_600_000 },
    { id: 'ingest.workspace', description: 'Public events per workspace (noisy-neighbour guard, checked before an event is queued). GCRA with a one-second burst, scaled by plan tier; a refusal affects only that workspace.', layer: 'workspace', keyBy: 'workspace', algo: 'gcra', limit: cfg.INGEST_WORKSPACE_PER_MINUTE ?? 600_000, windowMs: MIN, burst: Math.max(1, Math.ceil((cfg.INGEST_WORKSPACE_PER_MINUTE ?? 600_000) / 60)), cost: 1, onFail: 'local', tiers, lease: true },
    { id: 'ai.minute', description: 'AI calls per workspace per minute; each call costs 10 units. The daily cap is `ai.daily`; ai_usage only meters.', layer: 'workspace', keyBy: 'workspace', algo: 'gcra', limit: cfg.AI_RATE_LIMIT_PER_MINUTE * 10, windowMs: MIN, cost: 10, onFail: 'open', tiers },
    { id: 'ai.daily', description: 'AI calls per workspace per day (sliding window over two adjacent UTC days, AI_DAILY_CAP, scaled by plan tier). Refusals answer AI_DAILY_CAP_REACHED. A cap of 0 disables AI.', layer: 'workspace', keyBy: 'workspace', algo: 'window', limit: Math.max(1, cfg.AI_DAILY_CAP ?? 50), windowMs: 24 * 3600_000, cost: 1, onFail: 'open', tiers },
    { id: 'edge.resolve', description: 'Signed requests from the Cloudflare worker (all traffic arrives from few IPs, so the limit is high).', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: cfg.EDGE_RESOLVE_PER_MINUTE, windowMs: MIN, burst: Math.ceil(cfg.EDGE_RESOLVE_PER_MINUTE / 10), cost: 1, onFail: 'open', lease: true },
    { id: 'admin.platform', description: 'Platform admin routes, per user.', layer: 'principal', keyBy: 'user', algo: 'gcra', limit: 120, windowMs: MIN, burst: 30, cost: 1, onFail: 'closed' },
    { id: 'webhook.inbound', description: 'Reserved for inbound provider webhooks (Stripe, later). High limit, fails open so a limiter outage never drops payment events.', layer: 'class', keyBy: 'ip', algo: 'gcra', limit: 6000, windowMs: MIN, burst: 1000, cost: 1, onFail: 'open', lease: true },
  ];
}

export const PENALTY = DEFAULT_PENALTY;
export const EXEMPT = 'exempt';
