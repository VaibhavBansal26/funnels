import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30 s step), the profile every authenticator app implements. No dependency. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32Encode(randomBytes(20)); // 160 bits, the RFC 4226 recommendation

export function hotp(secret: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);
export const totp = (secret: string, ms: number): string => hotp(secret, stepOf(ms));

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the step that matched, or null. The caller must refuse a step that is
 * not greater than the last one it accepted, otherwise the same code works twice.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepOf(nowMs);
  let hit: number | null = null;
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(secret, cur + d));
    if (timingSafeEqual(expected, Buffer.from(code)) && hit === null) hit = cur + d; // no early exit: constant work for every window
  }
  return hit;
}

export const otpauthUri = (issuer: string, account: string, secret: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
