import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Component, Editor, Trait } from 'grapesjs';
import { useEffect, useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanProject, createPageBuilder, type CatalogProps } from '@pagemodel';
import type { Price, Product } from '../api/types';
import { TooltipProvider } from '../ui';
import { BLOCKS } from './editor/blocks';
import { createEditor } from './editor/createEditor';
import { getEnv } from './editor/env';
import { loadDoc, readProject } from './editor/load';
import { blockIcon, BLOCK_ICONS } from './blockIcons';
import { catalogItemsOf } from './catalog';
import { CatalogTrait } from './panels/traits';
import { BuilderProvider, type BuilderUi } from './useEditor';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, session: { user: { permissions: [] }, workspace: { name: 'W' } } }) }));

const price = (id: string, over: Partial<Price> = {}): Price => ({ id, productId: 'p', currency: 'USD', unitAmount: 1000, exponent: 2, amount: 10, formatted: '$10.00', interval: null, intervalCount: 1, trialDays: 0, nickname: null, active: true, replacedBy: null, stripe: { priceId: null, status: 'local' }, createdAt: '', archivedAt: null, ...over });
const product = (id: string, name: string, prices: Price[], over: Partial<Product> = {}): Product => ({
  id, name, description: `${name} text`, images: [], imageAlt: '', status: 'active', type: 'one_time', taxCode: null, metadata: {}, defaultPriceId: prices[0]?.id ?? null, prices,
  stripe: { productId: null, syncState: 'not_connected', error: null, syncedAt: null }, orderCount: 0, createdAt: '2026-01-01', updatedAt: '', archivedAt: null, ...over,
});
const PRODUCTS = [
  product('prd_mug001', 'Mug', [price('prc_mug001', { amount: 24, formatted: '$24.00' })], { images: ['/uploads/a/mug.png'], imageAlt: 'A mug' }),
  product('prd_tee001', 'T-shirt', [price('prc_teeold', { active: false, replacedBy: 'prc_tee001' }), price('prc_tee001', { amount: 12, formatted: '$12.00' })], { defaultPriceId: 'prc_tee001' }),
  product('prd_club01', 'Coffee club', [price('prc_club01', { interval: 'month' })], { type: 'subscription' }),
  product('prd_old001', 'Old thing', [price('prc_old001')], { status: 'archived' }),
];
/** The inspector re-renders a trait editor when its value changes; this does the same for a trait editor mounted on its own. */
function Live({ editor, comp }: { editor: Editor; comp: Component }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { comp.on('change:fnCatalog', bump); return () => { comp.off('change:fnCatalog', bump); }; }, [comp]);
  return <CatalogTrait editor={editor} component={comp} trait={comp.getTrait('fnCatalog') as Trait} />;
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe('Product catalog block in the builder', () => {
  it('is in the Conversion category with its icon, saves as a commerce block, and previews real products (or samples)', () => {
    const b = BLOCKS.find((x) => x.id === 'product-catalog')!;
    expect(b.category).toBe('Conversion');
    expect(BLOCK_ICONS[b.icon]).toBeTruthy();
    expect(blockIcon(b.icon)).toBe(BLOCK_ICONS.Store);
    const ed = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, { headless: true });
    expect(loadDoc(ed, { version: 2, project: createPageBuilder('t').project([]) }).ok).toBe(true);
    ed.addComponents([ed.Blocks.get('product-catalog')!.get('content') as never, ed.Blocks.get('product-catalog')!.get('content') as never]);
    const r = cleanProject(readProject(ed));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commerce.map((c) => c.type)).toEqual(['catalog', 'catalog']);
    expect(new Set(r.commerce.map((c) => c.id)).size).toBe(2);
    ed.destroy();
  });

  it('lists only active one-time products, under the price that replaced an old one', () => {
    const items = catalogItemsOf(PRODUCTS);
    expect(items.map((i) => i.name)).toEqual(['Mug', 'T-shirt']);
    expect(items[0]).toMatchObject({ image: '/uploads/a/mug.png', imageAlt: 'A mug' });
    expect(items[1]!.prices).toEqual([{ id: 'prc_tee001', amount: 12, currency: 'USD', replaces: ['prc_teeold'] }]);
  });
});

