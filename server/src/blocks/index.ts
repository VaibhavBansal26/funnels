// Legacy block document model (version 1): the schema that guards the old input path (API clients, the AI generator, templates exported
// before the GrapesJS builder) plus its builders. Pages are rendered from GrapesJS project data (src/pagemodel); a block document is only
// ever converted (src/pagemodel/convert.ts), never rendered.
export * from './schema.js';
export * from './defaults.js';
export { safeUrl, safeColor, parseVideoUrl, esc } from './safe.js';
