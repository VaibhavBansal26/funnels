import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageUp, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError, errorMessage, tokenStore } from '../../api/client';
import { Button, cn } from '../../ui';
import { useBuilder } from '../useEditor';
import { PanelEmpty } from './kit';

export interface Asset { id: string; name: string; mime: string; size: number; url: string; createdAt: string }
const KEY = ['assets'] as const;

export const useAssets = () => useQuery({ queryKey: KEY, queryFn: () => api.get<{ data: Asset[]; limits: { maxBytes: number; maxFiles: number } }>('/api/assets') });

/** Uploads one image through the app's own storage (POST /api/assets, content-sniffed server side). */
export async function uploadAsset(file: File): Promise<Asset> {
  const form = new FormData();
  form.set('file', file, file.name);
  const res = await fetch('/api/assets', { method: 'POST', headers: { authorization: `Bearer ${tokenStore.get() ?? ''}` }, body: form });
  const body = (await res.json().catch(() => ({}))) as Asset & { error?: { code?: string; message?: string } };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? 'UPLOAD_FAILED', body.error?.message ?? 'The upload failed');
  return body;
}

/** The image library: upload (button, drop or paste), pick for the current target, copy the URL, delete. Used as a tab and inside the picker dialog. */
export function AssetLibrary({ onPick, compact }: { onPick?: (a: Asset) => void; compact?: boolean }) {
  const { ui } = useBuilder();
  const qc = useQueryClient();
  const q = useAssets();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    try {
      for (const f of [...files]) {
        const a = await uploadAsset(f);
        ui.toast(`Uploaded ${a.name}`, 'ok');
        if (onPick && files.length === 1) onPick(a);
      }
    } catch (e) {
      ui.toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };
  const remove = async (a: Asset) => {
    try {
      await api.delete(`/api/assets/${a.id}`);
      void qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      ui.toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Images">
      <div
        className={cn('m-3 flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-border-strong px-3 py-5 text-center transition-colors', over && 'border-primary bg-primary-soft')}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
      >
        <ImageUp className="size-5 text-primary" aria-hidden="true" />
        <p className="text-[0.82rem] font-medium">Drop images here</p>
        <p className="text-[0.75rem] text-muted">PNG, JPEG, GIF or WebP up to {Math.round((q.data?.limits.maxBytes ?? 1_500_000) / 1000)} KB</p>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="sr-only" aria-label="Choose images to upload" onChange={(e) => e.target.files && void upload(e.target.files)} />
        <Button size="sm" disabled={busy} onClick={() => input.current?.click()}><Upload /> {busy ? 'Uploading…' : 'Upload image'}</Button>
      </div>
      {q.data && q.data.data.length === 0 ? <PanelEmpty icon={<ImageUp />} title="No images yet">Uploaded images are stored with your workspace and can be reused on any page.</PanelEmpty> : null}
      <ul className={cn('m-0 grid min-h-0 flex-1 list-none content-start gap-2 overflow-y-auto p-3 pt-0', compact ? 'grid-cols-3' : 'grid-cols-2')}>
        {q.data?.data.map((a) => (
          <li key={a.id} className="group relative overflow-hidden rounded-lg border border-border bg-surface-2">
            <button type="button" onClick={() => onPick?.(a)} aria-label={onPick ? `Use ${a.name}` : a.name} className="block aspect-square w-full">
              <img src={a.url} alt="" loading="lazy" className="size-full object-cover" />
            </button>
            <span className="block truncate bg-surface px-1.5 py-0.5 text-[0.7rem] text-muted" title={a.name}>{a.name}</span>
            {onPick ? <span className="pointer-events-none absolute top-1 left-1 hidden size-5 place-items-center rounded-full bg-primary text-primary-fg group-hover:grid"><Check className="size-3" /></span> : null}
            <button type="button" aria-label={`Delete ${a.name}`} onClick={() => void remove(a)} className="absolute top-1 right-1 hidden size-6 place-items-center rounded-md bg-surface text-muted shadow hover:text-danger group-focus-within:grid group-hover:grid"><Trash2 className="size-3.5" /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const AssetsPanel = () => <AssetLibrary />;
