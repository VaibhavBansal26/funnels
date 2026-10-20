import { ArrowDown, ArrowUp, Copy, FileText, GripVertical, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../../api/client';
import { keys, useFunnel, useMutate } from '../../api/hooks';
import type { Step } from '../../api/types';
import { ConfirmDialog, ErrorBanner, TextField } from '../../components/ui';
import { Button, cn, Dialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../ui';
import { useBuilder } from '../useEditor';
import { Row } from './kit';

/** The steps (pages) of this funnel: switch, add, duplicate, delete and reorder without leaving the builder. */
export function PagesPanel() {
  const { env, ui } = useBuilder();
  const nav = useNavigate();
  const funnel = useFunnel(env.funnelId);
  const steps = funnel.data?.steps ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Step | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const base = `/api/funnels/${env.funnelId}/steps`;
  const refresh = [keys.funnel(env.funnelId), keys.funnels];
  const add = useMutate((n: string) => api.post<Step>(base, { name: n }), refresh);
  const dup = useMutate((id: string) => api.post<Step>(`${base}/${id}/duplicate`), refresh);
  const del = useMutate((id: string) => api.delete(`${base}/${id}`), refresh);
  const reorder = useMutate((ids: string[]) => api.put(`${base}/order`, { orders: ids.map((stepId, i) => ({ stepId, order: i + 1 })) }), refresh);

  const go = (id: string) => id !== env.stepId && nav(`/funnels/${env.funnelId}/builder/${id}`);
  const moveTo = (id: string, to: number) => {
    const ids = steps.map((s) => s.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
    reorder.mutate(ids, { onError: (e) => ui.toast(errorMessage(e), 'error') });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Pages">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div><h3 className="text-sm font-semibold">Pages</h3><p className="text-[0.75rem] text-muted">{steps.length} step{steps.length === 1 ? '' : 's'} in this funnel</p></div>
        <Button size="sm" variant="primary" onClick={() => { setName(''); setAdding(true); }}><Plus /> Add page</Button>
      </div>
      <ErrorBanner error={funnel.error ?? add.error ?? del.error ?? dup.error ?? reorder.error} />
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1.5 overflow-y-auto p-2.5">
        {steps.map((s, i) => (
          <li
            key={s.id}
            draggable
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            onDragOver={(e) => { if (dragId && dragId !== s.id) { e.preventDefault(); setOverId(s.id); } }}
            onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== s.id) moveTo(dragId, i); setDragId(null); setOverId(null); }}
            className={cn('group flex items-center gap-2 rounded-lg border bg-surface px-2 py-2 shadow-sm', s.id === env.stepId ? 'border-primary bg-primary-soft' : 'border-border hover:border-border-strong', overId === s.id && 'ring-2 ring-ring', dragId === s.id && 'opacity-50')}
          >
            <GripVertical className="size-4 shrink-0 cursor-grab text-muted" aria-hidden="true" />
            <button type="button" onClick={() => go(s.id)} aria-current={s.id === env.stepId ? 'page' : undefined} className="min-w-0 flex-1 text-left">
              <span className="flex items-center gap-1.5 text-[0.85rem] font-semibold"><FileText className="size-3.5 text-muted" aria-hidden="true" /><span className="truncate">{s.position}. {s.name}</span></span>
              <span className="block truncate text-[0.75rem] text-muted">{s.path}{s.isDomainHome ? ' · home' : ''}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={i === 0} onSelect={() => moveTo(s.id, i - 1)}><ArrowUp /> Move up</DropdownMenuItem>
                <DropdownMenuItem disabled={i === steps.length - 1} onSelect={() => moveTo(s.id, i + 1)}><ArrowDown /> Move down</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => dup.mutate(s.id, { onSuccess: (n) => { ui.toast(`Duplicated as "${n.name}"`, 'ok'); } })}><Copy /> Duplicate</DropdownMenuItem>
                <DropdownMenuItem danger disabled={steps.length <= 1} onSelect={() => setDeleting(s)}><Trash2 /> Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <Dialog open={adding} onOpenChange={setAdding} size="sm" title="Add a page" footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || add.isPending} onClick={() => add.mutate(name.trim(), { onSuccess: (s) => { setAdding(false); nav(`/funnels/${env.funnelId}/builder/${s.id}`); }, onError: (e) => ui.toast(errorMessage(e), 'error') })}>Add page</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(name.trim(), { onSuccess: (s) => { setAdding(false); nav(`/funnels/${env.funnelId}/builder/${s.id}`); } }); }}>
          <TextField label="Page name" value={name} onChange={setName} data-autofocus placeholder="e.g. Thank you" />
          <Row label="Path">A path is generated from the name; you can change it in Page settings.</Row>
        </form>
      </Dialog>
      {deleting ? <ConfirmDialog danger title="Delete this page?" confirmLabel="Delete page" busy={del.isPending} message={<>“{deleting.name}” and its saved versions will be removed. This cannot be undone.</>} onCancel={() => setDeleting(null)} onConfirm={() => del.mutate(deleting.id, { onSuccess: () => { const left = steps.find((x) => x.id !== deleting.id); setDeleting(null); if (deleting.id === env.stepId && left) nav(`/funnels/${env.funnelId}/builder/${left.id}`); }, onError: (e) => { ui.toast(errorMessage(e), 'error'); setDeleting(null); } })} /> : null}
    </div>
  );
}
