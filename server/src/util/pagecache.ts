export interface CachedPage {
  html: string;
  checksum: string;
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

  invalidate(stepIds: string[]): void {
    for (const id of stepIds) this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
