import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';

/**
 * Encryption of the analytics identity pepper at rest with DATA_ENCRYPTION_KEY (auth/secrets.ts does the same for TOTP seeds with a v1 format).
 *
 * Stored form: `enc2.<keyId>.<base64url(iv | tag | ciphertext)>`; keyId is the first 8 hex characters of SHA-256 over the derived key, so a reader knows
 * which key to use and a rotation can keep the old one (DATA_ENCRYPTION_KEY_PREVIOUS) while rows are re-encrypted on their next read. AES-256-GCM; the
 * additional authenticated data (`pepper:<workspaceId>`) ties a ciphertext to its row. A value WITHOUT the prefix is the plaintext that earlier versions
 * stored: it is read as is and encrypted on that read.
 *
 * In production the key is required (the pepper is refused with 503 DATA_ENCRYPTION_KEY_REQUIRED without it); in development and tests a key is derived
 * from JWT_SECRET, which dies with the secret (the start-up log says so).
 */
export interface DataKeyConfig {
  NODE_ENV: string;
  JWT_SECRET: string;
  DATA_ENCRYPTION_KEY?: string | undefined;
  DATA_ENCRYPTION_KEY_PREVIOUS?: string | undefined;
}

interface Key {
  id: string;
  key: Buffer;
}
const derive = (material: string, info: string): Key => {
  const key = Buffer.from(hkdfSync('sha256', material, 'funnels', info, 32));
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
};

/** The active key (null when none may be used: production without DATA_ENCRYPTION_KEY) and the previous keys that may still decrypt. */
export function dataKeys(c: DataKeyConfig): { current: Key | null; previous: Key[]; derived: boolean } {
  const previous = (c.DATA_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => derive(s, 'data-encryption-v2'));
  if (c.DATA_ENCRYPTION_KEY) return { current: derive(c.DATA_ENCRYPTION_KEY, 'data-encryption-v2'), previous, derived: false };
  if (c.NODE_ENV !== 'production') return { current: derive(c.JWT_SECRET, 'data-encryption-v2-dev-derived'), previous, derived: true };
  return { current: null, previous, derived: false };
}

export const keyRequired = () =>
  new AppError(503, 'DATA_ENCRYPTION_KEY_REQUIRED', 'DATA_ENCRYPTION_KEY is not configured. Set it (at least 32 random characters, for example `openssl rand -hex 32`) to use the analytics identity pepper in production.');
export const unreadable = (why: string) =>
  new AppError(409, 'PEPPER_UNREADABLE', `The stored identity pepper cannot be decrypted with the configured keys (${why}). Restore the previous DATA_ENCRYPTION_KEY (or put it in DATA_ENCRYPTION_KEY_PREVIOUS), or set a new pepper with PUT /api/v1/analytics/identity-pepper; exports change when you do.`);

export function encryptWithDataKey(c: DataKeyConfig, plain: string, aad: string): string {
  const { current } = dataKeys(c);
  if (!current) throw keyRequired();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc2.${current.id}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

/** `needsRewrite` is true when the stored value is not under the current key (plaintext, previous key): the caller stores `encryptWithDataKey` of it. */
export function decryptWithDataKey(c: DataKeyConfig, stored: string, aad: string): { plain: string; needsRewrite: boolean } {
  const { current, previous } = dataKeys(c);
  if (!current) throw keyRequired();
  if (!stored.startsWith('enc2.')) return { plain: stored, needsRewrite: true };
  try {
    const [, kid, body] = stored.split('.');
    const k = [current, ...previous].find((x) => x.id === kid);
    if (!k) throw unreadable(`it was encrypted with key ${kid}, which is not configured`);
    const blob = Buffer.from(body ?? '', 'base64url');
    const d = createDecipheriv('aes-256-gcm', k.key, blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    d.setAAD(Buffer.from(aad));
    return { plain: Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8'), needsRewrite: k.id !== current.id };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw unreadable('authentication failed');
  }
}
