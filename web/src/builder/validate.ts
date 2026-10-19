import { BlockSchema, type Block } from '@blocks';

interface Issue {
  code?: string;
  path: PropertyKey[];
  message: string;
  errors?: Issue[][];
}

/** Flattens zod issues. A union issue carries one error list per member; the member whose `type` literal matched is the relevant one. */
function collect(issues: Issue[], prefix: PropertyKey[], out: Record<string, string>): void {
  for (const i of issues) {
    const path = [...prefix, ...i.path];
    if (i.code === 'invalid_union' && i.errors) {
      const branch = i.errors.find((b) => !b.some((x) => x.path.length === 1 && x.path[0] === 'type'));
      if (branch) collect(branch, path, out);
      continue;
    }
    out[path.map(String).join('.')] ??= i.message;
  }
}

/** Field-level problems for one block, keyed by dotted path (e.g. "fields.1.id"), using the same schema the server enforces. */
export function blockErrors(block: Block): Record<string, string> {
  const r = BlockSchema.safeParse(block);
  if (r.success) return {};
  const out: Record<string, string> = {};
  collect(r.error.issues as unknown as Issue[], [], out);
  if (!Object.keys(out).length) out[''] = 'This block has invalid settings';
  return out;
}
