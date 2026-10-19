import { createHash } from 'node:crypto';
import { type KeyBy, type Policy, type Principal, SUBJECT_MAX } from './types.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** IPv4 as is; IPv4-mapped IPv6 unwrapped; other IPv6 reduced to its /64 (one household or hosting account must not get 2^64 buckets). */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip || 'unknown';
  const dbl = ip.indexOf('::');
  let parts: string[];
  if (dbl >= 0) {
    const head = ip.slice(0, dbl).split(':').filter(Boolean);
    const tail = ip.slice(dbl + 2).split(':').filter(Boolean);
    parts = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else parts = ip.split(':');
  if (parts.length !== 8) return ip.slice(0, 45);
  ip = parts.slice(0, 4).map((p) => p.replace(/^0+(?=.)/, '')).join(':');
  return `${ip}::/64`;
}

const FIELD: Record<Exclude<KeyBy, 'ip' | 'composite'>, [keyof Principal, string]> = {
  user: ['userId', 'usr'],
  workspace: ['workspaceId', 'ws'],
  apiKey: ['apiKey', 'key'],
  visitor: ['visitorId', 'vis'],
  socket: ['socketId', 'sock'],
};

const part = (field: keyof Principal, p: Principal): string => (field === 'ip' ? normalizeIp(p.ip) : hash(String(p[field] ?? '')));

/**
 * The limiter key ("subject") for a policy and principal. IPs stay readable (an operator has to be able to block one); every other
 * identifier is hashed, so no email, user id, visitor id or API key appears in Redis keys, logs or metrics. Length is bounded; `}`
 * can never appear (it would end the Redis Cluster hash tag).
 */
export function subjectFor(policy: Pick<Policy, 'keyBy' | 'composite'>, p: Principal): string {
  let s: string;
  if (policy.keyBy === 'ip') s = `ip:${normalizeIp(p.ip)}`;
  else if (policy.keyBy === 'composite') s = `cmp:${(policy.composite ?? ['ip']).map((f) => part(f, p)).join('|')}`;
  else {
    const [field, tag] = FIELD[policy.keyBy];
    s = `${tag}:${hash(String(p[field] ?? 'anonymous'))}`;
  }
  s = s.replace(/[{}]/g, '_');
  return s.length > SUBJECT_MAX ? `h:${hash(s)}` : s;
}

export const hashId = hash;
