import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { newId } from '../util/ids.js';

/**
 * Image uploads for the page builder. Deliberately small and strict: raster formats only (the type is decided from the file's bytes, never
 * from the filename or the request header, and SVG is refused because it can carry script), 1.5 MB per file, 200 files per workspace.
 * Files are served from /uploads/:id/:name with a sandboxing CSP and nosniff, so even a polyglot file could not run in a browser.
 */
export const MAX_ASSET_BYTES = 1_500_000;
export const MAX_ASSETS = 200;

const SIGNATURES: { mime: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

export const sniffImage = (bytes: Uint8Array) => SIGNATURES.find((s) => s.test(bytes)) ?? null;

/** A URL-safe file name: letters, digits, dot, dash and underscore only, with the extension of the sniffed type. */
export function safeAssetName(original: string, ext: string): string {
  const base = original.replace(/\.[A-Za-z0-9]{1,5}$/, '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return `${base}.${ext}`;
}

const serialize = (a: { id: string; name: string; mime: string; size: number; created_at: string }) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, url: `/uploads/${a.id}/${a.name}`, createdAt: a.created_at });

export async function listAssets(deps: Deps, ws: string) {
  const rows = await deps.db.all<{ id: string; name: string; mime: string; size: number; created_at: string }>('SELECT id, name, mime, size, created_at FROM assets WHERE workspace_id = ? ORDER BY created_at DESC, id DESC', ws);
  return { data: rows.map(serialize), limits: { maxBytes: MAX_ASSET_BYTES, maxFiles: MAX_ASSETS } };
}

export async function uploadAsset(deps: Deps, auth: Auth, file: { name: string; bytes: Uint8Array }) {
  const ws = auth.workspaceId;
  if (file.bytes.length === 0) throw badRequest('EMPTY_FILE', 'The file is empty');
  if (file.bytes.length > MAX_ASSET_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', `Images may be at most ${Math.round(MAX_ASSET_BYTES / 1000)} KB`);
  const type = sniffImage(file.bytes);
  if (!type) throw new AppError(415, 'UNSUPPORTED_MEDIA', 'Only PNG, JPEG, GIF and WebP images can be uploaded');
  if ((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM assets WHERE workspace_id = ?', ws))!.n >= MAX_ASSETS) throw new AppError(409, 'LIMIT_REACHED', `A workspace can store at most ${MAX_ASSETS} images`);
  const id = newId('ast');
  const name = safeAssetName(file.name, type.ext);
  const at = deps.now().toISOString();
  await deps.db.run('INSERT INTO assets (id, workspace_id, name, mime, size, data_b64, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ws, name, type.mime, file.bytes.length, Buffer.from(file.bytes).toString('base64'), auth.userId, at);
  return serialize({ id, name, mime: type.mime, size: file.bytes.length, created_at: at });
}

export async function deleteAsset(deps: Deps, ws: string, id: string): Promise<void> {
  if ((await deps.db.run('DELETE FROM assets WHERE workspace_id = ? AND id = ?', ws, id)).changes === 0) throw notFound('Image');
}

/** Public read. The workspace is irrelevant here: ids are unguessable and files are meant to be embedded in published pages. */
export async function readAsset(deps: Deps, id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const row = await deps.db.get<{ mime: string; data_b64: string }>('SELECT mime, data_b64 FROM assets WHERE id = ?', id);
  return row ? { mime: row.mime, bytes: Buffer.from(row.data_b64, 'base64') } : null;
}
