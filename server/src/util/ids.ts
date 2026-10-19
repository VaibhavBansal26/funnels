import { randomBytes } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const newToken = (bytes = 24): string => randomBytes(bytes).toString('base64url');
