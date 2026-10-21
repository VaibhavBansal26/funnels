import { blake3 } from '@noble/hashes/blake3';

/**
 * The content hash Cloudflare Pages Direct Upload uses to name an asset: the first 32 hex characters of BLAKE3 over the UTF-8 text `base64(content) + extension`
 * (extension without the dot, empty when there is none). This is not in the REST reference; it is what Wrangler's `hashFile` does, which is the only client the
 * upload endpoints are designed for:
 *   https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/pages/hash.ts
 * A wrong hash is not an error: the upload is accepted and the file is simply never served, so scripts/cf-pages-smoke.ts fetches a page after a deploy to prove it.
 */
export function pagesHash(bytes: Uint8Array, filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = filePath.lastIndexOf('/');
  const ext = dot > slash ? filePath.slice(dot + 1) : '';
  const text = Buffer.from(bytes).toString('base64') + ext;
  return Buffer.from(blake3(new TextEncoder().encode(text))).toString('hex').slice(0, 32);
}