describe('Product catalog settings', () => {
  const ui: BuilderUi = { openAssets: vi.fn(), openShortcuts: vi.fn(), openPageSettings: vi.fn(), openHistory: vi.fn(), saveBlock: vi.fn(), toast: vi.fn(), save: vi.fn(async () => undefined), goToStep: vi.fn() };
  let editor: Editor;
  afterEach(() => editor?.destroy());

  function mount() {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: PRODUCTS, pagination: { page: 1, limit: 100, total: 4, totalPages: 1 }, stripe: { connected: false, chargesEnabled: false } })));
    const steps = [{ id: 's', name: 'Shop' }, { id: 'c', name: 'Cart' }, { id: 'p', name: 'Checkout' }];
    editor = createEditor(null, { funnelId: 'f', stepId: 's', steps, canScripts: false }, { headless: true });
    const pm = createPageBuilder('t');
    expect(loadDoc(editor, { version: 2, project: pm.project([pm.section([pm.stack([pm.catalog('cat')])])]) }).ok).toBe(true);
    const all = (c: Component): Component[] => [c, ...c.components().models.flatMap(all)];
    const comp = all(editor.getWrapper()!).find((c) => c.get('type') === 'fn-catalog')!;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <BuilderProvider value={{ editor, env: { funnelId: 'f', stepId: 's', steps, canScripts: false }, ui }}><Live editor={editor} comp={comp} /></BuilderProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    return { value: () => comp.get('fnCatalog') as CatalogProps };
  }

  it('edits every setting and keeps the value valid for the server schema', async () => {
    const { value } = mount();
    fireEvent.change(screen.getByLabelText('Most products shown'), { target: { value: '30' } });
    expect(value().limit).toBe(24); // clamped to the maximum
    fireEvent.change(screen.getByLabelText('Catalog button text'), { target: { value: 'Add to bag' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Show the description' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Let buyers choose a quantity' }));
    fireEvent.change(screen.getByLabelText('Empty catalog text'), { target: { value: 'Back soon' } });
    expect(value()).toMatchObject({ limit: 24, buttonLabel: 'Add to bag', showDescription: false, showImage: true, quantity: { enabled: true }, emptyText: 'Back soon' });
    expect(screen.getByLabelText('Catalog quantity max')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    for (const label of ['Which products', 'Sort products', 'Columns on desktop', 'Button action', 'After adding a product']) expect(screen.getByRole('combobox', { name: label })).toBeInTheDocument();
  });
});

describe('Product catalog picks panel', () => {
  it('shows picked products in order with prices and notes, moves and removes them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: PRODUCTS, pagination: { page: 1, limit: 100, total: 4, totalPages: 1 }, stripe: { connected: false, chargesEnabled: false } })));
    const steps = [{ id: 's', name: 'Shop' }, { id: 'p', name: 'Checkout' }];
    const editor = createEditor(null, { funnelId: 'f', stepId: 's', steps, canScripts: false }, { headless: true });
    const pm = createPageBuilder('t');
    expect(loadDoc(editor, { version: 2, project: pm.project([pm.section([pm.stack([pm.catalog('cat', { source: 'picked', action: 'buy', buttonLabel: 'Buy now', picks: [{ productId: 'prd_tee001' }, { productId: 'prd_mug001' }, { productId: 'prd_old001' }] })])])]) }).ok).toBe(true);
    const all = (c: Component): Component[] => [c, ...c.components().models.flatMap(all)];
    const comp = all(editor.getWrapper()!).find((c) => c.get('type') === 'fn-catalog')!;
    const ui: BuilderUi = { openAssets: vi.fn(), openShortcuts: vi.fn(), openPageSettings: vi.fn(), openHistory: vi.fn(), saveBlock: vi.fn(), toast: vi.fn(), save: vi.fn(async () => undefined), goToStep: vi.fn() };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <BuilderProvider value={{ editor, env: { funnelId: 'f', stepId: 's', steps, canScripts: false }, ui }}><Live editor={editor} comp={comp} /></BuilderProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const list = await screen.findByRole('list', { name: 'Picked products' });
    await within(list).findByText('Mug');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('T-shirt$12.00'), expect.stringContaining('Mug$24.00'), expect.stringContaining('Archived: not shown')]);
    expect(screen.getByRole('combobox', { name: 'Checkout step' })).toBeInTheDocument(); // Buy now: where to go after adding
    expect(screen.queryByRole('combobox', { name: 'Sort products' })).toBeNull(); // sorting is for "all products"
    fireEvent.click(screen.getByRole('button', { name: 'Move Mug up' }));
    expect((comp.get('fnCatalog') as CatalogProps).picks.map((p) => p.productId)).toEqual(['prd_mug001', 'prd_tee001', 'prd_old001']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Old thing' }));
    expect((comp.get('fnCatalog') as CatalogProps).picks.map((p) => p.productId)).toEqual(['prd_mug001', 'prd_tee001']);
    expect(screen.getByRole('button', { name: 'Add a product' })).toBeEnabled();
    // The canvas preview follows the loaded catalog.
    getEnv(editor).catalog = catalogItemsOf(PRODUCTS);
    editor.trigger('fn:catalog');
    editor.destroy();
  });
});
