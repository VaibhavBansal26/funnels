import { useQuery } from '@tanstack/react-query';
import { api } from './client';

/** The addresses a funnel can go live on (GET /api/funnels/:id/addresses) and the publish state. */
export type PublishState = 'draft' | 'publishing' | 'live' | 'failed' | 'paused';

export interface AddressOption {
  kind: 'builtin' | 'pages' | 'workers' | 'custom';
  domainId: string | null;
  label: string;
  url: string | null;
  host: string | null;
  available: boolean;
  reason: string | null;
  status: 'active' | 'pending' | 'failed' | null;
  selected: boolean;
}

export interface AddressOptions {
  options: AddressOption[];
  state: PublishState;
  funnelStatus: 'live' | 'test';
  currentDomainId: string | null;
  /** The names inside the built-in address and the search engine setting. */
  builtin?: { workspaceSlug: string; funnelSlug: string; base: string; allowIndexing: boolean };
}

export const goLiveKey = (funnelId: string) => ['addresses', funnelId] as const;

export const useAddresses = (funnelId: string) =>
  useQuery({
    queryKey: goLiveKey(funnelId),
    queryFn: () => api.get<AddressOptions>(`/api/funnels/${funnelId}/addresses`),
    refetchInterval: (q) => (q.state.data?.state === 'publishing' ? 2500 : false),
  });
