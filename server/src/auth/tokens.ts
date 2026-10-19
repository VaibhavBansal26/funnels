import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../config.js';

export type TokenUse = 'access' | 'preview' | 'sse';

const key = (config: Config) => new TextEncoder().encode(config.JWT_SECRET);

async function sign(config: Config, use: TokenUse, claims: Record<string, string>, ttlSeconds: number, now: Date, subject?: string) {
  const iat = Math.floor(now.getTime() / 1000);
  let jwt = new SignJWT({ ...claims, use }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(iat).setExpirationTime(iat + ttlSeconds);
  if (subject) jwt = jwt.setSubject(subject);
  return jwt.sign(key(config));
}

async function verify(config: Config, token: string, use: TokenUse, now: Date) {
  const { payload } = await jwtVerify(token, key(config), { algorithms: ['HS256'], currentDate: now });
  if (payload.use !== use) throw new Error('wrong token use');
  return payload;
}

export const signAccessToken = (config: Config, userId: string, now: Date) =>
  sign(config, 'access', {}, config.ACCESS_TOKEN_TTL_SECONDS, now, userId);

export async function verifyAccessToken(config: Config, token: string, now: Date): Promise<{ userId: string } | null> {
  try {
    const p = await verify(config, token, 'access', now);
    return typeof p.sub === 'string' ? { userId: p.sub } : null;
  } catch {
    return null;
  }
}

/** Short-lived token that lets the holder view one funnel's preview pages. */
export const signPreviewToken = (config: Config, workspaceId: string, funnelId: string, now: Date) =>
  sign(config, 'preview', { wid: workspaceId, fid: funnelId }, config.PREVIEW_TOKEN_TTL_SECONDS, now);

export async function verifyPreviewToken(config: Config, token: string, funnelId: string, now: Date): Promise<{ workspaceId: string } | null> {
  try {
    const p = await verify(config, token, 'preview', now);
    return p.fid === funnelId && typeof p.wid === 'string' ? { workspaceId: p.wid } : null;
  } catch {
    return null;
  }
}

/** Ticket for EventSource, which cannot send an Authorization header. */
export const signStreamTicket = (config: Config, userId: string, now: Date) => sign(config, 'sse', {}, 60, now, userId);

export async function verifyStreamTicket(config: Config, token: string, now: Date): Promise<string | null> {
  try {
    const p = await verify(config, token, 'sse', now);
    return typeof p.sub === 'string' ? p.sub : null;
  } catch {
    return null;
  }
}
