import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import type { ProjectDoc } from '../pagemodel/doc.js';
import type { TemplateProduct } from '../templates/types.js';

export const BindingsInput = z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.union([z.object({ priceId: z.string().max(64) }), z.object({ create: z.literal(true) })]));

export async function bindTemplateProducts(_deps: Deps, _auth: Auth, _slots: TemplateProduct[], docs: ProjectDoc[], _bindings: z.infer<typeof BindingsInput>): Promise<ProjectDoc[]> {
  return docs;
}
