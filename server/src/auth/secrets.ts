import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * Encryption of small secrets at rest (TOTP seeds): AES-256-GCM with a key derived (HKDF-SHA-256) from DATA_ENCRYPTION_KEY, or from JWT_SECRET when that is
 * not set. Prefer a dedicated DATA_ENCRYPTION_KEY: rotating JWT_SECRET (which ends sessions) must not make every stored TOTP seed unreadable.
 * Format `v1.<iv>.<tag>.<ciphertext>`, base64url.
 */
const key = (config: Config) => Buffer.from(hkdfSync('sha256', config.DATA_ENCRYPTION_KEY ?? config.JWT_SECRET, 'funnels', 'data-encryption-v1', 32));

export function encryptSecret(config: Config, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(config), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(config: Config, packed: string): string {
  const [v, iv, tag, ct] = packed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key(config), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
