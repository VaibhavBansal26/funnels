// Pure block model: shared by the server and by the web builder (via a Vite alias). Only imports zod.
export * from './schema.js';
export * from './render.js';
export * from './defaults.js';
export { sanitizeHtml } from './sanitize.js';
export { safeUrl, safeColor, parseVideoUrl, esc } from './safe.js';
