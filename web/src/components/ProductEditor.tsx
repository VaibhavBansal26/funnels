import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useMutate, useProduct } from '../api/hooks';
import type { Price, Product } from '../api/types';
import { uploadAsset } from '../builder/panels/AssetsPanel';
import { Badge, Button, Select, Textarea } from '../ui';
import { amountHint, CURRENCIES, INTERVALS, parseAmount } from './money';
import { useToast } from './Toasts';
import { ConfirmDialog, ErrorBanner, fmtDate, Loading, Modal, TextField } from './ui';

const priceText = (p: Price) => `${p.formatted}${p.interval ? ` / ${p.intervalCount > 1 ? `${p.intervalCount} ` : ''}${p.interval}` : ''}${p.trialDays ? `, ${p.trialDays}-day trial` : ''}`;

export function SyncBadge({ product }: { product: Pick<Product, 'stripe'> }) {
  const s = product.stripe.syncState;
  const map = { not_connected: ['neutral', 'Not connected'], local: ['neutral', 'Not synced'], pending: ['warn', 'Sync pending'], synced: ['ok', 'Synced to Stripe'], error: ['danger', 'Sync failed'] } as const;
  const [tone, text] = map[s];
  return <Badge tone={tone}>{text}</Badge>;
}

interface PriceDraft { currency: string; amount: string; interval: string; trialDays: string; nickname: string }
const blankDraft = (type: Product['type'], currency = 'USD'): PriceDraft => ({ currency, amount: '', interval: type === 'subscription' ? 'month' : '', trialDays: '0', nickname: '' });

/** The price form (create, add, replace). The amount is typed in major units; the server applies the currency exponent. */
export function PriceForm({ type, draft, onChange, lockCurrency }: { type: Product['type']; draft: PriceDraft; onChange: (d: PriceDraft) => void; lockCurrency?: boolean }) {
  const parsed = draft.amount === '' ? null : parseAmount(draft.amount, draft.currency);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Price" inputMode="decimal" value={draft.amount} onChange={(amount) => onChange({ ...draft, amount })} error={draft.amount !== '' && parsed === null ? `Enter an amount. ${amountHint(draft.currency)}` : undefined} hint={amountHint(draft.currency)} />
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Currency</span>
        <Select aria-label="Currency" value={draft.currency} disabled={lockCurrency} options={CURRENCIES.map((c) => ({ value: c, label: c }))} onValueChange={(currency) => onChange({ ...draft, currency })} />
      </div>
      {type === 'subscription' ? (
        <>
          <div className="flex flex-col gap-1"><span className="text-sm font-semibold">Billing</span><Select aria-label="Billing interval" value={draft.interval} options={INTERVALS.map((i) => ({ value: i.value, label: i.label }))} onValueChange={(interval) => onChange({ ...draft, interval })} /></div>
          <TextField label="Free trial (days)" inputMode="numeric" value={draft.trialDays} onChange={(trialDays) => onChange({ ...draft, trialDays })} />
        </>
      ) : null}
      <div className="sm:col-span-2"><TextField label="Nickname (optional)" value={draft.nickname} onChange={(nickname) => onChange({ ...draft, nickname })} hint="Shown to you only, e.g. Launch price" /></div>
    </div>
  );
}

export const priceBody = (d: PriceDraft, type: Product['type']) => ({
  currency: d.currency, amount: parseAmount(d.amount, d.currency) ?? 0, ...(d.nickname.trim() ? { nickname: d.nickname.trim() } : {}),
  ...(type === 'subscription' ? { interval: d.interval, trialDays: Math.max(0, Math.min(730, Number.parseInt(d.trialDays, 10) || 0)) } : {}),
});

