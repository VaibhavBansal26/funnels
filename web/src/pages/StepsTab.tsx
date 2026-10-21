import { ArrowDown, ArrowUp, Copy, FileX, House, MoreHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui';
import { PaymentsWizard } from '../components/PaymentsWizard';
import { useAuth } from '../auth/AuthContext';
import { PageThumb } from '../components/FunnelThumb';
import { Link } from 'react-router';
import { api, errorMessage } from '../api/client';
import { keys, useMutate } from '../api/hooks';
import type { FunnelDetail, Step } from '../api/types';
import { useToast } from '../components/Toasts';
import { ConfirmDialog, ErrorBanner, Modal, TextField } from '../components/ui';
import { moveItem, reorderKey, toOrders } from './reorder';

const slug = (name: string) => `/${name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page'}`;

function AddStepDialog({ funnel, onClose }: { funnel: FunnelDetail; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [touched, setTouched] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const effective = touched ? path : slug(name);
  const create = useMutate((b: object) => api.post('/api/funnels/' + funnel.id + '/steps', b), [keys.funnel(funnel.id), keys.funnels]);

  // Live path validation (format, this funnel, and the domain when one is attached) with /path-NNNN suggestions.
  useEffect(() => {
    if (!name.trim() && !touched) return;
    const t = setTimeout(() => {
      api.post<{ success: boolean; reason?: string; uniquePaths: string[] }>('/api/funnels/validate-path', { path: effective, funnelId: funnel.id, domainId: funnel.domain?.id })
        .then((r) => {
          setSuggestions(r.success ? [] : r.uniquePaths);
          setError(r.success ? null : r.reason === 'INVALID_PATH' ? 'Use a path like /thank-you: letters, digits and "-" only' : 'This path is already used');
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [effective, name, touched, funnel.id, funnel.domain?.id]);

  return (
    <Modal
      title="Add step"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!name.trim() || !!error || create.isPending} onClick={() => create.mutate({ name: name.trim(), base_path: effective }, { onSuccess: () => { toast.push('Step added', 'ok'); onClose(); } })}>Add step</button>
        </>
      }
    >
      <ErrorBanner error={create.error} />
      <TextField label="Step name" value={name} onChange={setName} data-autofocus />
      <TextField label="Path" value={effective} error={error ?? undefined} onChange={(v) => { setTouched(true); setPath(v); }} />
      {suggestions.length ? (
        <p className="small">Try: {suggestions.map((s) => <button key={s} type="button" className="btn sm" style={{ marginRight: 4 }} onClick={() => { setTouched(true); setPath(s); }}>{s}</button>)}</p>
      ) : null}
    </Modal>
  );
}

export function StepsTab({ funnel }: { funnel: FunnelDetail }) {
  const toast = useToast();
  const [order, setOrder] = useState<Step[]>(funnel.steps);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [payments, setPayments] = useState(false);
  const { can } = useAuth();
  const [deleting, setDeleting] = useState<Step | null>(null);
  useEffect(() => setOrder(funnel.steps), [funnel.steps]);

  const inv = [keys.funnel(funnel.id), keys.funnels];
  const reorder = useMutate((next: Step[]) => api.put(`/api/funnels/${funnel.id}/steps/order`, { orders: toOrders(next) }), inv);
  const dup = useMutate((id: string) => api.post(`/api/funnels/${funnel.id}/steps/${id}/duplicate`), inv);
  const del = useMutate((id: string) => api.delete(`/api/funnels/${funnel.id}/steps/${id}`), inv);
  const defaults = useMutate((b: object) => api.put(`/api/domains/${funnel.domain!.id}/default-pages`, b), inv);

  const apply = (next: Step[]) => {
    const before = order;
    setOrder(next);
    reorder.mutate(next, { onError: (e) => { setOrder(before); toast.push(errorMessage(e), 'error'); } });
  };
  const move = (from: number, to: number) => apply(moveItem(order, from, to));

  return (
    <div className="stack">
      <div className="row between">
        <p className="small muted" style={{ margin: 0 }}>Drag to reorder, or focus a step and press Alt+↑ / Alt+↓.</p>
        <span className="row">
          {can('funnels:write') && can('products:write') ? <button type="button" className="btn" onClick={() => setPayments(true)}>Add payments</button> : null}
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add step</button>
        </span>
      </div>
      <ErrorBanner error={reorder.error ?? dup.error ?? del.error ?? defaults.error} />
      <ol className="m-0 list-none p-0" aria-label="Funnel steps">
        {order.map((s, i) => (
          <li
            key={s.id}
            className={`step-row${dragging === i ? ' dragging' : ''}${over === i && dragging !== null && dragging !== i ? ' over' : ''}`}
            draggable
            tabIndex={0}
            aria-label={`Step ${i + 1}: ${s.name}. Press Alt+Arrow Up or Down to move.`}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              const m = reorderKey(e, i, order.length);
              if (m) {
                e.preventDefault();
                move(m.from, m.to);
              }
            }}
            onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); }}
            onDragOver={(e) => { e.preventDefault(); setOver(i); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDrop={(e) => { e.preventDefault(); if (dragging !== null && dragging !== i) move(dragging, i); setDragging(null); setOver(null); }}
          >
            <span className="step-index" aria-hidden="true">{i + 1}</span>
            <PageThumb funnelId={funnel.id} stepId={s.id} title={s.name} className="hidden sm:block" />
            <div className="grow">
              <strong className="font-semibold">{s.name}</strong> {s.isDomainHome ? <span className="badge ok">Domain home</span> : null} {s.isDomain404 ? <span className="badge warn">Domain 404</span> : null}
              <div className="muted small mono">{s.path}</div>
            </div>
            <div className="flex flex-none items-center gap-1.5">
              <span className="hidden items-center sm:flex">
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} down`} disabled={i === order.length - 1} onClick={() => move(i, i + 1)}><ArrowDown /></Button>
              </span>
              <Link className="btn sm primary" to={`/funnels/${funnel.id}/builder/${s.id}`}>Edit page</Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`More actions for ${s.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="sm:hidden" disabled={i === 0} onSelect={() => move(i, i - 1)}><ArrowUp /> Move up</DropdownMenuItem>
                  <DropdownMenuItem className="sm:hidden" disabled={i === order.length - 1} onSelect={() => move(i, i + 1)}><ArrowDown /> Move down</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dup.mutate(s.id, { onSuccess: () => toast.push('Step duplicated', 'ok') })}><Copy /> Duplicate</DropdownMenuItem>
                  {funnel.domain ? (
                    <>
                      <DropdownMenuItem onSelect={() => defaults.mutate({ homeStepId: s.isDomainHome ? null : s.id })}><House /> {s.isDomainHome ? 'Unset home' : 'Set as home'}</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => defaults.mutate({ notFoundStepId: s.isDomain404 ? null : s.id })}><FileX /> {s.isDomain404 ? 'Unset 404' : 'Set as 404'}</DropdownMenuItem>
                    </>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger disabled={order.length <= 1} onSelect={() => setDeleting(s)}><Trash2 /> Delete step</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
      </ol>
      {!funnel.domain ? <p className="muted small">Put the funnel live in the Settings tab (Go live) to choose the home and 404 pages served on its address.</p> : null}
      {adding ? <AddStepDialog funnel={funnel} onClose={() => setAdding(false)} /> : null}
      {payments ? <PaymentsWizard funnel={funnel} onClose={() => setPayments(false)} onDone={(r) => { setPayments(false); toast.push(r.added.length ? `Payments added: ${r.added.length} new step${r.added.length === 1 ? '' : 's'}` : 'Payments added to the page', 'ok'); }} /> : null}
      {deleting ? (
        <ConfirmDialog danger title="Delete step?" confirmLabel="Delete step" busy={del.isPending} message={<>"{deleting.name}" and its page content will be removed. Its backups go with it.</>} onCancel={() => setDeleting(null)}
          onConfirm={() => del.mutate(deleting.id, { onSuccess: () => { toast.push('Step deleted', 'ok'); setDeleting(null); }, onError: () => setDeleting(null) })} />
      ) : null}
    </div>
  );
}

