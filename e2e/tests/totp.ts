import { createHmac } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the browser tests: the app shows the setup key, the test plays the authenticator.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) (out.push((value >>> (bits - 8)) & 255), (bits -= 8));
  }
  return Buffer.from(out);
}

export function totp(secret: string, atMs = Date.now()): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}
