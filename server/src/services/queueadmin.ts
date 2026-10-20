import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { conflict, notFound } from '../errors.js';
import { TOPIC_EVENTS_STORED, TOPIC_INGEST } from '../queue/outbox.js';
import { INGEST_GROUP } from './eventbuffer.js';
import { MIRROR_GROUP } from '../queue/runtime.js';
import { audit } from './audit.js';

/** The queue inspector (docs/ADMIN.md): the job queue, the outbox, the event bus and webhook deliveries, read-only except retrying or discarding a dead job. */
const num = (v: unknown) => Number(v ?? 0);

/** Consumer groups this installation runs, as (topic, group). */
function consumers(deps: Deps): { topic: string; group: string }[] {
  return [
    ...(deps.config.INGEST_QUEUE ? [{ topic: TOPIC_INGEST, group: INGEST_GROUP }] : []),
    ...(deps.secondaryStore ? [{ topic: TOPIC_EVENTS_STORED, group: MIRROR_GROUP }] : []),
  ];
}

export async function overview(deps: Deps) {
  const now = deps.now().getTime();
  const jobs = await deps.db.all<{ status: string; type: string; n: number; oldest: number | null }>('SELECT status, type, COUNT(*) AS n, MIN(run_at) AS oldest FROM jobs WHERE status <> \'done\' GROUP BY status, type ORDER BY status, type');
  const outbox = await deps.db.get<{ n: number; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox_events WHERE published_at IS NULL');
  const deliveries = await deps.db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM webhook_deliveries WHERE status <> 'delivered' GROUP BY status");
  const bus = [];
  for (const c of consumers(deps)) {
    const dead = await deps.eventBus.deadLetters(c.topic, c.group).catch(() => []);
    bus.push({ ...c, lag: await deps.eventBus.lag(c.topic, c.group).catch(() => null), deadLetters: dead.length });
  }
  return {
    jobs: jobs.map((j) => ({ status: j.status, type: j.type, count: num(j.n), oldestAgeSeconds: j.oldest === null ? null : Math.max(0, Math.round((now - num(j.oldest)) / 1000)) })),
    outbox: { unpublished: num(outbox?.n), oldestAgeSeconds: outbox?.oldest ? Math.max(0, Math.round((now - Date.parse(outbox.oldest)) / 1000)) : null },
    webhookDeliveries: Object.fromEntries(deliveries.map((d) => [d.status, num(d.n)])),
    bus: { kind: deps.eventBus.kind, consumers: bus },
    eventBuffer: { depth: deps.events.depth },
  };
}

export async function deadJobs(deps: Deps) {
  const rows = await deps.db.all<{ id: string; type: string; payload_json: string; attempts: number; max_attempts: number; last_error: string | null; updated_at: string }>(
    "SELECT id, type, payload_json, attempts, max_attempts, last_error, updated_at FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC, id DESC LIMIT ?", deps.config.ADMIN_QUEUE_PEEK,
  );
  return { data: rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload_json.length > 2000 ? `${r.payload_json.slice(0, 2000)}...` : r.payload_json, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: r.last_error, updatedAt: r.updated_at })) };
}

export async function retryJob(deps: Deps, auth: Auth, id: string, ip?: string) {
  const at = deps.now();
  const { changes } = await deps.db.run("UPDATE jobs SET status = 'queued', attempts = 0, run_at = ?, locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'dead'", at.getTime(), at.toISOString(), id);
  if (changes === 0) throw (await deps.db.get('SELECT 1 FROM jobs WHERE id = ?', id)) ? conflict('NOT_DEAD', 'Only dead jobs can be retried') : notFound('Job');
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.job.retried', target: id, ip });
  return { id, status: 'queued' };
}

export async function discardJob(deps: Deps, auth: Auth, id: string, ip?: string): Promise<void> {
  const row = await deps.db.get<{ type: string }>("SELECT type FROM jobs WHERE id = ? AND status = 'dead'", id);
  if (!row) throw (await deps.db.get('SELECT 1 FROM jobs WHERE id = ?', id)) ? conflict('NOT_DEAD', 'Only dead jobs can be discarded') : notFound('Job');
  await deps.db.run("DELETE FROM jobs WHERE id = ? AND status = 'dead'", id);
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.job.discarded', target: id, detail: { type: row.type }, ip });
}

export async function deadLetters(deps: Deps) {
  const out = [];
  for (const c of consumers(deps)) {
    for (const d of (await deps.eventBus.deadLetters(c.topic, c.group)).slice(0, deps.config.ADMIN_QUEUE_PEEK)) {
      const payload = JSON.stringify(d.event.payload ?? null);
      out.push({ topic: c.topic, group: c.group, id: d.event.id, key: d.event.key, error: d.error, payload: payload.length > 2000 ? `${payload.slice(0, 2000)}...` : payload });
    }
  }
  return { data: out };
}
