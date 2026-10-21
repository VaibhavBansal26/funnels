import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressOptions } from '../api/golive';
import type { FunnelDetail } from '../api/types';
import { ToastProvider } from './Toasts';
import { GoLivePanel } from './GoLive';

const calls: { method: string; path: string; body?: unknown }[] = [];
let addresses: AddressOptions;
let failNext: Error | null = null;

vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return {
    ...real,
    api: {
      get: async (path: string) => (path.endsWith('/addresses') ? addresses : null),
      post: async (path: string, body?: unknown) => {
        calls.push({ method: 'POST', path, body });
        if (failNext) throw failNext;
        return {};
      },
      patch: async (path: string, body?: unknown) => {
        calls.push({ method: 'PATCH', path, body });
        return {};
      },
    },
  };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const funnel = { id: 'fn_1', name: 'Promo', status: 'test' } as FunnelDetail;
const pages = { kind: 'pages' as const, domainId: null, label: 'Cloudflare Pages address (free)', url: 'https://fn-abc.pages.dev/promo', host: 'fn-abc.pages.dev', available: true, reason: null, status: null, selected: false };
const custom = { kind: 'custom' as const, domainId: 'dom_1', label: 'offers.example.com', url: 'https://offers.example.com/promo', host: 'offers.example.com', available: false, reason: 'DNS is not verified yet (Domains page).', status: 'pending' as const, selected: false };

function view() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ToastProvider><GoLivePanel funnel={funnel} /></ToastProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  failNext = null;
  addresses = { options: [pages, custom], state: 'draft', funnelStatus: 'test', currentDomainId: null };
});

describe('GoLivePanel', () => {
  it('explains test vs live, shows the final URL of the chosen address and goes live on it', async () => {
    view();
    expect(await screen.findByText(/Test vs live/)).toBeInTheDocument();
    expect(await screen.findByTestId('final-url')).toHaveTextContent('https://fn-abc.pages.dev/promo');
    expect(screen.getByRole('radio', { name: /offers\.example\.com/ })).toBeDisabled();
    expect(screen.getByText('DNS is not verified yet (Domains page).')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Go live/ }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/funnels/fn_1/go-live', body: { address: { kind: 'pages' } } }]));
  });

  it('shows the limit message from the server and does not claim success', async () => {
    const { ApiError } = await import('../api/client');
    failNext = new ApiError(409, 'PAGES_PROJECT_LIMIT', 'This Cloudflare account already has 100 Pages projects, the maximum is 100.');
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Go live/ }));
    expect(await screen.findByText(/maximum is 100/)).toBeInTheDocument();
  });

  it('publishing, failed, live and paused states', async () => {
    addresses = { options: [{ ...pages, selected: true, status: 'pending' }], state: 'failed', funnelStatus: 'live', currentDomainId: 'dom_p' };
    const failed = view();
    expect(await screen.findByText('Publishing failed.', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    failed.unmount();
    addresses = { options: [{ ...pages, selected: true, status: 'active' }], state: 'live', funnelStatus: 'live', currentDomainId: 'dom_p' };
    view();
    expect(await screen.findByText('Your funnel is live at')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://fn-abc.pages.dev/promo');
    await userEvent.click(screen.getByRole('button', { name: /Take offline/ }));
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/api/funnels/fn_1', body: { status: 'test' } }]));
  });
});
