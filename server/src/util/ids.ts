import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * App-generated text ids (portable between SQLite and PostgreSQL). They sort by creation time within a process
 * (base-36 millisecond clock + counter, then random bytes), so `ORDER BY created_at, id` is a stable
 * insertion-order tiebreak on both engines, which replaces SQLite's implicit `rowid`.
 */
export const newId = (prefix: string): string => {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    if (++seq > 0xfff) {
      ms++;
      seq = 0;
    }
  } else seq = 0;
  lastMs = ms;
  return `${prefix}_${ms.toString(36).padStart(9, '0')}${seq.toString(36).padStart(3, '0')}${randomBytes(6).toString('base64url')}`;
};
export const newToken = (bytes = 24): string => randomBytes(bytes).toString('base64url');
