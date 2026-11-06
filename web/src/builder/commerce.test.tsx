import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanProject, createPageBuilder } from '@pagemodel';
import { ToastProvider } from '../components/Toasts';
import { Payments as PaymentsSettings } from '../pages/settings/Payments';
import { BLOCKS } from './editor/blocks';
import { createEditor } from './editor/createEditor';
import { loadDoc, readProject } from './editor/load';
import { blockIcon, BLOCK_ICONS } from './blockIcons';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
afterEach(() => vi.unstubAllGlobals());

describe('cart and Payment form blocks in the builder', () => {
  it('are in the Conversion category with their own icons, and dropped blocks save as a valid page with unique ids', () => {
    for (const id of ['payment-form', 'add-to-cart', 'cart', 'cart-count']) {
      const b = BLOCKS.find((x) => x.id === id)!;
      expect(b, id).toBeTruthy();
      expect(b.category).toBe('Conversion');
      expect(BLOCK_ICONS[b.icon], `${id} icon ${b.icon}`).toBeTruthy();
      expect(blockIcon(b.icon)).toBe(BLOCK_ICONS[b.icon]);
    }
    const ed = createEditor(null, { funnelId: 'f', stepId: 's', steps: [], canScripts: false }, { headless: true });
    expect(loadDoc(ed, { version: 2, project: createPageBuilder('t').project([]) }).ok).toBe(true);
    const content = (id: string) => ed.Blocks.get(id)!.get('content') as never;
    ed.addComponents([content('add-to-cart'), content('add-to-cart'), content('cart'), content('cart-count'), content('payment-form')]);
    const r = cleanProject(readProject(ed));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commerce.map((c) => c.type)).toEqual(['cart-add', 'cart-add', 'cart', 'payment']);
    expect(new Set(r.commerce.map((c) => c.id)).size).toBe(4);
    expect(r.commerce.find((c) => c.type === 'payment')).toMatchObject({ source: 'cart', mode: 'embedded' });
    ed.destroy();
  });
});

describe('Settings > Payments', () => {
  const status = (embedded: object, provider = 'stripe') => ({
    provider, mode: provider === 'stripe' ? 'test' : null, state: 'connected', stale: false, settings: { statementDescriptor: null, receiptEmails: false, taxEnabled: false }, testCards: [], webhooks: { platform: true, connect: true },
    connect: { accountId: 'acct_1', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, requirementsDue: [], disabledReason: null }, account: null, embedded,
  });
  const show = async (body: object) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(body)));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider><PaymentsSettings /></ToastProvider></QueryClientProvider>);
    return screen.findByRole('group', { name: 'Payment form on your pages' });
  };

  it('says when the card fields can be shown on the page, and the steps left when not', async () => {
    const g = await show(status({ ready: false, mode: 'hosted_fallback', publishableKey: false, connected: true, chargesEnabled: true, webhookEvents: [], steps: ['The server administrator adds STRIPE_PUBLISHABLE_KEY.'] }));
    expect(g).toHaveTextContent('Not ready yet');
    expect(g).toHaveTextContent('✗ Publishable key');
    expect(g).toHaveTextContent('✓ Charges enabled');
    expect(g).toHaveTextContent('STRIPE_PUBLISHABLE_KEY');
  });
});
