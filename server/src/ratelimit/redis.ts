import { createHash } from 'node:crypto';
import { Redis, type RedisOptions } from 'ioredis';
import { ACQUIRE, GCRA, ONCE, WINDOW } from './scripts.js';
import type { GcraArgs, LimitedRecord, PenaltyConfig, Store, StoreResult, Verdict, WindowArgs } from './types.js';

const VERDICTS: Verdict[] = ['allowed', 'limited', 'blocked', 'denied', 'bypassed'];
const LIMITED_MAX = 1000;

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export interface RedisStoreOptions {
  url?: string;
  client?: Redis;
  /** Namespaces every key: app + environment, so several deployments can share a Redis. */
  prefix: string;
  /** Test hook: replace Redis TIME with this clock (ms). Never set in production. */
  clock?: () => number;
  options?: RedisOptions;
}

/** Redis-backed store: one atomic Lua call per decision, EVALSHA with NOSCRIPT recovery (also after SCRIPT FLUSH or a failover to a replica without the scripts). */
export class RedisStore implements Store {
  readonly kind = 'redis' as const;
  readonly client: Redis;
  private shas = new Map<string, string>();
  private clock?: () => number;
  private prefix: string;

  constructor(o: RedisStoreOptions) {
    // Commands wait in ioredis' offline queue only until the first connection is up. After that an outage fails calls immediately
    // (the breaker and the per-policy failure mode take over) instead of piling requests up in memory.
    this.client = o.client ?? new Redis(o.url!, { enableOfflineQueue: true, maxRetriesPerRequest: 1, connectTimeout: 2000, ...o.options });
    this.client.once('ready', () => {
      this.client.options.enableOfflineQueue = false;
    });
    this.prefix = o.prefix;
    this.clock = o.clock;
    // Reconnect errors are surfaced per call (and counted by the circuit breaker); an unhandled 'error' event must not crash the process.
    this.client.on('error', () => undefined);
  }

  /** Preloads the scripts so the first request does not pay for SCRIPT LOAD. Safe to skip: every call recovers from NOSCRIPT. */
  async preload(): Promise<void> {
    for (const s of [GCRA, WINDOW, ACQUIRE, ONCE]) this.shas.set(s, (await this.client.script('LOAD', s)) as string);
  }

  private key(subject: string, suffix: string): string {
    return `${this.prefix}:{${subject}}:${suffix}`;
  }

  private now(): number {
    return this.clock ? this.clock() : 0;
  }

  private async run(script: string, keys: string[], args: (string | number)[]): Promise<number[]> {
    let sha1 = this.shas.get(script);
    if (!sha1) this.shas.set(script, (sha1 = sha(script)));
    try {
      return (await this.client.evalsha(sha1, keys.length, ...keys, ...args.map(String))) as number[];
    } catch (e) {
      if (!/NOSCRIPT/.test((e as Error).message)) throw e;
      const loaded = (await this.client.script('LOAD', script)) as string;
      this.shas.set(script, loaded);
      return (await this.client.evalsha(loaded, keys.length, ...keys, ...args.map(String))) as number[];
    }
  }

  private guardKeys(subject: string, state: string): string[] {
    return [this.key(subject, state), this.key(subject, 'deny'), this.key(subject, 'allow'), this.key(subject, 'pen'), this.key(subject, 'strk'), this.key(subject, 'lvl')];
  }

  private penaltyArgs(p?: PenaltyConfig): (string | number)[] {
    return p ? [1, p.threshold, p.strikeWindowMs, p.decayMs, ...p.stepsMs] : [0, 1, 1, 1, 1];
  }

  private result(r: number[]): StoreResult {
    return { verdict: VERDICTS[r[0]!]!, remaining: r[1]!, resetMs: r[2]!, retryAfterMs: r[3]! };
  }

  async gcra(a: GcraArgs): Promise<StoreResult> {
    return this.result(await this.run(GCRA, this.guardKeys(a.subject, `g:${a.policyId}`), [this.now(), a.emissionMs, a.capacity, a.cost, ...this.penaltyArgs(a.penalty)]));
  }

  async window(a: WindowArgs): Promise<StoreResult> {
    return this.result(
      await this.run(WINDOW, this.guardKeys(a.subject, `w:${a.policyId}`), [this.now(), a.limit, a.windowMs, a.cost, a.mode === 'consume' ? 1 : 0, ...this.penaltyArgs(a.mode === 'consume' ? a.penalty : undefined)]),
    );
  }

  async acquire(subject: string, policyId: string, max: number, ttlMs: number, leaseId: string) {
    const r = await this.run(ACQUIRE, [this.key(subject, `c:${policyId}`)], [this.now(), max, ttlMs, leaseId]);
    return { ok: r[0] === 1, count: r[1]!, retryAfterMs: r[2]! };
  }

  async release(subject: string, policyId: string, leaseId: string): Promise<void> {
    await this.client.zrem(this.key(subject, `c:${policyId}`), leaseId);
  }

  async once(subject: string, policyId: string, token: string, ttlMs: number): Promise<boolean> {
    return ((await this.run(ONCE, [this.key(subject, `i:${policyId}:${sha(token).slice(0, 20)}`)], [ttlMs])) as unknown) === 1;
  }

  private adminKey(name: string): string {
    return `${this.prefix}:{admin}:${name}`;
  }

  async setList(kind: 'allow' | 'deny', subject: string, ttlMs: number | null): Promise<void> {
    const k = this.key(subject, kind);
    if (ttlMs === null) await this.client.set(k, '1');
    else await this.client.set(k, '1', 'PX', ttlMs);
    await this.client.zadd(this.adminKey('lists'), String(ttlMs === null ? 0 : Date.now() + ttlMs), `${kind}|${subject}`);
  }

  async unsetList(kind: 'allow' | 'deny', subject: string): Promise<void> {
    await this.client.del(this.key(subject, kind));
    await this.client.zrem(this.adminKey('lists'), `${kind}|${subject}`);
  }

  async clearPenalty(subject: string): Promise<void> {
    await this.client.del(this.key(subject, 'pen'), this.key(subject, 'strk'), this.key(subject, 'lvl'));
  }

  async recordLimited(policyId: string, subject: string): Promise<void> {
    const k = this.adminKey('limited');
    await this.client.multi().zadd(k, String(Date.now()), `${policyId}|${subject}|${Date.now()}`).zremrangebyrank(k, 0, -(LIMITED_MAX + 1)).exec();
  }

  async limited(max: number): Promise<LimitedRecord[]> {
    const rows = await this.client.zrevrange(this.adminKey('limited'), 0, max - 1, 'WITHSCORES');
    const out: LimitedRecord[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      const [policyId, subject] = rows[i]!.split('|');
      out.push({ policyId: policyId!, subject: subject!, at: Number(rows[i + 1]) });
    }
    return out;
  }

  async lists(): Promise<{ kind: 'allow' | 'deny'; subject: string; ttlMs: number | null }[]> {
    const rows = await this.client.zrange(this.adminKey('lists'), '0', '-1', 'WITHSCORES');
    const out = [];
    for (let i = 0; i < rows.length; i += 2) {
      const [kind, ...rest] = rows[i]!.split('|');
      const subject = rest.join('|');
      const ttl = await this.client.pttl(this.key(subject, kind as string));
      if (ttl === -2) {
        await this.client.zrem(this.adminKey('lists'), rows[i]!);
        continue;
      }
      out.push({ kind: kind as 'allow' | 'deny', subject, ttlMs: ttl === -1 ? null : ttl });
    }
    return out;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }
}
