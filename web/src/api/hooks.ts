import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from './client';
import type {
  Analytics, AppNotification, Backup, CustomBlock, Delivery, Domain, DomainRoute, FunnelDetail, FunnelFilters, FunnelSummary, Lead, Member, Order, Paged, PageData,
  PaymentsStatus, Product, ProductList, ProductReport, TemplateCategory, TemplateDetail, TemplateList, Tag, Webhook,
} from './types';

type Q = Record<string, string | number | boolean | undefined | null>;

export const keys = {
  funnels: ['funnels'] as const,
  funnel: (id: string) => ['funnel', id] as const,
  tags: ['tags'] as const,
  domains: ['domains'] as const,
  webhooks: ['webhooks'] as const,
  notifications: ['notifications'] as const,
  members: ['members'] as const,
  blocks: ['blocks'] as const,
  trash: ['trash'] as const,
};

export const useFunnels = (q: Q) => useQuery({ queryKey: [...keys.funnels, 'list', q], queryFn: () => api.get<Paged<FunnelSummary>>('/api/funnels', q), placeholderData: keepPreviousData });
export const useFunnelFilters = () => useQuery({ queryKey: [...keys.funnels, 'filters'], queryFn: () => api.get<FunnelFilters>('/api/funnels/filters') });
export const useFunnel = (id: string) => useQuery({ queryKey: keys.funnel(id), queryFn: () => api.get<FunnelDetail>(`/api/funnels/${id}`) });
export const useTrash = () => useQuery({ queryKey: keys.trash, queryFn: () => api.get<{ data: FunnelSummary[] }>('/api/funnels/trash') });
export const useTags = () => useQuery({ queryKey: keys.tags, queryFn: () => api.get<{ data: Tag[] }>('/api/tags') });
export const useDomains = () => useQuery({ queryKey: keys.domains, queryFn: () => api.get<{ data: Domain[] }>('/api/domains') });
export const useDomainRoutes = (id: string | null) => useQuery({ queryKey: [...keys.domains, id, 'routes'], enabled: !!id, queryFn: () => api.get<{ data: DomainRoute[] }>(`/api/domains/${id}/routes`) });
export const useWebhooks = () => useQuery({ queryKey: keys.webhooks, queryFn: () => api.get<{ data: Webhook[] }>('/api/webhooks') });
export const useDeliveries = (id: string | null) => useQuery({ queryKey: [...keys.webhooks, id, 'deliveries'], enabled: !!id, queryFn: () => api.get<{ data: Delivery[] }>(`/api/webhooks/${id}/deliveries`) });
export const useMembers = () => useQuery({ queryKey: keys.members, queryFn: () => api.get<{ data: Member[] }>('/api/members') });
export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: () => api.get<{ data: AppNotification[]; unread: number }>('/api/notifications') });
export const useCustomBlocks = () => useQuery({ queryKey: keys.blocks, queryFn: () => api.get<{ data: CustomBlock[] }>('/api/blocks') });
export const useTemplates = (q: Q) => useQuery({ queryKey: ['templates', q], queryFn: () => api.get<TemplateList>('/api/templates', q), placeholderData: keepPreviousData });
export const useTemplateCategories = () => useQuery({ queryKey: ['templates', 'categories'], queryFn: () => api.get<{ data: TemplateCategory[] }>('/api/templates/categories') });
export const useTemplate = (id: string | null) => useQuery({ queryKey: ['templates', id], enabled: !!id, queryFn: () => api.get<TemplateDetail>(`/api/templates/${id}`) });
export const useProducts = (q: Q) => useQuery({ queryKey: ['products', 'list', q], queryFn: () => api.get<ProductList>('/api/products', q), placeholderData: keepPreviousData });
export const useProduct = (id: string | null) => useQuery({ queryKey: ['products', id], enabled: !!id, queryFn: () => api.get<Product>(`/api/products/${id}`) });
export const usePaymentsStatus = () => useQuery({ queryKey: ['payments', 'status'], queryFn: () => api.get<PaymentsStatus>('/api/payments/status'), staleTime: 10_000 });
export const useProductAnalytics = (q: Q, funnelId?: string) =>
  useQuery({ queryKey: ['product-analytics', funnelId ?? 'all', q], queryFn: () => api.get<ProductReport>(funnelId ? `/api/funnels/${funnelId}/analytics/products` : '/api/analytics/products', q), placeholderData: keepPreviousData });
export const useLeads = (q: Q) => useQuery({ queryKey: ['leads', q], queryFn: () => api.get<Paged<Lead>>('/api/leads', q), placeholderData: keepPreviousData });
export const useOrders = (q: Q) => useQuery({ queryKey: ['orders', q], queryFn: () => api.get<Paged<Order>>('/api/orders', q), placeholderData: keepPreviousData });
export const useAnalytics = (id: string, q: Q) => useQuery({ queryKey: ['analytics', id, q], queryFn: () => api.get<Analytics>(`/api/funnels/${id}/analytics`, q) });
export const useBackups = (funnelId: string, stepId: string, enabled = true) =>
  useQuery({ queryKey: ['backups', stepId], enabled, queryFn: () => api.get<{ data: Backup[] }>(`/api/funnels/${funnelId}/steps/${stepId}/backups`) });
export const usePage = (funnelId: string, stepId: string) => useQuery({ queryKey: ['page', stepId], queryFn: () => api.get<PageData>(`/api/funnels/${funnelId}/steps/${stepId}/page`), staleTime: Infinity, gcTime: 0 });

/** Mutation that invalidates the given query-key prefixes on success. */
export function useMutate<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: QueryKey[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}
