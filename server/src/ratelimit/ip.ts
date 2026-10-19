import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

/** Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). Review when Cloudflare announces changes; override with CF_IP_RANGES. */
export const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const kind = isIP(ip);
  if (kind === 4) return { v: 4, n: ip.split('.').reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n) };
  if (kind !== 6) return null;
  const dbl = ip.indexOf('::');
  const head = (dbl >= 0 ? ip.slice(0, dbl) : ip).split(':').filter(Boolean);
  const tail = dbl >= 0 ? ip.slice(dbl + 2).split(':').filter(Boolean) : [];
  const parts = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return { v: 6, n: parts.reduce((a, h) => (a << 16n) | BigInt(parseInt(h, 16)), 0n) };
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const a = toBig(ip);
  const b = toBig(base!);
  if (!a || !b || a.v !== b.v) return false;
  const total = a.v === 4 ? 32n : 128n;
  const shift = total - BigInt(bitsRaw ?? total.toString());
  return a.n >> shift === b.n >> shift;
}

export interface IpConfig {
  TRUST_PROXY: boolean;
  /** How many reverse-proxy hops in front of the app append to X-Forwarded-For (only with TRUST_PROXY). */
  TRUSTED_PROXY_HOPS?: number;
  CF_ORIGIN_SECRET?: string;
  /** Believe CF-Connecting-IP when the TCP peer is inside Cloudflare's published ranges (a peer address cannot be spoofed). */
  TRUST_CLOUDFLARE_RANGES?: boolean;
  CF_IP_RANGES?: string[];
}

type Ctx = { req: { header(n: string): string | undefined }; env?: unknown };

const peerOf = (c: Ctx): string | undefined => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;

/**
 * The client address used as a rate limit key. Trust ladder, strongest first:
 *  1. CF-Connecting-IP when the request proves it came through our Cloudflare zone (shared origin secret header, constant-time compare)
 *     or when the TCP peer address is in Cloudflare's ranges;
 *  2. X-Forwarded-For, counting TRUSTED_PROXY_HOPS entries from the right (the left side is client-controlled), only with TRUST_PROXY;
 *  3. the TCP peer address.
 * Spoofed CF-Connecting-IP / X-Forwarded-For headers from anyone else are ignored.
 */
export function clientIp(c: Ctx, cfg: IpConfig): string {
  const peer = peerOf(c);
  const cf = c.req.header('cf-connecting-ip')?.trim();
  if (cf && isIP(cf)) {
    const secret = cfg.CF_ORIGIN_SECRET;
    const given = c.req.header('x-cf-origin-secret');
    if (secret && given && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return cf;
    if (cfg.TRUST_CLOUDFLARE_RANGES !== false && peer && (cfg.CF_IP_RANGES ?? CLOUDFLARE_RANGES).some((r) => inCidr(peer, r))) return cf;
  }
  if (cfg.TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) {
      const hops = fwd.split(',').map((s) => s.trim()).filter(Boolean);
      const pick = hops[Math.max(0, hops.length - (cfg.TRUSTED_PROXY_HOPS ?? 1))];
      if (pick && isIP(pick)) return pick;
    }
  }
  return peer ?? 'unknown';
}
