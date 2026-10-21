import { PackagePlus, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { useMutate, useProducts } from '../api/hooks';
import type { Product } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProductAnalytics } from '../components/ProductAnalytics';
import { ProductEditor, SyncBadge } from '../components/ProductEditor';
import { useToast } from '../components/Toasts';
import { Empty, ErrorBanner, Loading, Pager } from '../components/ui';
import { Badge, Button, Input, Select, Table, TBody, TD, TH, THead, TR, Tabs, TabsContent, TabsList, TabsTrigger } from '../ui';

function Thumb({ p }: { p: Product }) {
  return p.images[0] ? <img src={p.images[0]} alt="" className="size-10 rounded-md border border-border object-cover" /> : <span aria-hidden="true" className="grid size-10 place-items-center rounded-md bg-primary-soft text-sm font-bold text-primary">{p.name.slice(0, 1).toUpperCase()}</span>;
}

function priceSummary(p: Product): string {
  const active = p.prices.filter((x) => x.active);
  const def = active.find((x) => x.id === p.defaultPriceId) ?? active[0];
  if (!def) return 'No price';
  const text = `${def.formatted}${def.interval ? ` / ${def.interval}` : ''}`;
  return active.length > 1 ? `${text} +${active.length - 1} more` : text;
}

function Catalog() {
  const { can } = useAuth();
  const write = can('products:write');
  const toast = useToast();
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(1), [status, debounced]);
  const q = useProducts({ status, search: debounced || undefined, page, limit: 25 });
  const sync = useMutate(() => api.post<{ connected: boolean; synced: number; failed: number }>('/api/products/sync'), [['products']]);
  const stripe = q.data?.stripe;
  return (
    <div className="stack">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-xs">
          <label htmlFor="p-search" className="sr-only">Search products</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="p-search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products" />
        </div>
        <div className="w-40"><Select aria-label="Status" value={status} onValueChange={(v) => setStatus(v as typeof status)} options={[{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }]} /></div>
        <span className="flex-1" />
        {write && stripe?.connected ? <Button disabled={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: (r) => toast.push(r.failed ? `${r.synced} synced, ${r.failed} failed` : `${r.synced} synced to Stripe`, r.failed ? 'error' : 'ok') })}><RefreshCw /> {sync.isPending ? 'Syncing…' : 'Sync with Stripe'}</Button> : null}
        {write ? <Button variant="primary" onClick={() => setEditing('new')}><PackagePlus /> New product</Button> : null}
      </div>
      {stripe && !stripe.connected ? <div className="alert" role="status">Stripe is not connected, so products live in your catalog only. They still work in checkouts. <Link to="/settings">Connect Stripe in Settings</Link> to mirror them as Stripe products and prices.</div> : null}
      <ErrorBanner error={q.error ?? sync.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && q.data.data.length === 0 ? <Empty title={debounced || status !== 'active' ? 'No products match' : 'No products yet'} action={write && status === 'active' && !debounced ? <Button variant="primary" onClick={() => setEditing('new')}>Create your first product</Button> : undefined}>Products are what your checkouts sell: a name, a description and one or more prices.</Empty> : null}
      {q.data && q.data.data.length > 0 ? (
        <section className="card flush" aria-label="Products">
          <Table>
            <caption className="sr-only">Product catalog</caption>
            <THead><TR><TH>Product</TH><TH>Type</TH><TH>Price</TH><TH className="text-right">Orders</TH><TH>Stripe</TH><TH>Status</TH></TR></THead>
            <TBody>
              {q.data.data.map((p) => (
                <TR key={p.id}>
                  <TD><button type="button" className="flex items-center gap-3 text-left font-semibold hover:text-primary" onClick={() => setEditing(p.id)} aria-label={`Open ${p.name}`}><Thumb p={p} /><span>{p.name}{p.description ? <span className="block max-w-xs truncate text-[0.82rem] font-normal text-muted">{p.description}</span> : null}</span></button></TD>
                  <TD>{p.type === 'subscription' ? <Badge tone="info">Subscription</Badge> : <Badge>One-time</Badge>}</TD>
                  <TD className="whitespace-nowrap">{priceSummary(p)}</TD>
                  <TD className="text-right tabular-nums">{p.orderCount}</TD>
                  <TD><SyncBadge product={p} /></TD>
                  <TD>{p.status === 'archived' ? <Badge tone="warn">Archived</Badge> : <Badge tone="ok">Active</Badge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      ) : null}
      {q.data ? <Pager p={q.data.pagination} onPage={setPage} /> : null}
      {editing ? <ProductEditor productId={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

/** The catalog of what you sell and how each product performs. */
export function ProductsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'performance' ? 'performance' : 'catalog';
  return (
    <div className="stack">
      <h1>Products</h1>
      <p className="muted">What your checkouts sell. Prices come from here: change one and every page that uses it follows, while past orders keep the price they were bought at.</p>
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'catalog' ? {} : { tab: v })}>
        <TabsList aria-label="Products sections"><TabsTrigger value="catalog">Catalog</TabsTrigger>{can('analytics:read') ? <TabsTrigger value="performance">Performance</TabsTrigger> : null}</TabsList>
        <TabsContent value="catalog" className="pt-4"><Catalog /></TabsContent>
        {can('analytics:read') ? <TabsContent value="performance" className="pt-4"><ProductAnalytics /></TabsContent> : null}
      </Tabs>
    </div>
  );
}
