import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressOption, AddressOptions } from '../api/golive';
import type { FunnelDetail } from '../api/types';
import { ToastProvider } from '../ui';
import { PublishDialog } from './PublishDialog';

const calls: { method: string; path: string; body?: unknown }[] = [];
let addresses: AddressOptions;
let publishing: { lastError: string | null; latest: { error: string | null } | null };
let failPost: Error | null = null;
let perms = new Set(['funnels:write', 'publishing:manage']);

vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return {
    ...real,
    api: {
      get: async (path: string) => (path.endsWith('/addresses') ? addresses : path.endsWith('/publishing') ? publishing : null),
      post: async (path: string, body?: unknown) => {
        calls.push({ method: 'POST', path, body });
        if (failPost) throw failPost;
        return {};
      },
      patch: async (path: string, body?: unknown) => { calls.push({ method: 'PATCH', path, body }); return {}; },
    },
  };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => perms.has(p) }) }));

const funnel = { id: 'fn_1', name: 'Promo', status: 'test' } as FunnelDetail;
const builtin: AddressOption = { kind: 'builtin', domainId: 'dom_b', label: 'Built-in address (free)', url: 'https://app.test/s/acme/promo/free-guide', host: 'app.test', available: true, reason: null, status: 'active', selected: false };
const pages: AddressOption = { kind: 'pages', domainId: null, label: 'Cloudflare Pages address (free)', url: 'https://fn-abc.pages.dev/free-guide', host: 'fn-abc.pages.dev', available: true, reason: null, status: null, selected: false };
const noCf = { ...pages, url: null, host: null, available: false, reason: 'Connect a Cloudflare account first (Settings > Publishing).' };
const workers: AddressOption = { kind: 'workers', domainId: null, label: 'Cloudflare Workers address (free, experimental)', url: null, host: null, available: true, reason: null, status: null, selected: false };
const draft = (...options: AddressOption[]): AddressOptions => ({ options, state: 'draft', funnelStatus: 'test', currentDomainId: null });
const liveOn = (o: AddressOption, state: AddressOptions['state'] = 'live'): AddressOptions => ({ options: [{ ...o, selected: true }], state, funnelStatus: 'live', currentDomainId: o.domainId ?? 'dom_x' });

let save: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
function view(opts: { dirty?: boolean; saveState?: { kind: 'error'; message: string } | { kind: 'idle' } } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter><ToastProvider>
      <PublishDialog onClose={onClose as never} funnel={funnel} dirty={opts.dirty ?? false} save={save as never} saveState={opts.saveState ?? { kind: 'idle' }} onPreview={() => undefined} />
    </ToastProvider></MemoryRouter></QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  failPost = null;
  perms = new Set(['funnels:write', 'publishing:manage']);
  publishing = { lastError: null, latest: null };
  save = vi.fn(async () => true);
  onClose = vi.fn();
  addresses = draft(builtin, noCf);
});

