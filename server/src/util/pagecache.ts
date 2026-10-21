export interface CachedPage {
  html: string;
  checksum: string;
  /** Content-Security-Policy of a page served from the app's own origin (built-in addresses); filled on first use. */
  csp?: { policy: string; sandboxed: boolean };
}

/** Tiny in-memory cache of rendered step HTML. Writers invalidate explicitly, so serving never returns stale content. */
export class PageCache {
  private map = new Map<string, CachedPage>();
  constructor(private max = 500) {}

  get(stepId: string): CachedPage | undefined {
    const hit = this.map.get(stepId);
    if (hit) {
      this.map.delete(stepId);
      this.map.set(stepId, hit);
    }
    return hit;
  }

  set(stepId: string, page: CachedPage): void {
    this.map.set(stepId, page);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  /** Called after local invalidation, so other layers (the shared single-flight results) can drop their copy too. */
  onInvalidate?: (stepIds: string[]) => void;

  invalidate(stepIds: string[]): void {
    for (const id of stepIds) this.map.delete(id);
    this.onInvalidate?.(stepIds);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
