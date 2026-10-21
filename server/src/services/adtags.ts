import { PixelSettings, resolvePixels, type EffectivePixels, type PixelSettingsT } from '../ads/pixelConfig.js';
import { renderAdTags, type AdProduct, type AdTags } from '../ads/snippets.js';
import type { Deps } from '../deps.js';
import type { ProjectDoc } from '../pagemodel/doc.js';

/** The stored pixel settings that apply to one funnel: workspace default, the funnel's own, and one row per step. */
export interface PixelLevels {
  workspace: PixelSettingsT | null;
  funnel: PixelSettingsT | null;
  steps: Map<string, PixelSettingsT>;
}

const parse = (json: string): PixelSettingsT | null => {
  try {
    const r = PixelSettings.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
};

export async function loadPixelLevels(deps: Pick<Deps, 'db'>, ws: string, funnelId: string): Promise<PixelLevels> {
  const rows = await deps.db.all<{ scope: string; scope_id: string; config_json: string }>(
    `SELECT scope, scope_id, config_json FROM ad_pixel_configs
     WHERE workspace_id = ? AND (scope = 'workspace' OR (scope = 'funnel' AND scope_id = ?) OR (scope = 'step' AND scope_id IN (SELECT id FROM steps WHERE funnel_id = ? AND workspace_id = ?)))`,
    ws, funnelId, funnelId, ws,
  );
  const levels: PixelLevels = { workspace: null, funnel: null, steps: new Map() };
  for (const r of rows) {
    const cfg = parse(r.config_json);
    if (!cfg) continue;
    if (r.scope === 'workspace') levels.workspace = cfg;
    else if (r.scope === 'funnel') levels.funnel = cfg;
    else levels.steps.set(r.scope_id, cfg);
  }
  return levels;
}

export const effectivePixels = (levels: PixelLevels, stepId: string): EffectivePixels => resolvePixels([levels.workspace, levels.funnel, levels.steps.get(stepId)]);

/** The catalogue of a step for the pixels: the products its checkouts sell (derived by the server on save, never sent by a client). */
export function productsOf(doc: Pick<ProjectDoc, 'products'> | null): AdProduct[] {
  return (doc?.products ?? []).map((p) => {
    const x = p as unknown as { id: string; productName: string; price: number; currency: string; orderBump?: boolean; oneClickUpsell?: boolean };
    return { id: String(x.id), name: String(x.productName ?? ''), price: Number(x.price) || 0, currency: String(x.currency ?? 'USD').toUpperCase(), bump: !!x.orderBump, upsell: !!x.oneClickUpsell };
  });
}

export function adTagsFor(levels: PixelLevels, funnelId: string, stepId: string, doc: Pick<ProjectDoc, 'products'> | null, mode: 'live' | 'preview'): AdTags | null {
  return renderAdTags(effectivePixels(levels, stepId), { funnelId, stepId, mode, products: productsOf(doc) });
}

/** Convenience for a single step (save, insert, preview). */
export async function adTagsForStep(deps: Pick<Deps, 'db'>, ws: string, funnelId: string, stepId: string, doc: Pick<ProjectDoc, 'products'> | null, mode: 'live' | 'preview' = 'live'): Promise<string | undefined> {
  return adTagsFor(await loadPixelLevels(deps, ws, funnelId), funnelId, stepId, doc, mode)?.html;
}
