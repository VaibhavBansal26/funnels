import { createHash } from 'node:crypto';
import type { Context } from 'hono';

/** JSON with a weak ETag over the body: `If-None-Match` gets a 304 and the browser keeps using its copy. Private (answers depend on the caller's session), revalidated on every use. */
export function jsonWithEtag(c: Context, body: unknown, cache = 'private, max-age=0, must-revalidate'): Response {
  const text = JSON.stringify(body);
  const etag = `W/"${createHash('sha1').update(text).digest('base64url').slice(0, 27)}"`;
  const inm = c.req.header('if-none-match');
  if (inm && inm.split(',').some((v) => v.trim() === etag || v.trim() === `"${etag.slice(3)}`)) return c.body(null, 304, { etag, 'cache-control': cache });
  return c.body(text, 200, { 'content-type': 'application/json; charset=UTF-8', etag, 'cache-control': cache });
}
