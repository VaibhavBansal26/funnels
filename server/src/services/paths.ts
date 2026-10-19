/** Step path rules. The regex is the legacy product's; see docs/MIGRATION-NOTES.md for its quirks. */
export const PATH_RE = /^\/([a-zA-Z0-9-]|%[0-9A-Fa-f]{2})*([^/.]\/?)?$/;
export const MAX_PATH_LENGTH = 200;

export const isValidPath = (p: unknown): p is string => typeof p === 'string' && p.length <= MAX_PATH_LENGTH && PATH_RE.test(p);

/** Comparison key: case-insensitive, trailing slash ignored (except for the root). */
export function pathKey(p: string): string {
  const lower = p.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

export function slugPath(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `/${slug || 'page'}`;
}

/** Up to `count` free `/path-NNNN` alternatives, deterministic (counting up from 1001). `taken` holds path keys. */
export function suggestPaths(path: string, taken: Set<string>, count = 3): string[] {
  const base = pathKey(path) === '/' ? '/page' : path.replace(/\/$/, '').slice(0, MAX_PATH_LENGTH - 5);
  const out: string[] = [];
  for (let n = 1001; n <= 9999 && out.length < count; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(pathKey(candidate))) out.push(candidate);
  }
  return out;
}

/** "A" -> "A copy" -> "A copy 2" ... based on the root name, skipping names already in use (case-insensitive). */
export function copyName(name: string, existing: string[]): string {
  const root = name.replace(/ copy( \d+)?$/i, '');
  const used = new Set(existing.map((n) => n.toLowerCase()));
  let candidate = `${root} copy`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${root} copy ${n}`;
  return candidate;
}

/** "Lead Magnet" -> "Lead Magnet 2" ... used when a template is cloned into a workspace. */
export function uniqueName(name: string, existing: string[]): string {
  const used = new Set(existing.map((n) => n.toLowerCase()));
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

export function copyPath(path: string, taken: Set<string>): string {
  const base = path.replace(/\/$/, '') || '/page';
  let candidate = `${base}-copy`;
  for (let n = 2; taken.has(pathKey(candidate)); n++) candidate = `${base}-copy-${n}`;
  return candidate;
}
