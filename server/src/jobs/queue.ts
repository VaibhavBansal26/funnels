import type { Db } from '../db/db.js';
import type { Logger } from '../logger.js';
import { newId } from '../util/ids.js';

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  attempts: number;
  max_attempts: number;
}

/** Thrown by a handler to dead-letter a job immediately instead of retrying. */
export class PermanentJobError extends Error {}

/** Exponential backoff: 30s, 60s, 2m, 4m, 8m ... capped at 1h. `attempt` is the number of attempts already made. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

const STALE_LOCK_MS = 5 * 60_000;

export class JobQueue {
  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  enqueue(type: string, payload: unknown, opts: { delayMs?: number; maxAttempts?: number; dedupeKey?: string } = {}): string | null {
    const id = newId('job');
    const t = this.now();
    try {
      this.db.run(
        `INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
        id, type, JSON.stringify(payload), opts.maxAttempts ?? 5, t + (opts.delayMs ?? 0), opts.dedupeKey ?? null, new Date(t).toISOString(), new Date(t).toISOString(),
      );
      return id;
    } catch (e) {
      if (opts.dedupeKey && /UNIQUE/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  /** Marks due jobs as running (attempts incremented) and returns them. Also releases locks left by a crashed worker. */
  claimDue(limit = 10): Job[] {
    const t = this.now();
    return this.db.tx(() => {
      // A crashed worker leaves jobs 'running'. Re-queue them, unless a newer job with the same dedupe key is already waiting.
      for (const s of this.db.all<{ id: string; dedupe_key: string | null }>(`SELECT id, dedupe_key FROM jobs WHERE status = 'running' AND locked_at < ?`, t - STALE_LOCK_MS)) {
        const superseded = s.dedupe_key && this.db.get(`SELECT 1 FROM jobs WHERE dedupe_key = ? AND status = 'queued'`, s.dedupe_key);
        this.db.run(`UPDATE jobs SET status = ?, last_error = ? WHERE id = ?`, superseded ? 'dead' : 'queued', superseded ? 'superseded by a newer job' : 'worker lost', s.id);
      }
      const rows = this.db.all<JobRow>(`SELECT id, type, payload_json, attempts, max_attempts FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, rowid LIMIT ?`, t, limit);
      for (const r of rows) this.db.run(`UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`, t, new Date(t).toISOString(), r.id);
      return rows.map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload_json), attempts: r.attempts + 1, maxAttempts: r.max_attempts }));
    });
  }

  complete(id: string): void {
    this.db.run(`UPDATE jobs SET status = 'done', locked_at = NULL, updated_at = ? WHERE id = ?`, new Date(this.now()).toISOString(), id);
  }

  /** Re-queues with backoff, or dead-letters when attempts are exhausted or the failure is permanent. */
  fail(job: Job, error: unknown): 'retry' | 'dead' {
    const t = this.now();
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const dead = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
    this.db.run(
      `UPDATE jobs SET status = ?, run_at = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
      dead ? 'dead' : 'queued', dead ? t : t + retryDelayMs(job.attempts), message, new Date(t).toISOString(), job.id,
    );
    return dead ? 'dead' : 'retry';
  }
}

export type JobHandler = (payload: any, job: Job) => Promise<void>;

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private queue: JobQueue,
    private handlers: Record<string, JobHandler>,
    private log: Logger,
  ) {}

  /** Processes everything currently due. Returns the number of jobs attempted. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = this.queue.claimDue();
      for (const job of jobs) {
        const handler = this.handlers[job.type];
        try {
          if (!handler) throw new PermanentJobError(`No handler for job type ${job.type}`);
          await handler(job.payload, job);
          this.queue.complete(job.id);
        } catch (e) {
          const outcome = this.queue.fail(job, e);
          this.log.warn('job failed', { jobId: job.id, type: job.type, attempt: job.attempts, outcome, error: (e as Error).message });
        }
      }
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  start(pollMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error('worker tick failed', { error: String(e) })), pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
