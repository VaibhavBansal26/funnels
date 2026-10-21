import { ExternalLink, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useMutate, useProducts } from '../../api/hooks';
import type { Price, Product } from '../../api/types';
import { amountHint, CURRENCIES, INTERVALS, parseAmount } from '../../components/money';
import { Button, Dialog, Input, Select } from '../../ui';
import type { ProductProps } from '../pagemodel-bridge';
import { inputCls } from './kit';

export type Role = 'main' | 'bump' | 'upsell' | 'downsell';

/** The block fields that mirror a catalog price. The server refreshes them from the catalog on every save; they are only what the page shows until then. */
export function fieldsFor(product: Pick<Product, 'id' | 'name'>, price: Price): Partial<ProductProps> {
  return {
    productId: product.id, priceId: price.id, productName: product.name, price: price.amount, currency: price.currency,
    interval: price.interval ?? undefined, trialDays: price.interval ? price.trialDays : undefined,
  } as Partial<ProductProps>;
}

const label = (p: Price) => `${p.formatted}${p.interval ? ` / ${p.interval}` : ''}${p.trialDays ? `, ${p.trialDays}-day trial` : ''}${p.nickname ? ` (${p.nickname})` : ''}`;

function CreateInline({ role, onCreated }: { role: Role; onCreated: (p: Product) => void }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [type, setType] = useState<'one_time' | 'subscription'>('one_time');
  const [interval, setInterval] = useState('month');
  const create = useMutate((b: object) => api.post<Product>('/api/products', b), [['products']]);
  const parsed = parseAmount(amount, currency);
  const oneClick = role === 'upsell' || role === 'downsell';
  return (
    <form className="flex flex-col gap-2.5 rounded-lg border border-dashed border-border-strong p-3" aria-label="Create a product" onSubmit={(e) => { e.preventDefault(); if (name.trim() && parsed !== null) create.mutate({ name: name.trim(), type, price: { currency, amount: parsed, ...(type === 'subscription' ? { interval } : {}) } }, { onSuccess: onCreated }); }}>
      <strong className="text-[0.82rem]">Create a new product</strong>
      <Input aria-label="New product name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Input aria-label="New product price" inputMode="decimal" placeholder="Price" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && parsed === null ? true : undefined} />
        <Select aria-label="New product currency" value={currency} options={CURRENCIES.map((c) => ({ value: c, label: c }))} onValueChange={setCurrency} />
      </div>
      <span className="text-[0.75rem] text-muted">{amountHint(currency)}</span>
      {!oneClick ? (
        <div className="grid grid-cols-2 gap-2">
          <Select aria-label="New product type" value={type} options={[{ value: 'one_time', label: 'One-time' }, { value: 'subscription', label: 'Subscription' }]} onValueChange={(v) => setType(v as typeof type)} />
          {type === 'subscription' ? <Select aria-label="New product billing" value={interval} options={INTERVALS.map((i) => ({ value: i.value, label: i.label }))} onValueChange={setInterval} /> : <span />}
        </div>
      ) : null}
      {create.error ? <span role="alert" className="text-[0.78rem] text-danger">{errorMessage(create.error)}</span> : null}
      <Button size="sm" variant="primary" type="submit" disabled={create.isPending || !name.trim() || parsed === null}><Plus /> {create.isPending ? 'Creating…' : 'Create and use'}</Button>
    </form>
  );
}

/**
 * Pick the catalog product and price a checkout block sells (or create one without leaving the builder). One-click upsells and downsells cannot be
 * subscriptions, so those prices are hidden for them. Choosing writes the display fields; the server resolves the real amount from the price.
 */
export function ProductPickerDialog({ open, role, onClose, onPick }: { open: boolean; role: Role; onClose: () => void; onPick: (fields: Partial<ProductProps>) => void }) {
  const [search, setSearch] = useState('');
  const q = useProducts({ status: 'active', search: search.trim() || undefined, limit: 30 });
  const oneClick = role === 'upsell' || role === 'downsell';
  const choose = (p: Product, price: Price) => {
    onPick(fieldsFor(p, price));
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Choose a product" description="Prices come from your catalog: change one there and every checkout that uses it follows." size="md" side="right">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <label htmlFor="pp-search" className="sr-only">Search products</label>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input id="pp-search" className="pl-9" placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {q.error ? <p role="alert" className="m-0 text-sm text-danger">{errorMessage(q.error)}</p> : null}
        {q.isLoading ? <p className="m-0 text-sm text-muted" role="status">Loading products…</p> : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Products">
          {q.data?.data.map((p) => {
            const prices = p.prices.filter((x) => x.active && !(oneClick && x.interval));
            if (!prices.length) return null;
            return (
              <li key={p.id} className="rounded-lg border border-border p-2.5">
                <div className="text-sm font-semibold">{p.name}</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {prices.map((pr) => <Button key={pr.id} size="sm" onClick={() => choose(p, pr)} aria-label={`Use ${p.name}, ${label(pr)}`}>{label(pr)}</Button>)}
                </div>
              </li>
            );
          })}
        </ul>
        {q.data && q.data.data.length === 0 ? <p className="m-0 text-sm text-muted">No products yet: create one below.</p> : null}
        <CreateInline role={role} onCreated={(p) => choose(p, p.prices[0]!)} />
        <a href="/products" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[0.82rem] text-primary"><ExternalLink className="size-3.5" aria-hidden="true" /> Manage products (opens a new tab)</a>
      </div>
    </Dialog>
  );
}

export function StepSelect({ label: l, value, steps, onChange, exclude }: { label: string; value: string | undefined; steps: { id: string; name: string }[]; onChange: (v: string | undefined) => void; exclude?: string }) {
  return (
    <Select size="sm" aria-label={l} value={value ?? ''} options={[{ value: '', label: 'The next step' }, ...steps.filter((s) => s.id !== exclude).map((s) => ({ value: s.id, label: s.name }))]} onValueChange={(v) => onChange(v || undefined)} />
  );
}

export const smallInput = inputCls;
