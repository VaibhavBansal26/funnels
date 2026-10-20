import type { TemplateDef } from '../types.js';
import { templates as classic } from './classic.js';
import { templates as growth } from './growth.js';
import { templates as local } from './local.js';
import { templates as sales } from './sales.js';

/** Every built-in template, in gallery order within a category. Add a file to `library/`, export `templates`, and list it here. */
export const LIBRARY: TemplateDef[] = [...classic, ...sales, ...growth, ...local];
