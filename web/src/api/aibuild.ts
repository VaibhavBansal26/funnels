import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './client';

export type StageStatus = 'pending' | 'running' | 'done' | 'fallback' | 'failed' | 'skipped';
export interface BuildStage { id: string; label: string; status: StageStatus; detail?: string; attempts?: number }
export interface BuildCheck { id: string; status: 'pass' | 'fail' | 'warn'; step?: string; detail: string }
export interface BuildStepInfo { key: string; stepId: string; name: string; kind: string }
export interface Build {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  provider: string;
  model: string | null;
  source: 'model' | 'heuristic' | 'fallback' | null;
  funnelId: string | null;
  stages: BuildStage[];
  assumptions: string[];
  usage: { inputTokens: number; outputTokens: number; calls: number };
  degraded: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  completedAt: string | null;
  // detail
  prompt?: string;
  strategy?: { funnelType: string; rationale: string; steps: { key: string; kind: string; name: string; primary: string }[]; templates: { slug: string; name: string; score: number; reason: string }[] } | null;
  report?: { ok: boolean; checks: BuildCheck[]; repairs: string[]; fallbacks?: { stage: string; reason: string }[]; injectionSuspected?: boolean; copySource?: Record<string, string> } | null;
  steps?: BuildStepInfo[];
  products?: { slot: string; name: string; amount: number; currency: string; productId?: string }[];
}

export const isActive = (b?: Build) => !!b && (b.status === 'queued' || b.status === 'running');
export const buildKey = (id: string) => ['ai-build', id] as const;

/**
 * Live view of a generation: the SSE stream pushes `ai.build` events (the workspace stream of Settings > notifications), and a slow poll covers a stream that
 * is blocked or reconnecting, so a refresh or a dropped connection never loses the build (the record lives on the server).
 */
export function useBuild(id: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: buildKey(id ?? ''), enabled: !!id,
    queryFn: () => api.get<Build>(`/api/ai/builds/${id}`),
    refetchInterval: (query) => (isActive(query.state.data) || !query.state.data ? 2500 : false),
  });
  const active = !id ? false : isActive(q.data) || !q.data;
  useEffect(() => {
    if (!id || !active || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const { ticket } = await api.post<{ ticket: string }>('/api/events/ticket');
        if (stopped) return;
        source = new EventSource(`/api/events/stream?ticket=${encodeURIComponent(ticket)}`);
        source.addEventListener('ai.build', (e) => {
          const d = JSON.parse((e as MessageEvent<string>).data) as { id: string; status: Build['status']; stages?: BuildStage[] };
          if (d.id !== id) return;
          qc.setQueryData<Build | undefined>(buildKey(id), (old) => (old ? { ...old, status: d.status, stages: d.stages ?? old.stages } : old));
          if (d.status !== 'running') void qc.invalidateQueries({ queryKey: buildKey(id) });
        });
        source.onerror = () => { source?.close(); if (!stopped) timer = setTimeout(() => void connect(), 5000); };
      } catch {
        if (!stopped) timer = setTimeout(() => void connect(), 10_000);
      }
    };
    void connect();
    return () => { stopped = true; source?.close(); if (timer) clearTimeout(timer); };
  }, [id, active, qc]);
  return q;
}

const KEY = 'funnels.ai.build';
export const savedBuildId = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const saveBuildId = (id: string | null): void => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage unavailable: no resume after a refresh */ } };
