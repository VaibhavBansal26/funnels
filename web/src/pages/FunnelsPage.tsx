import { Copy, ExternalLink, LayoutGrid, MoreHorizontal, Pencil, Plus, Rows3, Search, Tag, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '../api/client';
import { useFunnelFilters, useFunnels, useMutate, useTags, keys } from '../api/hooks';
import type { FunnelSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FunnelThumb } from '../components/FunnelThumb';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, Empty, ErrorBanner, fmtDate, fmtDay, fmtMoney, fmtNum, Loading, Modal, Pager, StatusBadge } from '../components/ui';
import { Button, Card, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Input } from '../ui';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function BulkTagDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const tags = useTags();
  const toast = useToast();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const m = useMutate(() => api.post('/api/funnels/bulk-tag', { funnelIds: ids, addTagIds: add, removeTagIds: remove }), [keys.funnels]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <Modal
      title={`Tag ${ids.length} funnel${ids.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={m.isPending || (!add.length && !remove.length)} onClick={() => m.mutate(undefined, { onSuccess: () => { toast.push('Tags updated', 'ok'); onClose(); } })}>Apply</Button>
        </>
      }
    >
      <ErrorBanner error={m.error} />
      {tags.isLoading ? <Loading rows={2} /> : null}
      {tags.data?.data.length === 0 ? <Empty title="No tags yet">Create tags in a funnel's settings tab, then use them here.</Empty> : null}
      <div className="grid grid-cols-2 gap-4">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-semibold">Add tags</legend>
          {tags.data?.data.map((t) => (
            <label key={t.id} className="check"><input type="checkbox" checked={add.includes(t.id)} onChange={() => toggle(add, setAdd, t.id)} />{t.name}</label>
          ))}
        </fieldset>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-semibold">Remove tags</legend>
          {tags.data?.data.map((t) => (
            <label key={t.id} className="check"><input type="checkbox" checked={remove.includes(t.id)} onChange={() => toggle(remove, setRemove, t.id)} />{t.name}</label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}

export function FunnelsPage() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const debounced = useDebounced(search);
  const [selected, setSelected] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  const [deleting, setDeleting] = useState<FunnelSummary | null>(null);
  const view = sp.get('view') === 'table' ? 'table' : 'cards';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch) && !('view' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };
  useEffect(() => {
    if ((sp.get('search') ?? '') !== debounced) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = { search: sp.get('search') ?? undefined, status: sp.get('status') ?? undefined, tags: sp.get('tags') ?? undefined, domain_connected: sp.get('domain_connected') ?? undefined, sort: sp.get('sort') ?? 'updated', page: Number(sp.get('page') ?? 1), limit: 20 };
  const q = useFunnels(query);
  const filters = useFunnelFilters();
  const tags = useTags();
  const dup = useMutate((id: string) => api.post<FunnelSummary>(`/api/funnels/${id}/duplicate`), [keys.funnels]);
  const del = useMutate((id: string) => api.delete(`/api/funnels/${id}`), [keys.funnels, keys.trash]);
  const rows = q.data?.data ?? [];
  const filtered = !!(query.search || query.status || query.tags || query.domain_connected);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const total = (filters.data?.status.live ?? 0) + (filters.data?.status.test ?? 0);
  const duplicate = (f: FunnelSummary) => dup.mutate(f.id, { onSuccess: (n) => toast.push(`Created "${n.name}"`, 'ok'), onError: (e) => toast.push(errorMessage(e), 'error') });

  const actions = (f: FunnelSummary) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${f.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => nav(`/funnels/${f.id}`)}><ExternalLink /> Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => duplicate(f)}><Copy /> Duplicate</DropdownMenuItem>
        {can('funnels:delete') ? <><DropdownMenuSeparator /><DropdownMenuItem danger onSelect={() => setDeleting(f)}><Trash2 /> Move to trash</DropdownMenuItem></> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const status = sp.get('status') ?? '';

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="!mb-0">My Funnels</h1>
          <p className="mt-1.5 mb-0 text-muted">{total} funnel{total === 1 ? '' : 's'} · {filters.data?.status.live ?? 0} live</p>
        </div>
        <Link className="btn primary" to="/funnels/new"><Plus className="size-4" aria-hidden="true" /> New funnel</Link>
      </div>

      <form className="-mt-3 flex flex-wrap items-center gap-3" role="search" aria-label="Filter funnels" onSubmit={(e) => e.preventDefault()}>
        <div className="relative w-full sm:w-64">
          <label htmlFor="f-search" className="sr-only">Search by name</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="f-search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search funnels" />
        </div>
        <div role="group" aria-label="Status" className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {[{ v: '', l: 'All', n: total }, { v: 'live', l: 'Live', n: filters.data?.status.live ?? 0 }, { v: 'test', l: 'Test', n: filters.data?.status.test ?? 0 }].map((o) => (
            <button key={o.v} type="button" aria-pressed={status === o.v} onClick={() => set({ status: o.v || null })} className={cn('min-h-9 rounded-md px-3.5 text-sm font-medium text-muted transition-colors hover:text-fg max-sm:min-h-11', status === o.v && 'bg-surface text-fg shadow-sm')}>{o.l} <span className="font-normal opacity-80">{o.n}</span></button>
          ))}
        </div>
        <div>
          <label htmlFor="f-tag" className="sr-only">Tag</label>
          <select id="f-tag" className="input" value={sp.get('tags') ?? ''} onChange={(e) => set({ tags: e.target.value || null })}>
            <option value="">Any tag</option>
            {tags.data?.data.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.count ?? 0})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-domain" className="sr-only">Domain</label>
          <select id="f-domain" className="input" value={sp.get('domain_connected') ?? ''} onChange={(e) => set({ domain_connected: e.target.value || null })}>
            <option value="">Any domain state</option>
            <option value="true">Domain connected</option>
            <option value="false">No domain</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-sort" className="sr-only">Sort by</label>
          <select id="f-sort" className="input" value={query.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div className="ml-auto inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5" role="group" aria-label="View">
          <button type="button" aria-label="Cards" aria-pressed={view === 'cards'} onClick={() => set({ view: null })} className={cn('grid size-9 place-items-center rounded-md text-muted transition-colors hover:text-fg max-sm:size-11', view === 'cards' && 'bg-surface text-fg shadow-sm')}><LayoutGrid className="size-4" /></button>
          <button type="button" aria-label="Table" aria-pressed={view === 'table'} onClick={() => set({ view: 'table' })} className={cn('grid size-9 place-items-center rounded-md text-muted transition-colors hover:text-fg max-sm:size-11', view === 'table' && 'bg-surface text-fg shadow-sm')}><Rows3 className="size-4" /></button>
        </div>
      </form>

      {selected.length ? (
        <div className="alert row between !mb-0" role="status">
          <span>{selected.length} selected</span>
          <span className="row"><Button size="sm" onClick={() => setTagging(true)}><Tag /> Tag selected</Button><Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button></span>
        </div>
      ) : null}

      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && rows.length === 0 ? (
        <Empty title={filtered ? 'No funnels match these filters' : 'No funnels yet'} action={filtered ? <Button onClick={() => { setSearch(''); setSp(new URLSearchParams(), { replace: true }); }}>Clear filters</Button> : <Link className="btn primary" to="/funnels/new">Create your first funnel</Link>}>
          {filtered ? 'Try a different search or clear the filters.' : 'Start from a template, let AI draft one, or build from scratch.'}
        </Empty>
      ) : null}

      {rows.length && view === 'cards' ? (
        <>
          <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 20rem), 1fr))' }}>
            {rows.map((f) => (
              <Card key={f.id} className="group/card flex flex-col overflow-hidden transition-shadow duration-200 hover:shadow-pop" aria-label={f.name} role="article">
                <div className="relative">
                <Link to={`/funnels/${f.id}`} tabIndex={-1} aria-hidden="true" className="relative block border-b border-border bg-surface-2">
                  <FunnelThumb thumb={f.thumbnail} funnelId={f.id} className="rounded-none border-0" />
                  <span className="pointer-events-none absolute inset-0 bg-primary/0 transition-colors group-hover/card:bg-primary/5" />
                </Link>
                <label className={cn('absolute top-3 left-3 grid size-8 cursor-pointer place-items-center rounded-lg bg-surface/90 shadow-sm backdrop-blur transition-opacity max-sm:size-11 [@media(hover:hover)]:opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100', selected.includes(f.id) && '!opacity-100')}><input type="checkbox" className="size-[18px] accent-primary" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} aria-label={`Select ${f.name}`} /></label>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="!mb-0 min-w-0 text-[1rem] leading-snug"><Link to={`/funnels/${f.id}`} className="text-fg no-underline hover:text-primary">{f.name}</Link></h3>
                    <StatusBadge status={f.status} />
                  </div>
                  <p className="small muted !mb-0 truncate">{f.domain ? f.domain.hostname : 'No domain connected'} · updated {fmtDay(f.updatedAt)}</p>
                  {f.tags.length ? <div className="flex flex-wrap gap-1">{f.tags.map((t) => <span key={t.id} className="tag-chip">{t.name}</span>)}</div> : null}
                  <dl className="m-0 mt-auto grid grid-cols-4 gap-2 pt-2 text-left">
                    {[['Visits', fmtNum(f.stats.visits)], ['Opt-ins', fmtNum(f.stats.optins)], ['Orders', fmtNum(f.stats.orders)], ['Sales', fmtMoney(f.stats.sales)]].map(([l, v]) => (
                      <div key={l}><dd className="m-0 text-sm font-semibold tabular-nums">{v}</dd><dt className="text-xs text-muted">{l}</dt></div>
                    ))}
                  </dl>
                  <div className="flex items-center gap-1.5 border-t border-border pt-4">
                    <span className="flex w-full items-center gap-1.5">
                      <Button size="sm" onClick={() => nav(`/funnels/${f.id}`)}><Pencil /> Open</Button>
                      <span className="ml-auto">{actions(f)}</span>
                    </span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          {q.data ? <Pager p={q.data.pagination} onPage={(n) => set({ page: String(n) })} /> : null}
        </>
      ) : null}

      {rows.length && view === 'table' ? (
        <div className="card flush table-wrap">
          <table className="table">
            <caption className="sr-only">Funnels</caption>
            <thead>
              <tr>
                <th scope="col"><input type="checkbox" aria-label="Select all on this page" checked={rows.every((r) => selected.includes(r.id))} onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])} /></th>
                <th scope="col"><span className="sr-only">Thumbnail</span></th>
                <th scope="col">Name</th><th scope="col">Status</th><th scope="col" className="num">Steps</th><th scope="col" className="num">Visits</th>
                <th scope="col" className="num">Opt-ins</th><th scope="col" className="num">Orders</th><th scope="col" className="num">Sales</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td><input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.includes(f.id)} onChange={() => toggle(f.id)} /></td>
                  <td><FunnelThumb small thumb={f.thumbnail} funnelId={f.id} /></td>
                  <td>
                    <Link to={`/funnels/${f.id}`}><strong>{f.name}</strong></Link>
                    <div className="row" style={{ gap: 4 }}>{f.tags.map((t) => <span key={t.id} className="tag-chip">{t.name}</span>)}{f.domain ? <span className="muted small">{f.domain.hostname}</span> : null}</div>
                  </td>
                  <td><StatusBadge status={f.status} /></td>
                  <td className="num">{f.stepCount}</td><td className="num">{fmtNum(f.stats.visits)}</td><td className="num">{fmtNum(f.stats.optins)}</td><td className="num">{fmtNum(f.stats.orders)}</td><td className="num">{fmtMoney(f.stats.sales)}</td>
                  <td className="small muted">{fmtDate(f.updatedAt)}</td>
                  <td><span className="row" style={{ flexWrap: 'nowrap' }}><Button size="sm" onClick={() => duplicate(f)}>Duplicate</Button>{can('funnels:delete') ? <Button size="sm" variant="danger" aria-label={`Delete ${f.name}`} onClick={() => setDeleting(f)}>Delete</Button> : null}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data ? <Pager p={q.data.pagination} onPage={(n) => set({ page: String(n) })} /> : null}
        </div>
      ) : null}

      {tagging ? <BulkTagDialog ids={selected} onClose={() => { setTagging(false); setSelected([]); }} /> : null}
      {deleting ? (
        <ConfirmDialog
          danger title="Move funnel to trash?" confirmLabel="Move to trash" busy={del.isPending}
          message={<>"{deleting.name}" will stop being served and its domain is detached. You can restore it from the trash.</>}
          onCancel={() => setDeleting(null)}
          onConfirm={() => del.mutate(deleting.id, { onSuccess: () => { toast.push('Moved to trash', 'ok'); setDeleting(null); }, onError: (e) => { toast.push(errorMessage(e), 'error'); setDeleting(null); } })}
        />
      ) : null}
    </div>
  );
}
