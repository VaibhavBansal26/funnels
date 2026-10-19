import { EventEmitter } from 'node:events';

export interface BusEvent {
  type: string;
  data: unknown;
}

/** In-process pub/sub keyed by workspace; feeds the SSE stream. */
export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0);

  publish(workspaceId: string, event: BusEvent): void {
    this.emitter.emit(workspaceId, event);
  }

  subscribe(workspaceId: string, fn: (e: BusEvent) => void): () => void {
    this.emitter.on(workspaceId, fn);
    return () => this.emitter.off(workspaceId, fn);
  }
}