function ProductForm({ product, onClose }: { product?: Product; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [type, setType] = useState<Product['type']>(product?.type ?? 'one_time');
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [taxCode, setTaxCode] = useState(product?.taxCode ?? '');
  const [draft, setDraft] = useState<PriceDraft>(blankDraft(type));
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const create = useMutate((b: object) => api.post<Product>('/api/products', b), [['products']]);
  const save = useMutate((b: object) => api.patch<Product>(`/api/products/${product!.id}`, b), [['products']]);
  const nameErr = name.trim() ? undefined : 'Give the product a name';
  const amount = parseAmount(draft.amount, draft.currency);
  const priceErr = !product && amount === null ? 'Enter a price' : undefined;
  const taxErr = taxCode && !/^txcd_\d{8}$/.test(taxCode) ? 'A Stripe tax code looks like txcd_10000000' : undefined;
  const invalid = !!(nameErr || priceErr || taxErr);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const a = await uploadAsset(files[0]!);
      setImages((cur) => [...cur, a.url].slice(0, 8));
    } catch (e) {
      toast.push(errorMessage(e), 'error');
    } finally {
      setUploading(false);
    }
  };
  const submit = () => {
    const common = { name: name.trim(), description: description.trim(), images, taxCode: taxCode.trim() || null };
    if (product) save.mutate(common, { onSuccess: () => { toast.push('Product saved', 'ok'); onClose(); } });
    else create.mutate({ ...common, type, price: priceBody(draft, type) }, { onSuccess: () => { toast.push('Product created', 'ok'); onClose(); } });
  };
  const busy = create.isPending || save.isPending;
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); if (!invalid) submit(); }}>
      <ErrorBanner error={create.error ?? save.error} />
      <TextField label="Name" value={name} onChange={setName} error={nameErr} autoFocus />
      <div className="flex flex-col gap-1">
        <label htmlFor="p-desc" className="text-sm font-semibold">Description</label>
        <Textarea id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-20" />
      </div>
      {!product ? (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Type</span>
          <Select aria-label="Product type" value={type} options={[{ value: 'one_time', label: 'One-time purchase' }, { value: 'subscription', label: 'Subscription (recurring)' }]} onValueChange={(v) => { setType(v as Product['type']); setDraft(blankDraft(v as Product['type'], draft.currency)); }} />
        </div>
      ) : <p className="m-0 text-sm text-muted">Type: <strong>{product.type === 'subscription' ? 'Subscription' : 'One-time purchase'}</strong> (cannot change after creation)</p>}
      {!product ? <PriceForm type={type} draft={draft} onChange={setDraft} /> : null}
      {priceErr && draft.amount !== '' ? <p role="alert" className="m-0 text-sm text-danger">{priceErr}</p> : null}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Images</span>
        <div className="flex flex-wrap gap-2">
          {images.map((u, i) => (
            <div key={`${u}-${i}`} className="relative size-16 overflow-hidden rounded-md border border-border bg-surface-2">
              <img src={u} alt={`Product image ${i + 1}`} className="size-full object-cover" />
              <button type="button" aria-label={`Remove image ${i + 1}`} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-surface/90 text-danger" onClick={() => setImages(images.filter((_, k) => k !== i))}><Trash2 className="size-3" /></button>
            </div>
          ))}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" aria-label="Upload product image" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
          <Button size="sm" disabled={uploading || images.length >= 8} onClick={() => file.current?.click()}><ImageUp /> {uploading ? 'Uploading…' : 'Upload image'}</Button>
        </div>
        <span className="text-[0.82rem] text-muted">PNG, JPEG, GIF or WebP up to 1.5 MB. Images are shown by Stripe Checkout once the product is synced.</span>
      </div>
      <TextField label="Stripe tax code (optional)" value={taxCode} onChange={setTaxCode} error={taxErr} hint="For Stripe Tax, e.g. txcd_10000000 (general tangible goods)" />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || invalid}>{busy ? 'Saving…' : product ? 'Save changes' : 'Create product'}</Button>
      </div>
    </form>
  );
}

