import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  return nums.every((n, i) => /^\d{1,3}$/.test(parts[i]!) && n >= 0 && n <= 255) ? nums : null;
}

function blockedV4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = parseV4(v4[1]!);
    if (!p) return null;
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and other non-public addresses (v4 and v6). */
export function isBlockedIp(input: string): boolean {
  const ip = input.replace(/^\[|\]$/g, '');
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(parseV4(ip)!);
  if (kind === 6) {
    const g = expandV6(ip);
    if (!g) return true;
    const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedV4(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d
    if (g.slice(0, 6).every((x) => x === 0) && (g[6]! !== 0 || g[7]! > 1)) return blockedV4(embedded(g[6]!, g[7]!)); // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b) return blockedV4(embedded(g[6]!, g[7]!)); // NAT64
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

export type HostLookup = (hostname: string) => Promise<string[]>;

export const systemLookup: HostLookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((r) => r.address);

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

export interface ResolvedTarget {
  url: URL;
  /** The vetted address the connection must use (prevents DNS rebinding between check and connect). */
  address: string;
}

/** Throws SsrfError unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string, lookup: HostLookup = systemLookup): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new SsrfError('Credentials in URLs are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError('Target address is not public');
    return { url, address: host };
  }
  if (BLOCKED_NAMES.test(host) || !host.includes('.')) throw new SsrfError('Target host is not public');
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new SsrfError('Target host could not be resolved');
  }
  if (addresses.length === 0) throw new SsrfError('Target host could not be resolved');
  if (addresses.some(isBlockedIp)) throw new SsrfError('Target resolves to a non-public address');
  return { url, address: addresses[0]! };
}

export interface HttpPost {
  target: ResolvedTarget;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface HttpClient {
  /** Performs one POST. Must never follow redirects; resolves with the status of the first response. */
  post(req: HttpPost): Promise<{ status: number }>;
}

export class NodeHttpClient implements HttpClient {
  post({ target, headers, body, timeoutMs }: HttpPost): Promise<{ status: number }> {
    const { url, address } = target;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          // Connect to the address that was vetted, not a fresh DNS answer.
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            const family = isIP(address);
            if (opts?.all) cb(null, [{ address, family }]);
            else cb(null, address, family);
          }) as never,
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }
}
