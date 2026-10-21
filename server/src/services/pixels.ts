import { z } from 'zod';
import { PixelSettings, PROVIDERS, resolvePixels, type PixelSettingsT } from '../ads/pixelConfig.js';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { requireFunnel, requireStep } from '../repos/funnels.js';
import { audit } from './audit.js';
import { loadPixelLevels } from './adtags.js';
import { regenerateFunnel, regenerateWorkspace } from './pages.js';

export const PixelScope = z.enum(['workspace', 'funnel', 'step']);
export type PixelScopeT = z.infer<typeof PixelScope>;
export { PixelSettings };

/** Stored settings of one level, plus what the page actually gets after the three levels are combined. */
export async function getPixels(deps: Deps, ws: string, scope: PixelScopeT, funnelId: string | null, stepId: string | null) {
  if (funnelId) await requireFunnel(deps.db, ws, funnelId);
  if (funnelId && stepId) await requireStep(deps.db, ws, funnelId, stepId);
  const scopeId = scope === 'workspace' ? ws : scope === 'funnel' ? funnelId! : stepId!;
  const row = await deps.db.get<{ config_json: string }>('SELECT config_json FROM ad_pixel_configs WHERE workspace_id = ? AND scope = ? AND scope_id = ?', ws, scope, scopeId);
  let config: PixelSettingsT | null = null;
  if (row) {
    const parsed = PixelSettings.safeParse(JSON.parse(row.config_json));
    config = parsed.success ? parsed.data : null;
  }
  let effective = null;
  if (funnelId) {
    const levels = await loadPixelLevels(deps, ws, funnelId);
    effective = resolvePixels([levels.workspace, levels.funnel, stepId ? levels.steps.get(stepId) : undefined]);
  }
  return { scope, config, effective };
}

export async function setPixels(deps: Deps, auth: Auth, scope: PixelScopeT, funnelId: string | null, stepId: string | null, config: PixelSettingsT, ip: string | null) {
  const ws = auth.workspaceId;
  if (funnelId) await requireFunnel(deps.db, ws, funnelId);
  if (funnelId && stepId) await requireStep(deps.db, ws, funnelId, stepId);
  const scopeId = scope === 'workspace' ? ws : scope === 'funnel' ? funnelId! : stepId!;
  const empty = Object.keys(config).length === 0;
  if (empty) await deps.db.run('DELETE FROM ad_pixel_configs WHERE workspace_id = ? AND scope = ? AND scope_id = ?', ws, scope, scopeId);
  else {
    const at = deps.now().toISOString();
    await deps.db.run(
      `INSERT INTO ad_pixel_configs (workspace_id, scope, scope_id, config_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, scope, scope_id) DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ws, scope, scopeId, JSON.stringify(config), auth.userId, at,
    );
  }
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'pixels.updated', target: scopeId, detail: { scope, providers: PROVIDERS.filter((p) => (config as Record<string, unknown>)[p]), consent: config.consent?.enabled ?? null }, ip });
  // Pixels are part of the rendered page: re-render what the change touches (and purge the edge cache).
  if (scope === 'workspace') await regenerateWorkspace(deps, ws);
  else await regenerateFunnel(deps, ws, funnelId!);
  return getPixels(deps, ws, scope, funnelId, stepId);
}