function PriceRow({ product, price }: { product: Product; price: Price }) {
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'replace'>('view');
  const [draft, setDraft] = useState<PriceDraft>({ ...blankDraft(product.type, price.currency), amount: String(price.amount), interval: price.interval ?? '', trialDays: String(price.trialDays), nickname: price.nickname ?? '' });
  const replace = useMutate((b: object) => api.post(`/api/products/${product.id}/prices/${price.id}/replace`, b), [['products']]);
  const archive = useMutate(() => api.post(`/api/products/${product.id}/prices/${price.id}/archive`), [['products']]);
  const [confirm, setConfirm] = useState(false);
  const amount = parseAmount(draft.amount, draft.currency);
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{priceText(price)}</strong>
        {price.nickname ? <span className="text-sm text-muted">{price.nickname}</span> : null}
        {product.defaultPriceId === price.id ? <Badge tone="primary">Default</Badge> : null}
        {!price.active ? <Badge>{price.replacedBy ? 'Replaced' : 'Archived'}</Badge> : null}
        <span className="flex-1" />
        {price.active && product.status === 'active' ? (
          <>
            <Button size="sm" onClick={() => setMode(mode === 'replace' ? 'view' : 'replace')} aria-label={`Change the price ${priceText(price)}`}>Change price</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Archive the price ${priceText(price)}`}>Archive</Button>
          </>
        ) : null}
      </div>
      {price.archivedAt ? <p className="m-0 mt-1 text-[0.8rem] text-muted">Archived {fmtDate(price.archivedAt)}. Orders made at this price keep it.</p> : null}
      {mode === 'replace' ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="m-0 text-[0.82rem] text-muted">Stripe prices cannot be edited, so this creates a new price and archives the old one. Pages and checkouts that use the old price switch to the new one; past orders keep theirs.</p>
          <ErrorBanner error={replace.error} />
          <PriceForm type={product.type} draft={draft} onChange={setDraft} lockCurrency />
          <div className="flex gap-2"><Button variant="primary" disabled={replace.isPending || amount === null} onClick={() => replace.mutate(priceBody(draft, product.type), { onSuccess: () => { toast.push('Price changed', 'ok'); setMode('view'); } })}>Save new price</Button><Button onClick={() => setMode('view')}>Cancel</Button></div>
        </div>
      ) : null}
      {confirm ? <ConfirmDialog title="Archive this price?" message="It stops being sold. A product keeps at least one active price." confirmLabel="Archive price" danger busy={archive.isPending} onCancel={() => setConfirm(false)} onConfirm={() => archive.mutate(undefined, { onSuccess: () => setConfirm(false), onError: (e) => { setConfirm(false); toast.push(errorMessage(e), 'error'); } })} /> : null}
    </li>
  );
}

function Prices({ product }: { product: Product }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<PriceDraft>(blankDraft(product.type, product.prices[0]?.currency));
  const add = useMutate((b: object) => api.post(`/api/products/${product.id}/prices`, b), [['products']]);
  const amount = parseAmount(draft.amount, draft.currency);
  return (
    <section aria-label="Prices" className="flex flex-col gap-2">
      <div className="flex items-center justify-between"><h3 className="m-0 text-sm font-semibold">Prices</h3>{product.status === 'active' ? <Button size="sm" onClick={() => setAdding(!adding)}>Add price</Button> : null}</div>
      {adding ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong p-3">
          <ErrorBanner error={add.error} />
          <PriceForm type={product.type} draft={draft} onChange={setDraft} />
          <div className="flex gap-2"><Button variant="primary" disabled={add.isPending || amount === null} onClick={() => add.mutate(priceBody(draft, product.type), { onSuccess: () => { toast.push('Price added', 'ok'); setAdding(false); } })}>Add price</Button><Button onClick={() => setAdding(false)}>Cancel</Button></div>
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {[...product.prices].sort((a, b) => Number(b.active) - Number(a.active) || a.createdAt.localeCompare(b.createdAt)).map((p) => <PriceRow key={p.id} product={product} price={p} />)}
      </ul>
    </section>
  );
}

function StripeBox({ product }: { product: Product }) {
  const toast = useToast();
  const sync = useMutate(() => api.post<{ result: string }>(`/api/products/${product.id}/sync`), [['products']]);
  const s = product.stripe;
  return (
    <section aria-label="Stripe" className="flex flex-col gap-2 rounded-lg bg-surface-2/60 p-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="m-0 text-sm font-semibold">Stripe</h3><SyncBadge product={product} /><span className="flex-1" />
        {s.syncState !== 'not_connected' ? <Button size="sm" disabled={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: (r) => toast.push(r.result === 'synced' ? 'Synced to Stripe' : 'Sync failed, see the message', r.result === 'synced' ? 'ok' : 'error') })}>{sync.isPending ? 'Syncing…' : 'Sync now'}</Button> : null}
      </div>
      {s.syncState === 'not_connected' ? <p className="m-0 text-[0.85rem] text-muted">Stripe is not connected for this workspace. The product works in your catalog and in checkouts; connect Stripe in Settings to mirror it as a Stripe product with prices.</p> : null}
      {s.error ? <p role="alert" className="m-0 text-[0.85rem] text-danger">{s.error}</p> : null}
      {s.productId ? <p className="m-0 text-[0.8rem] text-muted">Stripe product <code>{s.productId}</code>{s.syncedAt ? `, last synced ${fmtDate(s.syncedAt)}` : ''}</p> : null}
    </section>
  );
}

/** Create or edit a product in a side drawer: details, prices (immutable: changing an amount replaces the price), images, Stripe sync state, archive. */
export function ProductEditor({ productId, onClose }: { productId: string | 'new'; onClose: () => void }) {
  const q = useProduct(productId === 'new' ? null : productId);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const archive = useMutate((status: 'archive' | 'restore') => api.post(`/api/products/${productId}/${status}`), [['products']]);
  const p = q.data;
  return (
    <Modal side title={productId === 'new' ? 'New product' : p ? p.name : 'Product'} onClose={onClose}>
      {productId !== 'new' && q.isLoading ? <Loading rows={4} /> : null}
      <ErrorBanner error={q.error} onRetry={() => void q.refetch()} />
      {productId === 'new' ? <ProductForm onClose={onClose} /> : null}
      {p ? (
        <div className="flex flex-col gap-5">
          {p.status === 'archived' ? <div className="alert warn" role="status">This product is archived. Checkouts that use it show &ldquo;no longer available&rdquo;; pages still render. <Button size="sm" onClick={() => archive.mutate('restore', { onSuccess: () => toast.push('Restored', 'ok') })}>Restore</Button></div> : null}
          <ProductForm key={p.updatedAt} product={p} onClose={onClose} />
          <Prices product={p} />
          <StripeBox product={p} />
          <p className="m-0 text-[0.82rem] text-muted">{p.orderCount} order{p.orderCount === 1 ? '' : 's'} so far. Products are never deleted, only archived, because orders refer to them.</p>
          {p.status === 'active' ? <div><Button variant="danger" onClick={() => setConfirm(true)}>Archive product</Button></div> : null}
          {confirm ? <ConfirmDialog title="Archive this product?" message="It disappears from pickers and checkouts that use it will refuse with a friendly message. Pages keep rendering and past orders keep their link. You can restore it later." confirmLabel="Archive" danger busy={archive.isPending} onCancel={() => setConfirm(false)} onConfirm={() => archive.mutate('archive', { onSuccess: () => { setConfirm(false); toast.push('Archived', 'ok'); } })} /> : null}
        </div>
      ) : null}
    </Modal>
  );
}