describe('PublishDialog', () => {
  it('test mode: explains test vs live once, preselects the built-in address with its real URL and goes live in one step', async () => {
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(await within(dlg).findByText(/In test mode only people with your preview link/)).toBeInTheDocument();
    expect(dlg).not.toHaveTextContent(/connect a domain/i);
    expect(await within(dlg).findByRole('radio', { name: /Built-in address \(free\)/ })).toBeChecked();
    expect(within(dlg).getByTestId('final-url')).toHaveTextContent('https://app.test/s/acme/promo/free-guide');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/funnels/fn_1/go-live', body: { address: { kind: 'builtin', domainId: 'dom_b' } } }]));
    expect(await within(dlg).findByText('Your funnel is live.')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves unsaved changes first and holds Go live until the save worked; a failed save is explained and can be retried', async () => {
    let ok = false;
    save = vi.fn(async () => ok);
    view({ dirty: true, saveState: { kind: 'error', message: 'This page was changed in another tab' } });
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(await within(dlg).findByText(/This page was changed in another tab/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Nothing was published/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Go live' })).toBeDisabled();
    ok = true;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Go live' })).toBeEnabled());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith(true);
  });

  it('Cloudflare not connected: the option is disabled with the reason, a link to Settings and the permission to give', async () => {
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(await within(dlg).findByRole('radio', { name: /Cloudflare Pages address/ })).toBeDisabled();
    expect(within(dlg).getByText('Connect Cloudflare first.')).toBeInTheDocument();
    expect(within(dlg).getByText(/Cloudflare Pages: Edit/)).toBeInTheDocument();
    const link = within(dlg).getByRole('link', { name: /Settings, Publishing card/ });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(dlg).getByRole('radio', { name: /Built-in address/ })).toBeChecked();
  });

  it('connected Cloudflare: Pages is offered, the Workers address is marked experimental, and going live uses the chosen one', async () => {
    addresses = draft(builtin, pages, workers);
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(await within(dlg).findByText('Experimental')).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('radio', { name: /Cloudflare Pages address/ }));
    expect(within(dlg).getByTestId('final-url')).toHaveTextContent('https://fn-abc.pages.dev/free-guide');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(calls[0]).toEqual({ method: 'POST', path: '/api/funnels/fn_1/go-live', body: { address: { kind: 'pages' } } }));
    expect(await within(dlg).findByText(/Publishing to Cloudflare/)).toBeInTheDocument();
  });

  it('go live refused by the server: the message is shown and nothing claims success', async () => {
    const { ApiError } = await import('../api/client');
    failPost = new ApiError(409, 'PAGES_PROJECT_LIMIT', 'This Cloudflare account already has 100 Pages projects, the maximum is 100.');
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    await userEvent.click(await within(dlg).findByRole('button', { name: 'Go live' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/maximum is 100.*\(PAGES_PROJECT_LIMIT\)/);
    expect(within(dlg).queryByText('Your funnel is live.')).toBeNull();
    failPost = null;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(await within(dlg).findByText('Your funnel is live.')).toBeInTheDocument();
  });

  it('live on the built-in address: shows where it is served, Copy and Open, updates by saving, and takes it offline', async () => {
    addresses = liveOn(builtin);
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish changes' });
    expect(await within(dlg).findByText('Built-in address (free)', { selector: 'strong' })).toBeInTheDocument();
    expect(within(dlg).getByText('Your funnel is live at')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://app.test/s/acme/promo/free-guide');
    expect(within(dlg).getByRole('button', { name: /Copy link/ })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Update live page' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(true));
    expect(await within(dlg).findByText('Saved. The live page is updated.')).toBeInTheDocument();
    expect(calls).toEqual([]); // the built-in address serves the saved page, no redeploy
    await userEvent.click(within(dlg).getByRole('button', { name: 'Take offline' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/api/funnels/fn_1', body: { status: 'test' } }]));
    expect(await within(dlg).findByText('The funnel is offline again (test mode).')).toBeInTheDocument();
  });

  it('live on pages.dev: Update live page saves and then redeploys', async () => {
    addresses = liveOn(pages);
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish changes' });
    expect(await within(dlg).findByRole('link', { name: /Open/ })).toHaveAttribute('href', 'https://fn-abc.pages.dev/free-guide');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Update live page' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/funnels/fn_1/publishing/redeploy', body: undefined }]));
    expect(save).toHaveBeenCalledWith(true);
    expect(await within(dlg).findByText(/being updated on Cloudflare/)).toBeInTheDocument();
  });

  it('publishing: progress is announced and the actions wait', async () => {
    addresses = liveOn(pages, 'publishing');
    view();
    const dlg = await screen.findByRole('dialog', { name: /Publish/ });
    expect(await within(dlg).findByText(/Publishing to Cloudflare\. This updates by itself/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Publishing…' })).toBeDisabled();
  });

  it('publishing failed: shows the server message and Retry redeploys', async () => {
    addresses = liveOn(pages, 'failed');
    publishing = { lastError: 'Cloudflare rejected the upload: file too large', latest: null };
    view();
    const dlg = await screen.findByRole('dialog', { name: /Publish/ });
    expect(await within(dlg).findByText(/Cloudflare rejected the upload: file too large/)).toBeInTheDocument();
    expect(within(dlg).queryByTestId('final-url')).toBeNull();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/funnels/fn_1/publishing/redeploy', body: undefined }]));
    expect(within(dlg).getByRole('button', { name: 'Take offline' })).toBeInTheDocument();
  });

  it('loading and error states of the address list; the error can be retried', async () => {
    addresses = undefined as never;
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(within(dlg).getAllByRole('status').length).toBeGreaterThan(0);
    expect(await within(dlg).findByRole('alert')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('without permission to edit funnels there is no way to go live, and it says so', async () => {
    perms = new Set();
    view();
    const dlg = await screen.findByRole('dialog', { name: 'Publish' });
    expect(await within(dlg).findByText('Going live needs permission to edit funnels.')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Go live' })).toBeNull();
  });
});
