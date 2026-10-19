import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { useFunnelFilters, useFunnels, useMutate, useTags, keys } from '../api/hooks';
import type { FunnelSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { FunnelThumb } from '../components/FunnelThumb';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, Empty, ErrorBanner, fmtDate, fmtMoney, fmtNum, Loading, Modal, Pager, StatusBadge } from '../components/ui';
import { errorMessage } from '../api/client';

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
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={m.isPending || (!add.length && !remove.length)} onClick={() => m.mutate(undefined, { onSuccess: () => { toast.push('Tags updated', 'ok'); onClose(); } })}>Apply</button>
        </>
      }
    >
      <ErrorBanner error={m.error} />
      {tags.isLoading ? <Loading rows={2} /> : null}
      {tags.data?.data.length === 0 ? <Empty title="No tags yet">Create tags in a funnel's settings tab, then use them here.</Empty> : null}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="label">Add tags</legend>
          {tags.data?.data.map((t) => (
            <label key={t.id} className="check"><input type="checkbox" checked={add.includes(t.id)} onChange={() => toggle(add, setAdd, t.id)} />{t.name}</label>
          ))}
        </fieldset>
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend className="label">Remove tags</legend>
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
  const view = sp.get('view') === 'cards' ? 'cards' : 'table';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
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

  return (
    <div className="stack">
      <div className="row between">
        <h1>My Funnels</h1>
        <Link className="btn primary" to="/funnels/new">New funnel</Link>
      </div>

      <form className="filters" role="search" aria-label="Filter funnels" onSubmit={(e) => e.preventDefault()}>
        <div className="field"><label htmlFor="f-search">Search by name</label><input id="f-search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search funnels" /></div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" className="input" value={sp.get('status') ?? ''} onChange={(e) => set({ status: e.target.value || null })}>
            <option value="">All ({(filters.data?.status.live ?? 0) + (filters.data?.status.test ?? 0)})</option>
            <option value="live">Live ({filters.data?.status.live ?? 0})</option>
            <option value="test">Test ({filters.data?.status.test ?? 0})</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-tag">Tag</label>
          <select id="f-tag" className="input" value={sp.get('tags') ?? ''} onChange={(e) => set({ tags: e.target.value || null })}>
            <option value="">Any tag</option>
            {tags.data?.data.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.count ?? 0})</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-domain">Domain</label>
          <select id="f-domain" className="input" value={sp.get('domain_connected') ?? ''} onChange={(e) => set({ domain_connected: e.target.value || null })}>
            <option value="">Any</option>
            <option value="true">Connected</option>
            <option value="false">Not connected</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-sort">Sort by</label>
          <select id="f-sort" className="input" value={query.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div className="row" role="group" aria-label="View">
          <button type="button" className="btn sm" aria-pressed={view === 'table'} onClick={() => set({ view: null })}>Table</button>
          <button type="button" className="btn sm" aria-pressed={view === 'cards'} onClick={() => set({ view: 'cards' })}>Cards</button>
        </div>
      </form>

      {selected.length ? (
        <div className="alert row between" role="status">
          <span>{selected.length} selected</span>
          <span className="row"><button type="button" className="btn sm" onClick={() => setTagging(true)}>Tag selected</button><button type="button" className="btn sm ghost" onClick={() => setSelected([])}>Clear</button></span>
        </div>
      ) : null}

      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {q.isLoading ? <Loading /> : null}
      {q.data && rows.length === 0 ? (
        <div className="card">
          <Empty title={filtered ? 'No funnels match these filters' : 'No funnels yet'} action={filtered ? <button type="button" className="btn" onClick={() => { setSearch(''); setSp(new URLSearchParams(), { replace: true }); }}>Clear filters</button> : <Link className="btn primary" to="/funnels/new">Create your first funnel</Link>}>
            {filtered ? 'Try a different search or clear the filters.' : 'Start from a template, let AI draft one, or build from scratch.'}
          </Empty>
        </div>
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
                  <td><FunnelThumb small thumb={f.thumbnail} /></td>
                  <td>
                    <Link to={`/funnels/${f.id}`}><strong>{f.name}</strong></Link>
                    <div className="row" style={{ gap: 4 }}>{f.tags.map((t) => <span key={t.id} className="tag-chip">{t.name}</span>)}{f.domain ? <span className="muted small">{f.domain.hostname}</span> : null}</div>
                  </td>
                  <td><StatusBadge status={f.status} /></td>
                  <td className="num">{f.stepCount}</td><td className="num">{fmtNum(f.stats.visits)}</td><td className="num">{fmtNum(f.stats.optins)}</td><td className="num">{fmtNum(f.stats.orders)}</td><td className="num">{fmtMoney(f.stats.sales)}</td>
                  <td className="small muted">{fmtDate(f.updatedAt)}</td>
                  <td>
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <button type="button" className="btn sm" onClick={() => dup.mutate(f.id, { onSuccess: (n) => { toast.push(`Created "${n.name}"`, 'ok'); }, onError: (e) => toast.push(errorMessage(e), 'error') })}>Duplicate</button>
                      {can('admin') ? <button type="button" className="btn sm danger" aria-label={`Delete ${f.name}`} onClick={() => setDeleting(f)}>Delete</button> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data ? <Pager p={q.data.pagination} onPage={(n) => set({ page: String(n) })} /> : null}
        </div>
      ) : null}

      {rows.length && view === 'cards' ? (
        <>
          <div className="grid cards">
            {rows.map((f) => (
              <article key={f.id} className="card funnel-card" aria-label={f.name}>
                <FunnelThumb thumb={f.thumbnail} />
                <div className="row between"><h3><Link to={`/funnels/${f.id}`}>{f.name}</Link></h3><StatusBadge status={f.status} /></div>
                <div className="meta"><span>{f.stepCount} steps</span><span>{fmtNum(f.stats.visits)} visits</span><span>{fmtNum(f.stats.optins)} opt-ins</span><span>{fmtMoney(f.stats.sales)}</span></div>
                <div className="row"><label className="check small"><input type="checkbox" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} />Select</label><span className="right row"><button type="button" className="btn sm" onClick={() => nav(`/funnels/${f.id}`)}>Open</button><button type="button" className="btn sm" onClick={() => dup.mutate(f.id)}>Duplicate</button></span></div>
              </article>
            ))}
          </div>
          {q.data ? <Pager p={q.data.pagination} onPage={(n) => set({ page: String(n) })} /> : null}
        </>
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
