import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { keys, useMutate, useProducts } from '../api/hooks';
import type { FunnelDetail, Price, Product, TemplateProductSlot, TemplateSummary } from '../api/types';
import { Button, Select } from '../ui';
import { ErrorBanner, fmtMoney, Modal, TextField } from './ui';

type Choice = { kind: 'create' } | { kind: 'price'; priceId: string };

const every = (p: Pick<Price, 'interval' | 'intervalCount'>) => (p.interval ? ` / ${p.intervalCount > 1 ? `${p.intervalCount} ` : ''}${p.interval}` : '');
export const roleLabel = (r: TemplateProductSlot['role']) => ({ main: 'Main offer', bump: 'Order bump', upsell: 'One-click upsell', downsell: 'One-click downsell' })[r];

/** Prices a slot can use: one-click offers cannot be subscriptions. */
export function priceOptions(products: Product[], slot: TemplateProductSlot): { value: string; label: string }[] {
  return products
    .filter((p) => p.status === 'active')
    .flatMap((p) => p.prices.filter((pr) => pr.active && !(pr.interval && (slot.role === 'upsell' || slot.role === 'downsell'))).map((pr) => ({ value: pr.id, label: `${p.name}: ${fmtMoney(pr.amount, pr.currency)}${every(pr)}` })));
}

/**
 * "Use this template": names the funnel and, when the template has checkout steps, asks which catalog product each product slot sells (the default creates the
 * products from the template's sample offers, reusing equal ones). Nothing is created until "Create funnel".
 */
export function UseTemplateWizard({ template, onClose, onCreated }: { template: TemplateSummary; onClose: () => void; onCreated: (f: FunnelDetail) => void }) {
  const [name, setName] = useState(template.name);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const products = useProducts({ status: 'active', limit: 100 });
  const slots = template.products;
  const create = useMutate(
    (body: { name: string; bindings: Record<string, { priceId: string } | { create: true }> }) => api.post<FunnelDetail>(`/api/templates/${template.id}/use`, body),
    [keys.funnels, ['products']],
  );
  const bindings = useMemo(() => Object.fromEntries(slots.map((s) => [s.key, (choices[s.key] ?? { kind: 'create' }).kind === 'price' ? { priceId: (choices[s.key] as { priceId: string }).priceId } : { create: true as const }])), [slots, choices]);
  const empty = !name.trim();
  return (
    <Modal
      title={`Use "${template.name}"`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={create.isPending || empty} onClick={() => create.mutate({ name: name.trim(), bindings }, { onSuccess: onCreated })}>{create.isPending ? 'Creating…' : 'Create funnel'}</Button></>}
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (!empty) create.mutate({ name: name.trim(), bindings }, { onSuccess: onCreated }); }}>
        <ErrorBanner error={create.error} />
        <TextField label="Funnel name" value={name} onChange={setName} error={empty ? 'Give the funnel a name' : undefined} hint={`It starts as a test funnel with ${template.stepCount} step${template.stepCount === 1 ? '' : 's'}; you can edit every page afterwards.`} autoFocus />
        {slots.length ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold">Products this funnel sells</legend>
            <p className="m-0 text-[0.82rem] text-muted">The checkout steps use products from your catalog. Pick an existing one or let the template create its sample product (you can change the price later in Products).</p>
            {products.error ? <p role="alert" className="m-0 text-[0.82rem] text-danger">{errorMessage(products.error)}</p> : null}
            {slots.map((s) => {
              const choice = choices[s.key] ?? { kind: 'create' as const };
              const options = priceOptions(products.data?.data ?? [], s);
              return (
                <div key={s.key} className="rounded-md bg-surface-2/60 p-2.5" role="group" aria-label={`${roleLabel(s.role)}: ${s.name}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <strong className="text-sm">{s.name}</strong>
                    <span className="text-xs text-muted">{roleLabel(s.role)}</span>
                  </div>
                  <label className="mt-1.5 flex items-center gap-2 text-sm"><input type="radio" name={`slot-${s.key}`} checked={choice.kind === 'create'} onChange={() => setChoices({ ...choices, [s.key]: { kind: 'create' } })} /> Create it: {fmtMoney(s.amount, s.currency)}{s.type === 'subscription' ? ` / ${s.interval}` : ''}{s.trialDays ? `, ${s.trialDays}-day trial` : ''}</label>
                  <label className="mt-1 flex items-center gap-2 text-sm"><input type="radio" name={`slot-${s.key}`} checked={choice.kind === 'price'} disabled={options.length === 0} onChange={() => setChoices({ ...choices, [s.key]: { kind: 'price', priceId: options[0]!.value } })} /> Use a product from my catalog{options.length === 0 ? <span className="text-xs text-muted"> (none available)</span> : null}</label>
                  {choice.kind === 'price' ? <div className="mt-1.5 pl-6"><Select size="sm" aria-label={`Product for ${s.name}`} value={choice.priceId} options={options} onValueChange={(priceId) => setChoices({ ...choices, [s.key]: { kind: 'price', priceId } })} /></div> : null}
                </div>
              );
            })}
          </fieldset>
        ) : null}
      </form>
    </Modal>
  );
}
