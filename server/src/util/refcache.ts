/**
 * Short-lived positive cache of "this (funnel, step) exists, is not trashed, and belongs to this workspace" for the public events endpoint, so a beacon does not cost
 * two database reads. Only positive answers are cached (an unknown id is re-checked every time, so a new funnel works immediately). Trash, purge and step deletion
 * clear it through `PageCache.onInvalidate` on the same process; other replicas keep a stale positive for at most `ttlMs`, during which they still accept events for a
 * funnel that was just trashed (harmless: the rows are written under the funnel's own workspace, and a purged funnel's rows are dropped at write time).
 */
export class RefCache {
  private map = new Map<string, { ws: string; until: number }>();
  constructor(private ttlMs: number, private max = 50_000) {}

  get(funnelId: string, stepId: string): string | undefined {
    const k = `${funnelId}:${stepId}`;
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (hit.until < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    return hit.ws;
  }

  set(funnelId: string, stepId: string, workspaceId: string): void {
    if (this.ttlMs <= 0) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(`${funnelId}:${stepId}`, { ws: workspaceId, until: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
