import { Check } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { keys, useMutate, useProducts } from '../api/hooks';
import type { FunnelDetail, Product, Step } from '../api/types';
import { Button, cn, Select } from '../ui';
import { amountHint, CURRENCIES, INTERVALS, parseAmount } from './money';
import { ErrorBanner, fmtMoney, Modal, TextField } from './ui';

type Ref = { mode: 'existing'; priceId: string } | { mode: 'new'; name: string; amount: string; currency: string; type: 'one_time' | 'subscription'; interval: string };
const blank = (): Ref => ({ mode: 'new', name: '', amount: '', currency: 'USD', type: 'one_time', interval: 'month' });

export const refToBody = (r: Ref) => (r.mode === 'existing' ? { priceId: r.priceId } : { create: { name: r.name.trim(), amount: parseAmount(r.amount, r.currency) ?? 0, currency: r.currency, type: r.type, ...(r.type === 'subscription' ? { interval: r.interval } : {}) } });
export const refValid = (r: Ref | null): boolean => r !== null && (r.mode === 'existing' ? !!r.priceId : !!r.name.trim() && (parseAmount(r.amount, r.currency) ?? 0) > 0);

function RefField({ legend, value, onChange, products, oneTime }: { legend: string; value: Ref; onChange: (r: Ref) => void; products: Product[]; oneTime?: boolean }) {
  const options = products.flatMap((p) => p.prices.filter((x) => x.active && !(oneTime && x.interval)).map((x) => ({ value: x.id, label: `${p.name}: ${x.formatted}${x.interval ? ` / ${x.interval}` : ''}` })));
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{legend}</legend>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5"><input type="radio" name={legend} checked={value.mode === 'existing'} disabled={options.length === 0} onChange={() => onChange({ mode: 'existing', priceId: options[0]?.value ?? '' })} /> Existing product</label>
        <label className="flex items-center gap-1.5"><input type="radio" name={legend} checked={value.mode === 'new'} onChange={() => onChange(blank())} /> New product</label>
      </div>
      {value.mode === 'existing' ? <Select aria-label={`${legend}: product`} value={value.priceId} options={options} onValueChange={(priceId) => onChange({ mode: 'existing', priceId })} /> : (
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem_6rem]">
          <TextField label="Name" value={value.name} onChange={(name) => onChange({ ...value, name })} />
          <TextField label="Price" inputMode="decimal" value={value.amount} onChange={(amount) => onChange({ ...value, amount })} error={value.amount !== '' && parseAmount(value.amount, value.currency) === null ? amountHint(value.currency) : undefined} />
          <div className="flex flex-col gap-1"><span className="text-sm font-semibold">Currency</span><Select aria-label={`${legend}: currency`} value={value.currency} options={CURRENCIES.map((c) => ({ value: c, label: c }))} onValueChange={(currency) => onChange({ ...value, currency })} /></div>
          {!oneTime ? (
            <div className="flex gap-2 sm:col-span-3">
              <Select aria-label={`${legend}: type`} value={value.type} options={[{ value: 'one_time', label: 'One-time' }, { value: 'subscription', label: 'Subscription' }]} onValueChange={(type) => onChange({ ...value, type: type as 'one_time' | 'subscription' })} />
              {value.type === 'subscription' ? <Select aria-label={`${legend}: billing`} value={value.interval} options={INTERVALS.map((i) => ({ value: i.value, label: i.label }))} onValueChange={(interval) => onChange({ ...value, interval })} /> : null}
            </div>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}

const STEPS = ['Product', 'Layout', 'Bump', 'Upsell', 'Thank you'] as const;

/**
 * "Add payments to this funnel": pick or create the product, choose one page or an offer page plus a checkout page, then optionally an order bump, a one-click upsell
 * (and a downsell for those who decline) and a thank-you page. One request builds and wires everything; every page stays editable.
 */
export function PaymentsWizard({ funnel, defaultStepId, onClose, onDone }: { funnel: Pick<FunnelDetail, 'id' | 'name' | 'steps'>; defaultStepId?: string; onClose: () => void; onDone: (r: { checkoutStepId: string; added: { id: string; name: string }[] }) => void }) {
  const products = useProducts({ status: 'active', limit: 100 });
  const list = products.data?.data ?? [];
  const [i, setI] = useState(0);
  const [product, setProduct] = useState<Ref>(blank());
  const [layout, setLayout] = useState<'one-step' | 'two-step'>('one-step');
  const [stepId, setStepId] = useState<string>(defaultStepId ?? '');
  const [bump, setBump] = useState<Ref | null>(null);
  const [upsell, setUpsell] = useState<Ref | null>(null);
  const [downsell, setDownsell] = useState<Ref | null>(null);
  const [thanks, setThanks] = useState(true);
  const run = useMutate((b: object) => api.post<{ checkoutStepId: string; added: { id: string; name: string }[] }>(`/api/funnels/${funnel.id}/payments`, b), [keys.funnel(funnel.id), keys.funnels, ['products']]);
  const valid = [refValid(product), true, bump === null || refValid(bump), (upsell === null || refValid(upsell)) && (downsell === null || (upsell !== null && refValid(downsell))), true];
  const last = i === STEPS.length - 1;
  const submit = () => run.mutate({ layout, ...(stepId ? { stepId } : {}), product: refToBody(product), ...(bump ? { bump: refToBody(bump) } : {}), ...(upsell ? { upsell: refToBody(upsell) } : {}), ...(downsell && upsell ? { downsell: refToBody(downsell) } : {}), thankYou: thanks }, { onSuccess: onDone });
  const target = funnel.steps.find((s: Step) => s.id === stepId);
  const summary = [
    `${layout === 'one-step' ? 'One page' : 'Offer page, then checkout page'}${target ? ` (starting on "${target.name}")` : ' (new pages)'}`,
    bump ? 'order bump' : null, upsell ? 'one-click upsell' : null, downsell ? 'downsell' : null, thanks ? 'thank-you page' : null,
  ].filter(Boolean).join(', ');
  return (
    <Modal
      wide
      title="Add payments to this funnel"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {i > 0 ? <Button onClick={() => setI(i - 1)}>Back</Button> : null}
          {last ? <Button variant="primary" disabled={run.isPending || !valid.every(Boolean)} onClick={submit}>{run.isPending ? 'Adding…' : 'Add payments'}</Button> : <Button variant="primary" disabled={!valid[i]} onClick={() => setI(i + 1)}>Next</Button>}
        </>
      }
    >
      <ol className="m-0 mb-4 flex list-none flex-wrap gap-2 p-0" aria-label="Steps of the wizard">
        {STEPS.map((s, k) => <li key={s} aria-current={k === i ? 'step' : undefined} className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8rem] font-semibold', k === i ? 'bg-primary-soft text-primary' : k < i ? 'text-ok' : 'text-muted')}>{k < i ? <Check className="size-3.5" aria-hidden="true" /> : <span aria-hidden="true">{k + 1}</span>} {s}</li>)}
      </ol>
      <ErrorBanner error={run.error} />
      <div className="flex flex-col gap-4">
        {i === 0 ? <><p className="m-0 text-sm text-muted">What are you selling? Its price comes from your product catalog.</p><RefField legend="Product" value={product} onChange={setProduct} products={list} /></> : null}
        {i === 1 ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold">Layout</legend>
              {([['one-step', 'One step', 'The product and the payment form on one page.'], ['two-step', 'Two steps', 'An offer page first, then a separate checkout page.']] as const).map(([v, t, d]) => (
                <label key={v} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3', layout === v ? 'border-primary bg-primary-soft/40' : 'border-border')}><input type="radio" name="layout" checked={layout === v} onChange={() => setLayout(v)} className="mt-1" /><span><strong className="text-sm">{t}</strong><span className="block text-[0.85rem] text-muted">{d}</span></span></label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1"><span className="text-sm font-semibold">Where does it go?</span>
              <Select aria-label="Page for the checkout" value={stepId} options={[{ value: '', label: 'Create new pages at the end' }, ...funnel.steps.map((s) => ({ value: s.id, label: `Add to "${s.name}"` }))]} onValueChange={setStepId} />
              <span className="text-[0.82rem] text-muted">Adding to an existing page appends the offer at its end; nothing you wrote is changed.</span></div>
          </>
        ) : null}
        {i === 2 ? (
          <>
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={bump !== null} onChange={(e) => setBump(e.target.checked ? blank() : null)} /> Offer an order bump (a checkbox add-on at checkout)</label>
            {bump ? <RefField legend="Order bump" value={bump} onChange={setBump} products={list} /> : <p className="m-0 text-sm text-muted">Bumps raise the average order. You can add or change one later in the builder.</p>}
          </>
        ) : null}
        {i === 3 ? (
          <>
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={upsell !== null} onChange={(e) => { setUpsell(e.target.checked ? blank() : null); if (!e.target.checked) setDownsell(null); }} /> Add a one-click upsell after the purchase</label>
            {upsell ? <RefField legend="Upsell" value={upsell} onChange={setUpsell} products={list} oneTime /> : null}
            {upsell ? <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={downsell !== null} onChange={(e) => setDownsell(e.target.checked ? blank() : null)} /> Add a downsell for buyers who decline the upsell</label> : null}
            {downsell ? <RefField legend="Downsell" value={downsell} onChange={setDownsell} products={list} oneTime /> : null}
            <p className="m-0 text-sm text-muted">One-click offers charge the card the buyer just used, so they must be one-time products.</p>
          </>
        ) : null}
        {i === 4 ? (
          <>
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={thanks} onChange={(e) => setThanks(e.target.checked)} /> Add a thank-you page</label>
            <div className="rounded-lg bg-surface-2/60 p-3 text-sm" aria-label="Summary"><strong>Summary.</strong> {summary}. {product.mode === 'existing' ? (() => { const pr = list.flatMap((p) => p.prices).find((x) => x.id === product.priceId); return pr ? `Sells at ${fmtMoney(pr.amount, pr.currency)}.` : ''; })() : ''} Pages are added as normal steps you can edit in the builder.</div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
