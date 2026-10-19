import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { badRequest, parse } from '../errors.js';

/** Reads and validates a JSON body. With `optional`, an empty body is treated as `{}`. */
export async function bodyOf<T>(c: Context, schema: ZodType<T>, opts: { optional?: boolean } = {}): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (opts.optional) return parse(schema, {});
    throw badRequest('INVALID_JSON', 'A JSON request body is required');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest('INVALID_JSON', 'Request body must be valid JSON');
  }
  return parse(schema, raw);
}

export const queryOf = <T>(c: Context, schema: ZodType<T>): T => parse(schema, c.req.query());
