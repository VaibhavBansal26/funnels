import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client';
import type { FunnelDetail, Step } from './api/types';
import { AuthProvider } from './auth/AuthContext';
import { ConflictDialog } from './components/ConflictDialog';
import { ToastProvider, useToast } from './components/Toasts';
import { ErrorBanner, Modal } from './components/ui';
import { LoginPage } from './pages/AuthPages';
import { StepsTab } from './pages/StepsTab';

const wrap = (ui: React.ReactElement, path = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '*', element: <QueryClientProvider client={qc}><ToastProvider><AuthProvider>{ui}</AuthProvider></ToastProvider></QueryClientProvider> }], { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
};

afterEach(() => vi.unstubAllGlobals());

const stepRows = () => [...document.querySelectorAll<HTMLElement>('li.step-row')];

describe('step list: keyboard reordering', () => {
  const step = (i: number): Step => ({ id: `s${i}`, funnelId: 'f', name: `Step ${i}`, path: `/p${i}`, position: i, title: null, seoDescription: null, customCss: null, headerTrackingCode: null, footerTrackingCode: null, version: 1, isDomainHome: false, isDomain404: false, createdAt: '', updatedAt: '' });
  const funnel = { id: 'f', name: 'F', domain: null, steps: [step(1), step(2), step(3)] } as unknown as FunnelDetail;

  it('Alt+ArrowDown moves the focused step and sends the contiguous order; failures roll back', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    wrap(<StepsTab funnel={funnel} />);
    const rows = () => stepRows().map((li) => within(li).getByText(/^Step \d$/).textContent);
    expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']);
    const first = stepRows()[0]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(rows()).toEqual(['Step 2', 'Step 1', 'Step 3']));
    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/funnels/f/steps/order');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ orders: [{ stepId: 's2', order: 1 }, { stepId: 's1', order: 2 }, { stepId: 's3', order: 3 }] });
  });

  it('plain arrows do nothing, and a server error restores the original order with an alert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'INCOMPLETE_ORDER', message: 'The list must include every step' } }), { status: 400 })));
    wrap(<StepsTab funnel={funnel} />);
    const rows = () => stepRows().map((li) => within(li).getByText(/^Step \d$/).textContent);
    const first = stepRows()[0]!;
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']);
    await userEvent.click(screen.getByRole('button', { name: 'Move Step 1 down' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await waitFor(() => expect(rows()).toEqual(['Step 1', 'Step 2', 'Step 3']));
  });

  it('first step cannot move up and last cannot move down', () => {
    wrap(<StepsTab funnel={funnel} />);
    expect(screen.getByRole('button', { name: 'Move Step 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Step 3 down' })).toBeDisabled();
  });
});

describe('API error display', () => {
  it('shows message and code, offers retry', async () => {
    const retry = vi.fn();
    render(<ErrorBanner error={new ApiError(409, 'DOMAIN_NOT_ACTIVE', 'The domain is not verified yet')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The domain is not verified yet');
    expect(screen.getByRole('alert')).toHaveTextContent('DOMAIN_NOT_ACTIVE');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
  it('renders nothing without an error and a friendly text for network failures', () => {
    const { container, rerender } = render(<ErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ErrorBanner error={new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the server');
  });
  it('conflict dialog lists conflicts, validates replacements and submits them', async () => {
    const onConfirm = vi.fn();
    render(<ConflictDialog conflicts={[{ path: '/promo', resolved_path: '/promo-1001', conflictsWith: { funnelName: 'A', stepName: 'Landing' } }]} onConfirm={onConfirm} onCancel={() => undefined} />);
    expect(screen.getByText('A → Landing')).toBeInTheDocument();
    const input = screen.getByLabelText('New path for /promo');
    fireEvent.change(input, { target: { value: 'bad path' } });
    expect(screen.getByRole('alert')).toHaveTextContent('letters, digits');
    expect(screen.getByRole('button', { name: /Rename paths/ })).toBeDisabled();
    fireEvent.change(input, { target: { value: '/promo-2' } });
    await userEvent.click(screen.getByRole('button', { name: /Rename paths/ }));
    expect(onConfirm).toHaveBeenCalledWith([{ path: '/promo', resolved_path: '/promo-2' }]);
  });
});

describe('login form validation', () => {
  it('blocks submission and shows accessible field errors, then shows server errors', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } }), { status: 401 }));
    vi.stubGlobal('fetch', f);
    wrap(<LoginPage />, '/login');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(f).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ email: 'a@example.com', password: 'wrong-password' });
  });
});

describe('modal and toasts', () => {
  it('modal is labelled, focuses its first control, closes on Escape and traps Tab', async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit thing" onClose={onClose}><button>First</button><button>Last</button></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toHaveAccessibleName('Edit thing');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    screen.getByRole('button', { name: 'Last' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('toasts announce and can be dismissed', async () => {
    function Button() {
      const t = useToast();
      return <button onClick={() => t.push('Saved!', 'ok')}>go</button>;
    }
    render(<ToastProvider ttl={0}><Button /></ToastProvider>);
    await userEvent.click(screen.getByText('go'));
    expect(await screen.findByText('Saved!')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Saved!')).not.toBeInTheDocument());
  });
});
